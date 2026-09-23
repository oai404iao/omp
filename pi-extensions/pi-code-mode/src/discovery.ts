import type { CodeModePolicy, CodeModeProvider, CodeModeApproval, CodeModeObserver } from "./contributions.ts";

export const DISCOVER_V2 = "@oai404iao/pi-code-mode:discover/v2";
export const APPROVAL_FEATURE = "approval/1";
export const FEATURES = Object.freeze([
	"json-result/1", "prepared-frozen-args/1", "abort-settlement/1",
	"exclusive-scheduler/1", "usage-accounting/1", APPROVAL_FEATURE,
	"direct-lease/1", "observer-receipt/1", "required-policies/1",
]);
export interface Availability { readonly state: "available" | "unavailable" | "not-ready" | "failed"; readonly reason?: string }
export function features(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.length > 32 || new Set(value).size !== value.length
		|| value.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9-]*\/[1-9][0-9]*$/.test(item) || item.length > 128))
		throw new Error("Invalid Code Mode feature requirements");
	return value;
}
export function availability(value: Availability | undefined): Availability {
	if (value === undefined) return { state: "available" };
	if (!value || !["available", "unavailable", "not-ready", "failed"].includes(value.state)
		|| (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 256)))
		throw new Error("Invalid Code Mode availability");
	return value;
}
export function isPolicyId(value: unknown): value is string {
	return typeof value === "string" && value.length <= 82
		&& value.split("__").length <= 2
		&& value.split("__").every((part) => part.length <= 40 && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(part));
}
export function requiredPolicyIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 16 || !value.every(isPolicyId) || new Set(value).size !== value.length) {
		throw new Error("requiredPolicies must contain at most 16 distinct exact policy IDs");
	}
	return [...value];
}
export interface Registration {
	readonly owner: string;
	readonly instanceId: string;
	readonly revision: number;
}
export interface ConsumerHello {
	readonly protocol: 2;
	readonly instanceId: string;
	readonly generation: number;
	readonly features: readonly string[];
	readonly limits: { resultBytes: number; callsPerCell: number; maxCells: number };
}
export interface DiscoveryReceipt {
	readonly registration: Registration;
	readonly consumer: ConsumerHello;
}
export type DiscoveryOffer = {
	registration: Registration;
	requires: readonly string[];
	availability?: Availability;
} & ({ kind: "provider"; provider: CodeModeProvider } | { kind: "approval"; approval: CodeModeApproval } | { kind: "observer"; observer: CodeModeObserver } | {
	kind: "policy"; policy?: CodeModePolicy;
});
export interface DiscoveryV2 {
	hello: ConsumerHello;
	offer(value: DiscoveryOffer): { status: "compatible" | "incompatible" | "unavailable" | "conflict"; missing?: readonly string[] };
}
export function discoveryV2(value: unknown): value is DiscoveryV2 {
	const request = value as Partial<DiscoveryV2> | undefined;
	return request?.hello?.protocol === 2 && typeof request.hello.instanceId === "string"
		&& Number.isSafeInteger(request.hello.generation) && request.hello.generation > 0
		&& request.hello.instanceId.length > 0 && request.hello.instanceId.length <= 128
		&& Array.isArray(request.hello.features) && request.hello.features.length <= 32
		&& request.hello.features.every((feature) => typeof feature === "string" && feature.length <= 128)
		&& request.hello.limits !== undefined
		&& [request.hello.limits.resultBytes, request.hello.limits.callsPerCell, request.hello.limits.maxCells].every((limit) => Number.isSafeInteger(limit) && limit > 0)
		&& typeof request.offer === "function";
}
export function currentLegacyConsumer(request: { consumer?: ConsumerHello }, current: (hello: ConsumerHello) => boolean): boolean {
	return request.consumer === undefined
		|| (discoveryV2({ hello: request.consumer, offer() {} }) && current(request.consumer));
}
export function consumerGate(): (hello: ConsumerHello) => boolean {
	const generations = new Map<string, number>();
	return (hello) => {
		const previous = generations.get(hello.instanceId);
		if ((previous !== undefined && hello.generation < previous) || (previous === undefined && generations.size >= 64)) return false;
		generations.set(hello.instanceId, hello.generation);
		return true;
	};
}

/** Receipts refer to this producer's exact in-process registration and the
 * current discovery hello. Names or a generic supportsPolicies flag do not count. */
export function hasReceipt(
	request: { consumer?: ConsumerHello; receipts?: readonly DiscoveryReceipt[] },
	registration: Registration,
	accepted: WeakSet<ConsumerHello>,
): boolean {
	return Boolean(request.consumer && accepted.has(request.consumer)
		&& Array.isArray(request.receipts) && request.receipts.length <= 80
		&& request.receipts.some((receipt) => receipt.registration === registration && receipt.consumer === request.consumer));
}
