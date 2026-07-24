import { AgentSession } from "@earendil-works/pi-coding-agent";

export type TerminalMessageHandler = (message: unknown) => void;

interface InternalAgentSession {
	sessionManager: object;
	_lastAssistantMessage?: unknown;
	_handlePostAgentRun?: (...args: unknown[]) => Promise<boolean>;
}

interface ObserverState {
	handlers: WeakMap<object, TerminalMessageHandler>;
}

const PATCHED = Symbol.for("pi-telegram-notify.post-agent-run-patched");
const ORIGINAL_POST_AGENT_RUN = Symbol.for("pi-telegram-notify.original-post-agent-run");
const STATE = Symbol.for("pi-telegram-notify.terminal-observer-state");
const PATCH_VERSION = 1;

function observerState(): ObserverState {
	const root = globalThis as typeof globalThis & Record<symbol, unknown>;
	const existing = root[STATE] as ObserverState | undefined;
	if (existing) return existing;

	const state: ObserverState = { handlers: new WeakMap<object, TerminalMessageHandler>() };
	root[STATE] = state;
	return state;
}

/**
 * Pi's public agent_end event fires before Pi decides whether it will retry or
 * compact and continue. This small compatibility hook observes the result of
 * that decision so notifications are sent only when the task is truly idle.
 */
export function installTerminalObserver(): boolean {
	const proto = (AgentSession as unknown as { prototype?: Record<PropertyKey, unknown> }).prototype;
	if (!proto) return false;
	if (proto[PATCHED] === PATCH_VERSION) return true;

	const original = typeof proto[ORIGINAL_POST_AGENT_RUN] === "function" ? proto[ORIGINAL_POST_AGENT_RUN] : proto._handlePostAgentRun;
	if (typeof original !== "function") return false;

	proto[ORIGINAL_POST_AGENT_RUN] = original;
	proto._handlePostAgentRun = async function patchedPostAgentRun(this: InternalAgentSession, ...args: unknown[]) {
		const terminalMessage = this._lastAssistantMessage;
		const shouldContinue = await Reflect.apply(original, this, args);

		if (!shouldContinue && terminalMessage !== undefined && this.sessionManager && typeof this.sessionManager === "object") {
			try {
				observerState().handlers.get(this.sessionManager)?.(terminalMessage);
			} catch {
				// Notification observers must never affect Pi's post-run path.
			}
		}
		return shouldContinue;
	};
	proto[PATCHED] = PATCH_VERSION;
	return true;
}

export function bindTerminalObserver(sessionManager: object, handler: TerminalMessageHandler): void {
	observerState().handlers.set(sessionManager, handler);
}

export function unbindTerminalObserver(sessionManager: object): void {
	observerState().handlers.delete(sessionManager);
}
