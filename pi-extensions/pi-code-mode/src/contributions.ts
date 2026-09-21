import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue, Usage } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { CodeModeDirectBinding } from "./direct-binding.ts";
import { randomUUID } from "node:crypto";
import { APPROVAL_FEATURE, DISCOVER_V2, discoveryV2, hasReceipt, type ConsumerHello, type DiscoveryReceipt, type Registration } from "./discovery.ts";
export { DISCOVER_V2, type ConsumerHello, type Registration, type DiscoveryV2 } from "./discovery.ts";
export { createCodeModeDirectBinding, type CodeModeDirectBinding, type DirectToolLease } from "./direct-binding.ts";

export const DISCOVER = "@oai404iao/pi-code-mode:discover/v1";
export const CHANGED = "@oai404iao/pi-code-mode:changed/v1";
export const OBSERVERS = "@oai404iao/pi-code-mode:observers/v1";
export const APPROVALS = "@oai404iao/pi-code-mode:approvals/v1";
export interface InvocationContext {
	readonly cellId: string;
	readonly toolCallId: string;
	readonly cwd: string;
	readonly signal: AbortSignal;
	readonly originToolCallId?: string;
	readonly epoch?: number;
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
	/** Optional display contract, not inferred from results or a replacement validator. */
	outputSchema?: TSchema;
	effect: "read" | "write" | "process";
	/** Only explicitly parallel read tools overlap; everything else is exclusive. */
	parallel?: boolean;
	/** Explicit approval provider ID. Missing provider/denial fails closed. */
	approval?: string;
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
	/** Requires approval for every call covered by this policy. */
	approval?: string;
	before?(call: PolicyCall): Promise<void | { block: true; reason?: string }> | void | { block: true; reason?: string };
	after?(call: PolicyCall, value: JsonValue): Promise<JsonValue> | JsonValue;
}
export interface CompletionReceipt {
	readonly cellId: string; readonly toolCallId: string; readonly name: string;
	readonly originToolCallId?: string; readonly epoch?: number;
	readonly state: "completed" | "failed" | "cancelled";
	readonly queuedAt: number; readonly startedAt?: number; readonly settledAt: number;
}
/** Diagnostics only: no parameters/results, no mutation or independent effects. */
export interface CodeModeObserver { id: string; complete(receipt: CompletionReceipt, signal: AbortSignal): void | Promise<void> }
export interface CodeModeApproval { id: string; approve(call: PolicyCall): boolean | Promise<boolean> }
export function registerCodeModeApproval(pi: ExtensionAPI, approval: CodeModeApproval) {
	let disposed = false;
	const off = pi.events.on(APPROVALS, (value) => {
		const request = value as { version?: number; accept?: (approval: CodeModeApproval) => void } | undefined;
		if (!disposed && request?.version === 1 && typeof request.accept === "function") request.accept(approval);
	});
	pi.events.emit(CHANGED, { version: 1 });
	return () => { if (!disposed) { disposed = true; off(); pi.events.emit(CHANGED, { version: 1 }); } };
}
export function registerCodeModeObserver(pi: ExtensionAPI, observer: CodeModeObserver) {
	let disposed = false;
	const off = pi.events.on(OBSERVERS, (value) => {
		const request = value as { version?: number; accept?: (observer: CodeModeObserver) => void } | undefined;
		if (!disposed && request?.version === 1 && typeof request.accept === "function") request.accept(observer);
	});
	pi.events.emit(CHANGED, { version: 1 });
	return () => { if (!disposed) { disposed = true; off(); pi.events.emit(CHANGED, { version: 1 }); } };
}
export interface Discovery {
	version: 1;
	consumer?: ConsumerHello;
	receipts?: readonly DiscoveryReceipt[];
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
	let ready = true;
	let registration: Registration = Object.freeze({ owner: initial.id, instanceId: randomUUID(), revision: 1 });
	let accepted = new WeakSet<ConsumerHello>();
	const offV2 = pi.events.on(DISCOVER_V2, (value) => {
		if (disposed || !ready || !discoveryV2(value)) return;
		const requires = Array.isArray(provider.tools) && provider.tools.some((tool) => tool?.approval !== undefined) ? [APPROVAL_FEATURE] : [];
		if (requires.some((feature) => !value.hello.features.includes(feature))) return;
		if (value.offer({ kind: "provider", registration, requires, provider }).status === "compatible") accepted.add(value.hello);
	});
	const off = pi.events.on(DISCOVER, (value) => {
		if (disposed || !ready || !discover(value) || hasReceipt(value, registration, accepted)) return;
		// Old consumers can ignore unknown fields; never give them a closure
		// whose safety depends on recognizing the later approval field.
		const tools = Array.isArray(provider.tools) ? provider.tools.filter((tool) => tool?.approval === undefined) : provider.tools;
		if (!Array.isArray(tools)) { value.provider(provider); return; }
		if (tools.length) value.provider({ id: provider.id, tools });
	});
	pi.events.emit(CHANGED, { version: 1 });
	return {
		refresh(tools: readonly CodeModeTool[]) {
			if (disposed) throw new Error("Code Mode provider registration disposed");
			ready = false;
			pi.events.emit(CHANGED, { version: 1 });
			provider = { id: initial.id, tools };
			registration = Object.freeze({ ...registration, revision: registration.revision + 1 });
			accepted = new WeakSet();
			ready = true;
			pi.events.emit(CHANGED, { version: 1 });
		},
		dispose() { if (!disposed) { disposed = true; off(); offV2(); pi.events.emit(CHANGED, { version: 1 }); } },
	};
}
export function registerCodeModePolicy(pi: ExtensionAPI, policy: CodeModePolicy) {
	let disposed = false;
	const registration = Object.freeze({ owner: policy.id, instanceId: randomUUID(), revision: 1 });
	const accepted = new WeakSet<ConsumerHello>();
	const offV2 = pi.events.on(DISCOVER_V2, (value) => {
		if (disposed || !discoveryV2(value)) return;
		const requires = policy.approval !== undefined ? [APPROVAL_FEATURE] : [];
		if (requires.some((feature) => !value.hello.features.includes(feature))) return;
		if (value.offer({ kind: "policy", registration, requires, policy }).status === "compatible") accepted.add(value.hello);
	});
	const off = pi.events.on(DISCOVER, (value) => {
		if (disposed || !discover(value) || hasReceipt(value, registration, accepted)) return;
		value.policy(policy.approval === undefined ? policy : {
			id: policy.id,
			before: () => ({ block: true, reason: "Code Mode policy requires negotiated approval/1 support" }),
		});
	});
	pi.events.emit(CHANGED, { version: 1 });
	return () => { if (!disposed) { disposed = true; off(); offV2(); pi.events.emit(CHANGED, { version: 1 }); } };
}
