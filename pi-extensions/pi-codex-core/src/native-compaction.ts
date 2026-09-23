import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Api, AssistantMessage, Context, Model, ThinkingLevel, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type {
	CompactionEntry,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeNativeCompactionOutput } from "./adapter/compaction/checkpoint.js";
import { requestOpenAINativeCompaction } from "./adapter/compaction/request.js";
import { normalizeNativeCompactionToolPairs } from "./adapter/compaction/tool-pairs.js";
export { normalizeNativeCompactionToolPairs } from "./adapter/compaction/tool-pairs.js";
import { trackCompactionPrompt } from "./extension/compaction-prompt.js";
import type { ModelLike } from "@oai404iao/pi-codex-runtime/internal/capabilities";
import { hasCodexRequestAuth } from "@oai404iao/pi-codex-runtime/internal/codex-http";
import { resolveModelProfile } from "@oai404iao/pi-codex-runtime/internal/model-catalog/catalog";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import type { OpenAIResponsesProviderController } from "@oai404iao/pi-codex-runtime/internal/providers/openai-codex/types";
import {
	type CodexMinimalToolsSettings,
} from "@oai404iao/pi-codex-runtime/internal/settings";

export const NATIVE_COMPACTION_DETAILS_KIND = "openai-native-compaction";
export const NATIVE_COMPACTION_DETAILS_VERSION = 4;

export type NativeCompactionMode = Exclude<CodexMinimalToolsSettings["compactionMode"], "pi">;
type StoredNativeCompactionMode = NativeCompactionMode | "responses-context-management";

export interface NativeCompactionDetails {
	kind: typeof NATIVE_COMPACTION_DETAILS_KIND;
	version: 1 | 2 | 3 | typeof NATIVE_COMPACTION_DETAILS_VERSION;
	checkpointId?: string;
	mode: StoredNativeCompactionMode;
	provider: string;
	model: string;
	api: string;
	profileHash?: string;
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
		&& (details.version === 1 || details.version === 2 || details.version === 3 || details.version === NATIVE_COMPACTION_DETAILS_VERSION)
		&& (details.version !== 4 || typeof details.checkpointId === "string")
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
	value: { provider: string; model: string; api: string; profileHash?: string },
	model: Model<Api>,
): boolean {
	if (value.provider !== model.provider || value.model !== model.id || value.api !== model.api) return false;
	if (!value.profileHash) return true;
	return resolveModelProfile(model as ModelLike)?.profileHash === value.profileHash;
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

function messagesAfterEntry(entries: readonly SessionEntry[], entryIndex: number): PiMessages {
	const suffix = entries.slice(entryIndex + 1);
	if (suffix.length === 0) return [];
	return buildSessionContext(
		suffix as SessionEntry[],
		suffix[suffix.length - 1]?.id,
	).messages;
}

/**
 * Replace Pi's textual compaction summary with the opaque native Responses
 * items saved in CompactionEntry.details. The opaque payload is replayed only
 * to the same provider, model, API, and current model-profile hash.
 */
export function applyNativeCompactionContext(
	messages: PiMessages,
	branchEntries: readonly SessionEntry[],
	model: Model<Api> | undefined,
	conversationOnly = false,
): PiMessages {
	const installed = latestNativeCompactionEntry(branchEntries);
	if (installed?.entry.details?.version === 4
		&& messages.some((message) => message.role === "compactionSummary" && message.summary === installed.entry.summary)
		&& (!model || !resolveModelProfile(model as ModelLike)?.effective.enabled || !matchesModelIdentity(installed.entry.details, model))) {
		throw new Error("Native checkpoint requires its original model and profile. Restore them or navigate before compaction; its placeholder is not a text summary.");
	}
	if (!model || !resolveModelProfile(model as ModelLike)?.effective.enabled) return messages;
	if (installed) {
		const details = installed.entry.details;
		if (!isNativeCompactionDetails(details)) return messages;
		if (!matchesModelIdentity(details, model)) return messages;
		const output = normalizedNativeCompactionMode(details) === "responses-compact"
			? sanitizeNativeCompactionOutput(details.output)
			: details.output;
		if (details.version === 4) {
			if (installed.entry.firstKeptEntryId !== installed.entry.id) {
				throw new Error("Native compaction requires a retain-none checkpoint");
			}
			const markers = messages.filter((message) => message.role === "compactionSummary"
				&& message.summary === installed.entry.summary
				&& message.summary.includes(`[native-checkpoint:${details.checkpointId}]`));
			if (markers.length !== 1) return messages;
			return messages.map((message) => message === markers[0]
				? syntheticNativeAssistant(output, model, new Date(installed.entry.timestamp).getTime())
				: message);
		}
		if (conversationOnly) {
			const canonical = buildSessionContext([...branchEntries]).messages.filter((message) => message.role !== "system");
			if (!isDeepStrictEqual(messages, canonical)) {
				throw new Error("Legacy native checkpoint cannot compose with context transforms. Run /compact on its original model to migrate it before continuing.");
			}
		}
		const system = conversationOnly ? undefined : getCurrentSystemMessage(messages);
		const withoutSummary = withoutCompactionSummary(messages).filter((message) => message.role !== "system");
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
			...(system ? [system] : []),
			syntheticNativeAssistant(output, model, new Date(installed.entry.timestamp).getTime()),
			...tail.filter((message) => message.role !== "system"),
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
	forcedPrompt?: string,
): Promise<Context> {
	const session = buildSessionContext(event.branchEntries, ctx.sessionManager.getLeafId());
	return {
		systemPrompt: forcedPrompt ?? (getCurrentSystemMessage(session.messages) ? getCurrentSystemPrompt(session.messages) : ctx.getSystemPrompt()),
		messages: applyNativeCompactionContext(
			session.messages,
			event.branchEntries,
			model,
		).filter((message) => message.role !== "system") as Context["messages"],
		tools: activeTools(pi),
	};
}

export function registerNativeCompaction(
	pi: ExtensionAPI,
	providerController?: OpenAIResponsesProviderController,
): void {
	const forcedPrompt = trackCompactionPrompt(pi);
	pi.on("context", (event, ctx) => {
		const settings = loadModelSettings(ctx.model as ModelLike | undefined, ctx.cwd);
		const branch = ctx.sessionManager.getBranch();
		const retainNone = latestNativeCompactionEntry(branch)?.entry.details?.version === 4;
		if (!retainNone && (!settings.enabled || settings.compactionMode === "pi")) return undefined;
		try {
			if (retainNone && !settings.enabled) throw new Error("Native checkpoint replay is disabled. Re-enable its original model/profile or navigate before compaction.");
			const messages = applyNativeCompactionContext(
				event.messages as PiMessages, branch, ctx.model as Model<Api> | undefined, true,
			);
			return messages === event.messages ? undefined : { messages: messages as typeof event.messages };
		} catch (error) {
			// Context-handler exceptions alone are swallowed by Pi; explicitly abort
			// rather than replay filtered data or silently lose opaque history.
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			ctx.abort();
			return { messages: [] };
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model as Model<Api> | undefined;
		const settings = loadModelSettings(model as ModelLike | undefined, ctx.cwd);
		const mode = settings.compactionMode;
		const nativeCheckpoint = latestNativeCompactionEntry(event.branchEntries);
		if (!settings.enabled || mode === "pi" || !model || !settings.modelProfile?.effective.enabled) {
			if (!nativeCheckpoint) return undefined;
			ctx.ui.notify("Cannot replace an opaque native checkpoint with a placeholder summary. Restore its original model/profile and native compaction, or navigate before compaction.", "warning");
			return { cancel: true };
		}
		const leafId = ctx.sessionManager.getLeafId();
		try {
			if (event.branchEntries.at(-1)?.id !== leafId) return { cancel: true };
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (
				!auth.ok
				|| !hasCodexRequestAuth({
					modelHeaders: model.headers,
					auth: { apiKey: auth.apiKey, headers: auth.headers },
				})
			) {
				throw new Error(auth.ok ? "OpenAI request authentication is unavailable" : auth.error);
			}
			const sessionId = ctx.sessionManager.getSessionId();
			const context = await buildNativeCompactionContext(pi, event, ctx, model, forcedPrompt());
			const output = await requestOpenAINativeCompaction(model, context, {
				ownsNativeTool: providerController?.ownsNativeTool,
				mode,
				apiKey: auth.apiKey ?? "",
				headers: auth.headers,
				signal: event.signal,
				reasoning: pi.getThinkingLevel() as ThinkingLevel,
				sessionId,
				turnId: providerController?.getCurrentTurnId(sessionId),
				settings,
			});
			if (ctx.sessionManager.getLeafId() !== leafId) {
				ctx.ui.notify("Native compaction cancelled: session changed while compacting. Retry /compact.", "warning");
				return { cancel: true };
			}
			const checkpointId = randomUUID();
			return {
				compaction: {
					summary: `${compactionSummary(mode)}\n[native-checkpoint:${checkpointId}]`,
					// Pi 0.87 appendCompaction supports null (retain-none); the
					// CompactionResult declaration still incorrectly requires string.
					firstKeptEntryId: null as unknown as string,
					tokensBefore: event.preparation.tokensBefore,
					details: {
						kind: NATIVE_COMPACTION_DETAILS_KIND,
						version: NATIVE_COMPACTION_DETAILS_VERSION,
						checkpointId,
						mode,
						provider: model.provider,
						model: model.id,
						api: model.api,
						profileHash: settings.modelProfileHash,
						output,
					} satisfies NativeCompactionDetails,
				},
			};
		} catch (error) {
			if (event.signal.aborted || ctx.sessionManager.getLeafId() !== leafId) return { cancel: true };
			if (!event.signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`OpenAI native compaction failed; ${nativeCheckpoint ? "preserving the existing checkpoint" : "falling back to Pi compaction"}: ${message}`, "warning");
			}
			return nativeCheckpoint ? { cancel: true } : undefined;
		}
	});
}
