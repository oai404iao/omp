import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue, Usage } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { CodeModeDirectBinding } from "./direct-binding.ts";
export { createCodeModeDirectBinding, type CodeModeDirectBinding, type DirectToolLease } from "./direct-binding.ts";

export const DISCOVER = "@oai404iao/pi-code-mode:discover/v1";
export const CHANGED = "@oai404iao/pi-code-mode:changed/v1";
export interface InvocationContext {
	readonly cellId: string;
	readonly toolCallId: string;
	readonly cwd: string;
	readonly signal: AbortSignal;
	/** Current session context, with the invocation's signal. Never retain it. */
	readonly pi?: ExtensionContext;
}
export interface ContributionResult {
	value: JsonValue;
	usage?: Usage;
}
/** Data-returning tools only. Pi terminate/addedToolNames controls are NOT
 * supported by this contract. Keep such tools direct; do not wrap them blindly. */
export interface CodeModeTool {
	name: string;
	description: string;
	parameters: TSchema;
	effect: "read" | "write" | "process";
	/** Only explicitly parallel read tools overlap; everything else is exclusive. */
	parallel?: boolean;
	/** Optional owner cooperation for hide-bridged. Never inferred by name. */
	direct?: CodeModeDirectBinding;
	prepare?(input: unknown): unknown;
	invoke(input: unknown, context: InvocationContext): Promise<ContributionResult>;
}
export interface CodeModeProvider { id: string; tools: readonly CodeModeTool[] }
export interface PolicyCall {
	readonly name: string;
	readonly effect: CodeModeTool["effect"];
	readonly input: unknown;
	readonly context: InvocationContext;
}
export interface CodeModePolicy {
	id: string;
	before?(call: PolicyCall): Promise<void | { block: true; reason?: string }> | void | { block: true; reason?: string };
	after?(call: PolicyCall, value: JsonValue): Promise<JsonValue> | JsonValue;
}
export interface Discovery {
	version: 1;
	provider(provider: CodeModeProvider): void;
	policy(policy: CodeModePolicy): void;
}
function discover(value: unknown): value is Discovery {
	const message = value as Partial<Discovery> | null;
	return Boolean(message?.version === 1 && typeof message.provider === "function" && typeof message.policy === "function");
}

/** Factory-time registration works before/after the main extension. The bus
 * carries snapshots, not process-global singleton state or private Pi APIs. */
export function registerCodeModeTools(pi: ExtensionAPI, initial: CodeModeProvider) {
	let provider = initial;
	let disposed = false;
	const off = pi.events.on(DISCOVER, (value) => { if (!disposed && discover(value)) value.provider(provider); });
	pi.events.emit(CHANGED, { version: 1 });
	return {
		refresh(tools: readonly CodeModeTool[]) {
			if (disposed) throw new Error("Code Mode provider registration disposed");
			provider = { id: initial.id, tools };
			pi.events.emit(CHANGED, { version: 1 });
		},
		dispose() { if (!disposed) { disposed = true; off(); pi.events.emit(CHANGED, { version: 1 }); } },
	};
}
export function registerCodeModePolicy(pi: ExtensionAPI, policy: CodeModePolicy) {
	let disposed = false;
	const off = pi.events.on(DISCOVER, (value) => { if (!disposed && discover(value)) value.policy(policy); });
	pi.events.emit(CHANGED, { version: 1 });
	return () => { if (!disposed) { disposed = true; off(); pi.events.emit(CHANGED, { version: 1 }); } };
}
