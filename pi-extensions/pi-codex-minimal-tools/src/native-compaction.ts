import type {
	CompactionEntry,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Context, Model, ThinkingLevel, Tool } from "@earendil-works/pi-ai";
import { isOpenAiGpt5Model, type ModelLike } from "./capabilities.js";
import {
	requestOpenAINativeCompaction,
	sanitizeNativeCompactionOutput,
} from "./provider-shim.js";
import {
	loadSettings,
	type CodexMinimalToolsSettings,
} from "./settings.js";

export const NATIVE_COMPACTION_DETAILS_KIND = "openai-native-compaction";
export const NATIVE_COMPACTION_DETAILS_VERSION = 2;

export type NativeCompactionMode = Exclude<CodexMinimalToolsSettings["compactionMode"], "pi">;
type StoredNativeCompactionMode = NativeCompactionMode | "responses-context-management";

export interface NativeCompactionDetails {
	kind: typeof NATIVE_COMPACTION_DETAILS_KIND;
	version: 1 | typeof NATIVE_COMPACTION_DETAILS_VERSION;
	mode: StoredNativeCompactionMode;
	provider: string;
	model: string;
	api: string;
	output: unknown[];
	/** Legacy context-management checkpoint source. New Responses compactions omit this. */
	sourceEntryId?: string;
	/** Legacy context-management checkpoint block. New Responses compactions omit this. */
	sourceBlockIndex?: number;
}

interface IndexedNativeCompactionEntry {
	entry: CompactionEntry<NativeCompactionDetails>;
	index: number;
}

type PiMessage = SessionContext["messages"][number];
type PiMessages = SessionContext["messages"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

export function isNativeCompactionDetails(value: unknown): value is NativeCompactionDetails {
	const details = asRecord(value);
	return details?.kind === NATIVE_COMPACTION_DETAILS_KIND
		&& (details.version === 1 || details.version === NATIVE_COMPACTION_DETAILS_VERSION)
		&& (
			details.mode === "responses"
			|| details.mode === "responses-compact"
			|| (details.version === 1 && details.mode === "responses-context-management")
		)
		&& typeof details.provider === "string"
		&& typeof details.model === "string"
		&& typeof details.api === "string"
		&& Array.isArray(details.output);
}

function normalizedNativeCompactionMode(details: NativeCompactionDetails): NativeCompactionMode {
	return details.mode === "responses-context-management" ? "responses" : details.mode;
}

function isNativeCompactionSignature(signature: unknown): boolean {
	if (typeof signature !== "string" || !signature.startsWith("{")) return false;
	try {
		const item = asRecord(JSON.parse(signature));
		return item?.type === "compaction" || item?.type === "context_compaction";
	} catch {
		return false;
	}
}

function findLegacyMarkerBlockIndex(message: unknown): number | undefined {
	const candidate = asRecord(message);
	if (candidate?.role !== "assistant" || !Array.isArray(candidate.content)) return undefined;
	for (let index = candidate.content.length - 1; index >= 0; index--) {
		const block = asRecord(candidate.content[index]);
		if (block?.type === "thinking" && isNativeCompactionSignature(block.thinkingSignature)) {
			return index;
		}
	}
	return undefined;
}

function latestCompactionIndex(entries: readonly SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index]?.type === "compaction") return index;
	}
	return -1;
}

function latestNativeCompactionEntry(entries: readonly SessionEntry[]): IndexedNativeCompactionEntry | undefined {
	const index = latestCompactionIndex(entries);
	if (index < 0) return undefined;
	const entry = entries[index];
	if (entry?.type !== "compaction" || !isNativeCompactionDetails(entry.details)) return undefined;
	return {
		entry: entry as CompactionEntry<NativeCompactionDetails>,
		index,
	};
}

function matchesModelIdentity(
	value: { provider: string; model: string; api: string },
	model: Model<Api>,
): boolean {
	return value.provider === model.provider && value.model === model.id && value.api === model.api;
}

function syntheticNativeAssistant(
	output: readonly unknown[],
	model: Model<Api>,
	timestamp: number,
): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: output.map((item) => ({
			type: "thinking",
			thinking: "",
			thinkingSignature: JSON.stringify(item),
			redacted: true,
		})) as AssistantMessage["content"],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function withoutCompactionSummary(messages: PiMessages): PiMessages {
	return messages.filter((message) => message.role !== "compactionSummary");
}

function legacyTailAfterContextManagementMarker(
	messages: PiMessages,
	sourceBlockIndex: number | undefined,
): PiMessages {
	if (messages.length === 0) return messages;
	const first = messages[0];
	if (first?.role !== "assistant") return messages;
	const blockIndex = findLegacyMarkerBlockIndex(first) ?? sourceBlockIndex;
	if (blockIndex === undefined) return messages;
	const prefix = first.content.slice(0, blockIndex);
	const suffix = first.content.slice(blockIndex + 1);
	const resultIds = new Set(
		messages
			.filter((message): message is Extract<PiMessage, { role: "toolResult" }> => message.role === "toolResult")
			.map((message) => message.toolCallId),
	);
	const recoverTerminalMarker = suffix.length === 0 && prefix.some(
		(block) => block.type === "toolCall" && resultIds.has(block.id),
	);
	if (recoverTerminalMarker) {
		// Older versions appended a compaction discovered only in
		// response.completed after already-streamed output, even when its
		// authoritative output_index was first. Rotate that terminal marker back
		// in front so the call arguments and matching results survive replay.
		return prefix.length > 0 ? [{ ...first, content: prefix }, ...messages.slice(1)] : messages.slice(1);
	}
	return suffix.length > 0 ? [{ ...first, content: suffix }, ...messages.slice(1)] : messages.slice(1);
}

function messageTimestamp(message: PiMessage): number {
	return typeof message.timestamp === "number" ? message.timestamp : 0;
}

function messagesAfterEntry(entries: readonly SessionEntry[], entryIndex: number): PiMessages {
	const suffix = entries.slice(entryIndex + 1);
	if (suffix.length === 0) return [];
	return buildSessionContext(
		suffix as SessionEntry[],
		suffix[suffix.length - 1]?.id,
	).messages;
}

/**
 * Responses requires every function/custom-tool output to have a matching call.
 * Compaction can expose malformed local history if a boundary lands inside a
 * tool turn, so rebuild tool turns atomically: drop orphan/duplicate results and
 * synthesize an aborted output for a surviving call with no result.
 */
export function normalizeNativeCompactionToolPairs(messages: PiMessages): PiMessages {
	const resultByCallId = new Map<string, Extract<PiMessage, { role: "toolResult" }>>();
	for (const message of messages) {
		if (message.role === "toolResult" && !resultByCallId.has(message.toolCallId)) {
			resultByCallId.set(message.toolCallId, message);
		}
	}

	let changed = false;
	const normalized: PiMessage[] = [];
	const retainedResults = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			changed = true;
			continue;
		}
		normalized.push(message);
		if (message.role !== "assistant") continue;

		for (const block of message.content) {
			if (block.type !== "toolCall" || retainedResults.has(block.id)) continue;
			retainedResults.add(block.id);
			const existing = resultByCallId.get(block.id);
			if (existing) {
				normalized.push(existing);
				continue;
			}
			changed = true;
			normalized.push({
				role: "toolResult",
				toolCallId: block.id,
				toolName: block.name,
				content: [{ type: "text", text: "aborted" }],
				isError: true,
				timestamp: messageTimestamp(message),
			} as PiMessage);
		}
	}

	if (retainedResults.size !== resultByCallId.size) changed = true;
	return changed ? normalized : messages;
}

/**
 * Replace Pi's textual compaction summary with the opaque native Responses
 * items saved in CompactionEntry.details. The opaque payload is replayed only
 * to the same openai/GPT-5 model family.
 */
export function applyNativeCompactionContext(
	messages: PiMessages,
	branchEntries: readonly SessionEntry[],
	model: Model<Api> | undefined,
): PiMessages {
	if (!model || !isOpenAiGpt5Model(model as ModelLike)) return messages;

	const installed = latestNativeCompactionEntry(branchEntries);
	if (installed) {
		const details = installed.entry.details;
		if (!isNativeCompactionDetails(details)) return messages;
		if (!matchesModelIdentity(details, model)) return messages;
		const output = normalizedNativeCompactionMode(details) === "responses-compact"
			? sanitizeNativeCompactionOutput(details.output)
			: details.output;
		const withoutSummary = withoutCompactionSummary(messages);
		let tail: PiMessages;
		if (details.sourceEntryId) {
			tail = legacyTailAfterContextManagementMarker(withoutSummary, details.sourceBlockIndex);
		} else {
			// The compaction entry is the semantic history boundary. Timestamps are
			// not safe here because messages queued while compaction is running can
			// be appended after the entry with an earlier creation timestamp.
			tail = messagesAfterEntry(branchEntries, installed.index);
		}
		return normalizeNativeCompactionToolPairs([
			syntheticNativeAssistant(output, model, new Date(installed.entry.timestamp).getTime()),
			...tail,
		]);
	}
	return messages;
}

function activeTools(pi: ExtensionAPI): Tool[] {
	const active = new Set(pi.getActiveTools());
	return pi.getAllTools()
		.filter((tool) => active.has(tool.name))
		.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		})) as Tool[];
}

function compactionSummary(mode: NativeCompactionMode): string {
	return mode === "responses"
		? "OpenAI Responses compaction replaced the earlier conversation. The opaque encrypted compaction state is preserved in this session by pi-codex-minimal-tools."
		: "OpenAI Responses /responses/compact replaced the earlier conversation. The opaque encrypted compaction state is preserved in this session by pi-codex-minimal-tools.";
}

async function buildNativeCompactionContext(
	pi: ExtensionAPI,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	model: Model<Api>,
): Promise<Context> {
	const session = buildSessionContext(event.branchEntries, ctx.sessionManager.getLeafId());
	return {
		systemPrompt: ctx.getSystemPrompt(),
		messages: applyNativeCompactionContext(
			session.messages,
			event.branchEntries,
			model,
		) as Context["messages"],
		tools: activeTools(pi),
	};
}

export function registerNativeCompaction(pi: ExtensionAPI): void {
	pi.on("context", (event, ctx) => {
		const settings = loadSettings(ctx.cwd);
		if (settings.compactionMode === "pi") return undefined;
		const messages = applyNativeCompactionContext(
			event.messages as PiMessages,
			ctx.sessionManager.getBranch(),
			ctx.model as Model<Api> | undefined,
		);
		return messages === event.messages ? undefined : { messages: messages as typeof event.messages };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const settings = loadSettings(ctx.cwd);
		const mode = settings.compactionMode;
		const model = ctx.model as Model<Api> | undefined;
		if (mode === "pi" || !model || !isOpenAiGpt5Model(model as ModelLike)) return undefined;

		try {
			if (settings.requestProfile.responsesMode === "lite") {
				throw new Error("native compaction requires the Standard Responses request profile");
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				throw new Error(auth.ok ? "OpenAI API key is unavailable" : auth.error);
			}
			const context = await buildNativeCompactionContext(pi, event, ctx, model);
			const output = await requestOpenAINativeCompaction(model, context, {
				mode,
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: event.signal,
				reasoning: pi.getThinkingLevel() as ThinkingLevel,
				sessionId: ctx.sessionManager.getSessionId(),
				settings,
			});
			return {
				compaction: {
					summary: compactionSummary(mode),
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {
						kind: NATIVE_COMPACTION_DETAILS_KIND,
						version: NATIVE_COMPACTION_DETAILS_VERSION,
						mode,
						provider: model.provider,
						model: model.id,
						api: model.api,
						output,
					} satisfies NativeCompactionDetails,
				},
			};
		} catch (error) {
			if (!event.signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`OpenAI native compaction failed; falling back to Pi compaction: ${message}`, "warning");
			}
			return undefined;
		}
	});
}
