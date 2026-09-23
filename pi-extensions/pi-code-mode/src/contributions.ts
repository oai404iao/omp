import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue, Usage } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { CodeModeDirectBinding } from "./direct-binding.ts";
import { randomUUID } from "node:crypto";
import { APPROVAL_FEATURE, DISCOVER_V2, discoveryV2, hasReceipt, features, availability, consumerGate, currentLegacyConsumer, type Availability, type ConsumerHello, type DiscoveryReceipt, type Registration } from "./discovery.ts";
import { announce } from "./changes.ts";
import { providerContract, sameContract } from "./discovery-state.ts";
export { DISCOVER_V2, FEATURES, type Availability, type ConsumerHello, type Registration, type DiscoveryV2, type DiscoveryOffer, type DiscoveryReceipt } from "./discovery.ts";
export { CHANGED_V2, type ContributionChange, type ChangeKind } from "./changes.ts";
export { unsettledEffect, isUnsettledEffect } from "./errors.ts";
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
	requires?: readonly string[];
	requiredPolicies?: readonly string[];
	availability?: Availability;
	/** Explicit approval provider ID. Missing provider/denial fails closed. */
	approval?: string;
	/** Optional owner cooperation for hide-bridged. Never inferred by name. */
	direct?: CodeModeDirectBinding;
	prepare?(input: unknown): unknown;
	invoke(input: unknown, context: InvocationContext): Promise<ContributionResult>;
}
export interface CodeModeProvider { id: string; tools: readonly CodeModeTool[]; requires?: readonly string[]; availability?: Availability }
export interface PolicyCall {
	readonly name: string;
	readonly effect: CodeModeTool["effect"];
	readonly input: unknown;
	readonly context: InvocationContext;
}
export interface CodeModePolicy {
	id: string;
	requires?: readonly string[];
	/** Requires approval for every call covered by this policy. */
	approval?: string;
	before?(call: PolicyCall): Promise<void | { block: true; reason?: string }> | void | { block: true; reason?: string };
	after?(call: PolicyCall, value: JsonValue): Promise<JsonValue> | JsonValue;
}
/** Resolve synchronously without I/O. Failure keeps the global guard closed;
 * configure requiredPolicies as well to cover a producer that never loads. */
export interface CodeModePolicySource { id: string; resolve(): CodeModePolicy }
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
	const currentConsumer = consumerGate();
	const registration = Object.freeze({ owner: approval.id, instanceId: randomUUID(), revision: 1 });
	const accepted = new WeakSet<ConsumerHello>();
	const offV2 = pi.events.on(DISCOVER_V2, (value) => {
		if (!disposed && discoveryV2(value) && currentConsumer(value.hello) && value.hello.features.includes(APPROVAL_FEATURE)
			&& value.offer({ kind: "approval", registration, requires: [APPROVAL_FEATURE], approval }).status === "compatible") accepted.add(value.hello);
	});
	const off = pi.events.on(APPROVALS, (value) => {
		const request = value as { version?: number; accept?: (approval: CodeModeApproval) => void; consumer?: ConsumerHello; receipts?: DiscoveryReceipt[] } | undefined;
		if (!disposed && request?.version === 1 && typeof request.accept === "function"
			&& currentLegacyConsumer(request, currentConsumer) && !hasReceipt(request, registration, accepted)) request.accept(approval);
	});
	announce(pi, registration, "approval", "ready");
	return () => { if (!disposed) { disposed = true; off(); offV2(); announce(pi, registration, "approval", "disposed"); } };
}
export function registerCodeModeObserver(pi: ExtensionAPI, observer: CodeModeObserver) {
	let disposed = false;
	const currentConsumer = consumerGate();
	const registration = Object.freeze({ owner: observer.id, instanceId: randomUUID(), revision: 1 });
	const snapshot: CodeModeObserver = { id: observer.id, complete(receipt, signal) {
		if (!disposed) return observer.complete(receipt, signal);
	} };
	const accepted = new WeakSet<ConsumerHello>();
	const offV2 = pi.events.on(DISCOVER_V2, (value) => {
		if (!disposed && discoveryV2(value) && currentConsumer(value.hello) && value.hello.features.includes("observer-receipt/1")
			&& value.offer({ kind: "observer", registration, requires: ["observer-receipt/1"], observer: snapshot }).status === "compatible") accepted.add(value.hello);
	});
	const off = pi.events.on(OBSERVERS, (value) => {
		const request = value as { version?: number; accept?: (observer: CodeModeObserver) => void; consumer?: ConsumerHello; receipts?: DiscoveryReceipt[] } | undefined;
		if (!disposed && request?.version === 1 && typeof request.accept === "function"
			&& currentLegacyConsumer(request, currentConsumer) && !hasReceipt(request, registration, accepted)) request.accept(snapshot);
	});
	announce(pi, registration, "observer", "ready");
	return () => { if (!disposed) { disposed = true; off(); offV2(); announce(pi, registration, "observer", "disposed"); } };
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
const unavailableInvoke = async (): Promise<ContributionResult> => { throw new Error("Code Mode tool is unavailable or not negotiated"); };

/** Factory-time registration works before/after the main extension. The bus
 * carries snapshots, not process-global singleton state or private Pi APIs. */
export function registerCodeModeTools(pi: ExtensionAPI, initial: CodeModeProvider) {
	const currentConsumer = consumerGate();
	let provider = initial;
	let disposed = false;
	let ready = true;
	let registration: Registration = Object.freeze({ owner: initial.id, instanceId: randomUUID(), revision: 1 });
	let accepted = new WeakSet<ConsumerHello>();
	const offV2 = pi.events.on(DISCOVER_V2, (value) => {
		if (disposed || !ready || !discoveryV2(value) || !currentConsumer(value.hello)) return;
		const requires = [...new Set([...features(provider.requires ?? []),
			...(Array.isArray(provider.tools) && provider.tools.some((tool) => tool?.approval !== undefined) ? [APPROVAL_FEATURE] : []),
			...(Array.isArray(provider.tools) && provider.tools.some((tool) => tool?.requiredPolicies?.length) ? ["required-policies/1"] : []),
		])];
		if (requires.some((feature) => !value.hello.features.includes(feature))) {
			if (provider.requires?.length) value.offer({ kind: "provider", registration, requires,
				availability: { state: "unavailable", reason: "missing-feature" }, provider: { id: provider.id, tools: [] } });
			return;
		}
		const tools = availability(provider.availability).state !== "available" ? [] : provider.tools.map((tool) => features(tool.requires ?? []).every((feature) => value.hello.features.includes(feature))
			&& availability(tool.availability).state === "available" ? tool : { ...tool, prepare: undefined, direct: undefined, invoke: unavailableInvoke });
		if (value.offer({ kind: "provider", registration, requires, provider: { ...provider, tools }, availability: provider.availability }).status === "compatible") accepted.add(value.hello);
	});
	const off = pi.events.on(DISCOVER, (value) => {
		if (disposed || !ready || !discover(value) || !currentLegacyConsumer(value, currentConsumer) || hasReceipt(value, registration, accepted)) return;
		// Old consumers can ignore unknown fields; never give them a closure
		// whose safety depends on recognizing the later approval field.
		if (features(provider.requires ?? []).length || availability(provider.availability).state !== "available") return;
		const tools = Array.isArray(provider.tools) ? provider.tools.filter((tool) => tool?.approval === undefined
			&& !features(tool.requires ?? []).length && !tool.requiredPolicies?.length && availability(tool.availability).state === "available") : provider.tools;
		if (!Array.isArray(tools)) { value.provider(provider); return; }
		if (tools.length) value.provider({ id: provider.id, tools });
	});
	announce(pi, registration, "execution", "ready");
	return {
		refresh(value: readonly CodeModeTool[] | CodeModeProvider, kind: "execution" | "presentation" = "execution") {
			if (disposed) throw new Error("Code Mode provider registration disposed");
			const next: CodeModeProvider = Array.isArray(value) ? { ...provider, tools: value } : value as CodeModeProvider;
			if (next.id !== initial.id) throw new Error("Code Mode provider identity cannot change");
			if (kind === "presentation" && !sameContract(providerContract(provider), providerContract(next)))
				throw new Error("Presentation refresh cannot change the executable contract");
			if (kind === "execution") {
				ready = false;
				announce(pi, registration, kind, "withdrawn");
			}
			provider = next;
			registration = Object.freeze({ ...registration, revision: registration.revision + 1 });
			accepted = new WeakSet();
			ready = true;
			announce(pi, registration, kind, "ready");
		},
		dispose() { if (!disposed) { disposed = true; off(); offV2(); announce(pi, registration, "execution", "disposed"); } },
	};
}
export function registerCodeModePolicy(pi: ExtensionAPI, source: CodeModePolicy | CodeModePolicySource) {
	const currentConsumer = consumerGate();
	let disposed = false;
	let ready = true;
	let registration: Registration = Object.freeze({ owner: source.id, instanceId: randomUUID(), revision: 1 });
	let accepted = new WeakSet<ConsumerHello>();
	let resolved: CodeModePolicy | undefined;
	const resolve = () => {
		if (resolved) return resolved;
		const policy = "resolve" in source ? source.resolve() : source;
		if (policy.id !== registration.owner) throw new Error("Policy identity changed");
		return resolved = policy;
	};
	const deny: CodeModePolicy = { id: source.id,
		before: () => ({ block: true, reason: "Code Mode policy unavailable or requires negotiated approval/1 support" }) };
	const offV2 = pi.events.on(DISCOVER_V2, (value) => {
		if (disposed || !discoveryV2(value) || !currentConsumer(value.hello)) return;
		value.offer({ kind: "policy", registration, requires: [], availability: { state: "not-ready" } });
		if (!ready) return;
		try {
			const policy = resolve();
			const requires = [...new Set([...features(policy.requires ?? []), ...(policy.approval !== undefined ? [APPROVAL_FEATURE] : [])])];
			if (requires.some((feature) => !value.hello.features.includes(feature))) {
				value.offer({ kind: "policy", registration, requires, availability: { state: "failed", reason: "missing-approval-feature" } });
				return;
			}
			if (value.offer({ kind: "policy", registration, requires, policy, availability: { state: "available" } }).status === "compatible") accepted.add(value.hello);
		} catch {
			value.offer({ kind: "policy", registration, requires: [], availability: { state: "failed", reason: "owner-not-ready" } });
		}
	});
	const off = pi.events.on(DISCOVER, (value) => {
		if (disposed || !discover(value) || !currentLegacyConsumer(value, currentConsumer) || hasReceipt(value, registration, accepted)) return;
		let policy = deny;
		try {
			if (ready && !("resolve" in source) && source.approval === undefined && !features(source.requires ?? []).length) policy = source;
		} catch { /* Leave the legacy deny guard in place. */ }
		value.policy(policy);
	});
	announce(pi, registration, "policy", "ready");
	const dispose = () => { if (!disposed) { disposed = true; off(); offV2(); announce(pi, registration, "policy", "disposed"); } };
	return Object.assign(dispose, { refresh() {
		if (disposed) throw new Error("Code Mode policy registration disposed");
		ready = false;
		resolved = undefined;
		announce(pi, registration, "policy", "withdrawn");
		registration = Object.freeze({ ...registration, revision: registration.revision + 1 });
		accepted = new WeakSet();
		ready = true;
		announce(pi, registration, "policy", "ready");
	} });
}
