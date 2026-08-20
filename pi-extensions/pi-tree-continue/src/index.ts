import { AgentSession, VERSION, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";

const PATCHED = Symbol.for("pi-tree-continue.agent-session-patched");
const ORIGINAL_BIND = Symbol.for("pi-tree-continue.original-bind-extension-core");
const STATE = Symbol.for("pi-tree-continue.state");
const PATCH_VERSION = 2;
export const TESTED_PI_VERSION = "0.84.2";

interface InternalAgentSession {
	agent: {
		continue(): Promise<void>;
		hasQueuedMessages(): boolean;
	};
	sessionManager: object;
	_modelRegistry?: { hasConfiguredAuth(model: unknown): boolean };
	_flushPendingBashMessages?: () => void;
	_handlePostAgentRun?: () => Promise<boolean>;
	_systemPromptOverride?: string | undefined;
}

interface ContinueOptions {
	force: boolean;
	help: boolean;
	error?: string;
}

interface ContinuationTargetResult {
	target?: SessionEntry;
	reason?: string;
}

interface TreeContinueState {
	sessions: WeakMap<object, InternalAgentSession>;
}

export function supportsTestedPiVersion(version = VERSION): boolean {
	return version === TESTED_PI_VERSION;
}

export default function treeContinueExtension(pi: ExtensionAPI) {
	if (!supportsTestedPiVersion()) {
		console.warn(
			`[pi-tree-continue] disabled: this private AgentSession hook supports Pi ${TESTED_PI_VERSION} only (found ${VERSION}).`,
		);
		return;
	}

	const patchInstalled = installAgentSessionPatch();

	pi.registerCommand("continue", {
		description: "Continue from the previous tool result without adding a message",
		handler: async (args, ctx) => {
			const options = parseArgs(args);

			if (options.help) {
				ctx.ui.notify("Usage: /continue [--force]", "info");
				return;
			}

			if (options.error) {
				ctx.ui.notify(options.error, "warning");
				return;
			}

			if (!patchInstalled) {
				ctx.ui.notify("/continue could not hook Pi internals for message-free continuation.", "error");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is already running; /continue works when Pi is idle.", "warning");
				return;
			}

			if (ctx.hasPendingMessages()) {
				ctx.ui.notify("There are queued messages already; let them drain before /continue.", "warning");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model is selected; choose a model before /continue.", "warning");
				return;
			}

			const session = getState().sessions.get(ctx.sessionManager as object);
			if (!session) {
				ctx.ui.notify("/continue could not find the active AgentSession.", "error");
				return;
			}

			if (session._modelRegistry && !session._modelRegistry.hasConfiguredAuth(ctx.model)) {
				ctx.ui.notify("The selected model is not authenticated; fix auth before /continue.", "warning");
				return;
			}

			const targetResult = findContinuationTarget(ctx.sessionManager.getBranch(), options);
			if (!targetResult.target) {
				ctx.ui.notify(targetResult.reason ?? "No previous tool result found to continue from.", "warning");
				return;
			}

			if (ctx.sessionManager.getLeafId() !== targetResult.target.id) {
				const result = await ctx.navigateTree(targetResult.target.id, { summarize: false });
				if (result.cancelled) {
					ctx.ui.notify("/continue was cancelled by a tree navigation hook.", "warning");
					return;
				}
			}

			try {
				await continueWithoutMessage(session);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`/continue failed: ${message}`, "error");
			}
		},
	});
}

function installAgentSessionPatch(): boolean {
	const proto = (AgentSession as unknown as { prototype?: Record<PropertyKey, unknown> }).prototype;
	if (!proto) return false;
	if (proto[PATCHED] === PATCH_VERSION) return true;

	const original = typeof proto[ORIGINAL_BIND] === "function" ? proto[ORIGINAL_BIND] : proto._bindExtensionCore;
	if (typeof original !== "function") return false;

	proto[ORIGINAL_BIND] = original;
	proto._bindExtensionCore = function patchedBindExtensionCore(this: InternalAgentSession, ...args: unknown[]) {
		const result = Reflect.apply(original, this, args);
		if (this.sessionManager && typeof this.sessionManager === "object") {
			getState().sessions.set(this.sessionManager, this);
		}
		return result;
	};
	proto[PATCHED] = PATCH_VERSION;
	return true;
}

function getState(): TreeContinueState {
	const root = globalThis as typeof globalThis & Record<symbol, unknown>;
	const existing = root[STATE] as TreeContinueState | undefined;
	if (existing) return existing;

	const state: TreeContinueState = { sessions: new WeakMap<object, InternalAgentSession>() };
	root[STATE] = state;
	return state;
}

function parseArgs(args: string): ContinueOptions {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	let force = false;

	for (const part of parts) {
		if (part === "--force") {
			force = true;
			continue;
		}
		if (part === "--help" || part === "-h") {
			return { force, help: true };
		}
		return { force, help: false, error: `Unknown /continue argument: ${part}` };
	}

	return { force, help: false };
}

function findContinuationTarget(branch: SessionEntry[], options: ContinueOptions): ContinuationTargetResult {
	if (branch.length === 0) return { reason: "No session entries found to continue from." };

	if (options.force) {
		const target = findLatestToolResult(branch);
		return target ? { target } : { reason: "No previous tool result found to continue from." };
	}

	const leaf = branch[branch.length - 1];
	if (isToolResultEntry(leaf)) return { target: leaf };

	const targetIndex = findLatestToolResultIndex(branch);
	if (targetIndex === -1) return { reason: "No previous tool result found to continue from." };

	const trailingEntries = branch.slice(targetIndex + 1);
	if (trailingEntries.length > 0 && trailingEntries.every(isIgnorableAfterToolResult)) {
		return { target: branch[targetIndex] };
	}

	return {
		reason:
			"Current branch does not end at a tool result or empty assistant error. Use /continue --force to abandon later entries.",
	};
}

function findLatestToolResult(branch: SessionEntry[]): SessionEntry | undefined {
	const index = findLatestToolResultIndex(branch);
	return index === -1 ? undefined : branch[index];
}

function findLatestToolResultIndex(branch: SessionEntry[]): number {
	for (let i = branch.length - 1; i >= 0; i--) {
		if (isToolResultEntry(branch[i])) return i;
	}
	return -1;
}

function isToolResultEntry(entry: SessionEntry | undefined): entry is SessionEntry & { type: "message" } {
	return entry?.type === "message" && entry.message.role === "toolResult";
}

function isIgnorableAfterToolResult(entry: SessionEntry): boolean {
	if (isEmptyAssistantError(entry)) return true;
	return (
		entry.type === "model_change" ||
		entry.type === "thinking_level_change" ||
		entry.type === "label" ||
		entry.type === "session_info"
	);
}

function isEmptyAssistantError(entry: SessionEntry | undefined): boolean {
	if (entry?.type !== "message") return false;
	const message = entry.message;
	if (message.role !== "assistant") return false;
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return false;
	return !hasMeaningfulAssistantContent(message.content);
}

function hasMeaningfulAssistantContent(content: unknown): boolean {
	if (!Array.isArray(content)) return false;

	return content.some((part) => {
		if (!part || typeof part !== "object") return false;
		const block = part as { type?: unknown; text?: unknown; thinking?: unknown };
		if (block.type === "toolCall") return true;
		if (block.type === "text" && typeof block.text === "string") return block.text.trim().length > 0;
		if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking.trim().length > 0;
		return false;
	});
}

async function continueWithoutMessage(session: InternalAgentSession): Promise<void> {
	if (typeof session.agent?.continue !== "function") {
		throw new Error("Pi Agent.continue() is not available");
	}
	if (typeof session._handlePostAgentRun !== "function") {
		throw new Error("Pi post-run continuation hook is not available");
	}

	try {
		session._flushPendingBashMessages?.();
		await session.agent.continue();
		while (await session._handlePostAgentRun()) {
			await session.agent.continue();
		}
	} finally {
		session._systemPromptOverride = undefined;
		session._flushPendingBashMessages?.();
	}
}
