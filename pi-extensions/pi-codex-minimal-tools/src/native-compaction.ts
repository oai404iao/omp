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
import { requestOpenAINativeCompaction } from "./provider-shim.js";
import {
	loadSettings,
	type CodexMinimalToolsSettings,
} from "./settings.js";

export const NATIVE_COMPACTION_DETAILS_KIND = "openai-native-compaction";
export const NATIVE_COMPACTION_DETAILS_VERSION = 1;

type NativeCompactionMode = Exclude<CodexMinimalToolsSettings["compactionMode"], "pi">;

export interface NativeCompactionDetails {
	kind: typeof NATIVE_COMPACTION_DETAILS_KIND;
	version: typeof NATIVE_COMPACTION_DETAILS_VERSION;
	mode: NativeCompactionMode;
	provider: string;
	model: string;
	api: string;
	output: unknown[];
	sourceEntryId?: string;
	sourceBlockIndex?: number;
}

interface NativeCompactionMarker {
	item: Record<string, unknown>;
	blockIndex: number;
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
		&& details.version === NATIVE_COMPACTION_DETAILS_VERSION
		&& (details.mode === "responses-context-management" || details.mode === "responses-compact")
		&& typeof details.provider === "string"
		&& typeof details.model === "string"
		&& typeof details.api === "string"
		&& Array.isArray(details.output);
}

function nativeItemFromSignature(signature: unknown): Record<string, unknown> | undefined {
	if (typeof signature !== "string" || !signature.startsWith("{")) return undefined;
	try {
		const item = asRecord(JSON.parse(signature));
		return item?.type === "compaction" || item?.type === "context_compaction" ? item : undefined;
	} catch {
		return undefined;
	}
}

function findMarker(message: unknown): NativeCompactionMarker | undefined {
	const candidate = asRecord(message);
	if (candidate?.role !== "assistant" || !Array.isArray(candidate.content)) return undefined;
	for (let index = candidate.content.length - 1; index >= 0; index--) {
		const block = asRecord(candidate.content[index]);
		const item = block?.type === "thinking" ? nativeItemFromSignature(block.thinkingSignature) : undefined;
		if (item) return { item, blockIndex: index };
	}
	return undefined;
}

function latestNativeCompactionEntry(entries: readonly SessionEntry[]): CompactionEntry<NativeCompactionDetails> | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "compaction" && isNativeCompactionDetails(entry.details)) {
			return entry as CompactionEntry<NativeCompactionDetails>;
		}
	}
	return undefined;
}

function latestMarkerEntry(entries: readonly SessionEntry[]): {
	entryId: string;
	marker: NativeCompactionMarker;
	provider: string;
	model: string;
	api: string;
} | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		const marker = findMarker(entry.message);
		const message = asRecord(entry.message);
		if (
			marker
			&& typeof message?.provider === "string"
			&& typeof message.model === "string"
			&& typeof message.api === "string"
		) {
			return {
				entryId: entry.id,
				marker,
				provider: message.provider,
				model: message.model,
				api: message.api,
			};
		}
	}
	return undefined;
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

function trimSourceAssistant(
	messages: PiMessages,
	sourceBlockIndex: number | undefined,
	includeMarker: boolean,
): PiMessages {
	if (messages.length === 0) return messages;
	const first = messages[0];
	if (first?.role !== "assistant") return messages;
	const marker = findMarker(first);
	const blockIndex = marker?.blockIndex ?? sourceBlockIndex;
	if (blockIndex === undefined) return messages;
	const start = includeMarker ? blockIndex : blockIndex + 1;
	const content = first.content.slice(start);
	return content.length > 0 ? [{ ...first, content }, ...messages.slice(1)] : messages.slice(1);
}

function messageTimestamp(message: PiMessage): number {
	return typeof message.timestamp === "number" ? message.timestamp : 0;
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
	mode: CodexMinimalToolsSettings["compactionMode"],
): PiMessages {
	if (!model || !isOpenAiGpt5Model(model as ModelLike)) return messages;

	const installed = latestNativeCompactionEntry(branchEntries);
	if (installed) {
		const details = installed.details;
		if (!isNativeCompactionDetails(details)) return messages;
		if (!matchesModelIdentity(details, model)) return messages;
		const withoutSummary = withoutCompactionSummary(messages);
		let tail: PiMessages;
		if (details.sourceEntryId) {
			tail = trimSourceAssistant(withoutSummary, details.sourceBlockIndex, false);
		} else {
			const installedAt = new Date(installed.timestamp).getTime();
			tail = withoutSummary.filter((message) => messageTimestamp(message) > installedAt);
		}
		return [
			syntheticNativeAssistant(details.output, model, new Date(installed.timestamp).getTime()),
			...tail,
		];
	}

	if (mode !== "responses-context-management") return messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const marker = findMarker(messages[index]);
		if (!marker) continue;
		const message = asRecord(messages[index]);
		if (
			message?.provider !== model.provider
			|| message.model !== model.id
			|| message.api !== model.api
		) continue;
		return trimSourceAssistant(messages.slice(index), marker.blockIndex, true);
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
	return mode === "responses-context-management"
		? "OpenAI Responses context management compacted the earlier conversation. The opaque encrypted compaction state is preserved in this session by pi-codex-minimal-tools."
		: "OpenAI Responses /responses/compact replaced the earlier conversation. The opaque encrypted compaction state is preserved in this session by pi-codex-minimal-tools.";
}

async function buildNativeCompactionContext(
	pi: ExtensionAPI,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	model: Model<Api>,
	settings: CodexMinimalToolsSettings,
): Promise<Context> {
	const session = buildSessionContext(event.branchEntries, ctx.sessionManager.getLeafId());
	return {
		systemPrompt: ctx.getSystemPrompt(),
		messages: applyNativeCompactionContext(
			session.messages,
			event.branchEntries,
			model,
			settings.compactionMode,
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
			settings.compactionMode,
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

			if (mode === "responses-context-management") {
				const captured = latestMarkerEntry(event.branchEntries);
				if (captured) {
					return {
						compaction: {
							summary: compactionSummary(mode),
							firstKeptEntryId: captured.entryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {
								kind: NATIVE_COMPACTION_DETAILS_KIND,
								version: NATIVE_COMPACTION_DETAILS_VERSION,
								mode,
								provider: captured.provider,
								model: captured.model,
								api: captured.api,
								output: [captured.marker.item],
								sourceEntryId: captured.entryId,
								sourceBlockIndex: captured.marker.blockIndex,
							} satisfies NativeCompactionDetails,
						},
					};
				}
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				throw new Error(auth.ok ? "OpenAI API key is unavailable" : auth.error);
			}
			const context = await buildNativeCompactionContext(pi, event, ctx, model, settings);
			const output = await requestOpenAINativeCompaction(model, context, {
				mode,
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: event.signal,
				reasoning: pi.getThinkingLevel() as ThinkingLevel,
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
