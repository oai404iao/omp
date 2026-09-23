import { AgentSession, VERSION, type BuildSystemPromptOptions, type ExtensionAPI, type SessionContext } from "@earendil-works/pi-coding-agent";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { continuationContext, findContinuationTarget, sameContinuationContext } from "./target.js";

const PATCHED = Symbol.for("pi-tree-continue.agent-session-patched");
const ORIGINAL_BIND = Symbol.for("pi-tree-continue.original-bind-extension-core");
const STATE = Symbol.for("pi-tree-continue.state");
const PATCH_VERSION = 3;
export const TESTED_PI_VERSIONS = ["0.87.0", "0.87.1"] as const;

interface InternalAgentSession {
	agent: { state: { messages: SessionContext["messages"] } };
	sessionManager: object;
	modelRuntime?: { hasConfiguredAuth(providerId: string): boolean };
	_flushPendingBashMessages?: () => void;
	_preparePromptAndToolLoadout?: (options: BuildSystemPromptOptions, messages?: SessionContext["messages"]) => SystemMessage | undefined;
	_runAgentPrompt?: (messages: SessionContext["messages"]) => Promise<void>;
	_emitAgentSettled?: () => Promise<void>;
	_runSystemPromptOptions?: BuildSystemPromptOptions;
}

interface ContinueOptions {
	force: boolean;
	help: boolean;
	error?: string;
}

interface TreeContinueState {
	sessions: WeakMap<object, InternalAgentSession>;
}

export function supportsTestedPiVersion(version = VERSION): boolean {
	return TESTED_PI_VERSIONS.some((tested) => tested === version);
}

export default function treeContinueExtension(pi: ExtensionAPI) {
	if (!supportsTestedPiVersion()) {
		console.warn(
			`[pi-tree-continue] disabled: this private AgentSession hook supports Pi ${TESTED_PI_VERSIONS.join(", ")} only (found ${VERSION}).`,
		);
		return;
	}

	const patchInstalled = installAgentSessionPatch();

	pi.registerCommand("continue", {
		description: "Continue from the previous tool result without adding a user message",
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

			const hasConfiguredAuth = session.modelRuntime?.hasConfiguredAuth(ctx.model.provider) ?? true;
			if (!hasConfiguredAuth) {
				ctx.ui.notify("The selected model is not authenticated; fix auth before /continue.", "warning");
				return;
			}

			const targetResult = findContinuationTarget(ctx.sessionManager.getBranch(), options.force);
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
				const currentContext = () => {
					const context = continuationContext(ctx.sessionManager.getBranch());
					if (!ctx.isIdle() || ctx.hasPendingMessages()
						|| !sameContinuationContext(context, targetResult.context!)) {
						throw new Error("Session changed while preparing continuation; retry /continue.");
					}
					return context.map(({ message }) => message);
				};
				await continueWithoutMessage(session, ctx.getSystemPromptOptions(), currentContext);
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

async function continueWithoutMessage(
	session: InternalAgentSession, options: BuildSystemPromptOptions,
	currentContext: () => SessionContext["messages"],
): Promise<void> {
	if (typeof session._preparePromptAndToolLoadout !== "function" || typeof session._runAgentPrompt !== "function" || typeof session._emitAgentSettled !== "function") {
		throw new Error("Pi prompt preparation/run hooks are not available");
	}
	session._flushPendingBashMessages?.();
	const messages = currentContext();
	const prepare = session._preparePromptAndToolLoadout;
	const settled = session._emitAgentSettled;
	// There is no new user turn to recompute before_agent_start sections for.
	// Keep the transcript's prompt, including deletions, throughout tool/retry
	// continuations. Pi still updates executable tools and declares their deltas.
	const prepareContinuation = (nextOptions: BuildSystemPromptOptions, messages = session.agent.state.messages) => {
		const current = getCurrentSystemMessage(messages);
		const update = prepare.call(session, nextOptions, messages);
		return current ? undefined : update;
	};
	const emitSettled = async () => {
		// Settled handlers may start a new user turn once Pi marks itself idle.
		restore();
		await settled.call(session);
	};
	const restore = () => {
		if (session._preparePromptAndToolLoadout === prepareContinuation) session._preparePromptAndToolLoadout = prepare;
		if (session._emitAgentSettled === emitSettled) session._emitAgentSettled = settled;
	};
	session._preparePromptAndToolLoadout = prepareContinuation;
	session._emitAgentSettled = emitSettled;
	try {
		const update = session._preparePromptAndToolLoadout(options, messages);
		session._runSystemPromptOptions = options;
		// An empty/system-only prompt adds no user message. Pi owns abort reset,
		// retries, compaction, prompt cleanup and agent_settled.
		await session._runAgentPrompt(update ? [update] : []);
	} finally {
		restore();
	}
}
