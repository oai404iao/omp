import type { CodeModePolicy, CodeModeProvider } from "./contributions.ts";

export const DISCOVER_V2 = "@oai404iao/pi-code-mode:discover/v2";
export const APPROVAL_FEATURE = "approval/1";
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
} & ({ kind: "provider"; provider: CodeModeProvider } | {
	kind: "policy"; policy?: CodeModePolicy;
	availability?: { state: "available" | "not-ready" | "failed"; reason?: string };
});
export interface DiscoveryV2 {
	hello: ConsumerHello;
	offer(value: DiscoveryOffer): { status: "compatible" | "incompatible" | "unavailable"; missing?: readonly string[] };
}
export function discoveryV2(value: unknown): value is DiscoveryV2 {
	const request = value as Partial<DiscoveryV2> | undefined;
	return request?.hello?.protocol === 2 && typeof request.hello.instanceId === "string"
		&& Number.isSafeInteger(request.hello.generation) && request.hello.generation > 0
		&& Array.isArray(request.hello.features) && request.hello.features.length <= 32
		&& typeof request.offer === "function";
}

/** Receipts refer to this producer's exact in-process registration and the
 * current discovery hello. Names or a generic supportsPolicies flag do not count. */
export function hasReceipt(
	request: { consumer?: ConsumerHello; receipts?: readonly DiscoveryReceipt[] },
	registration: Registration,
	accepted: WeakSet<ConsumerHello>,
): boolean {
	return Boolean(request.consumer && accepted.has(request.consumer)
		&& Array.isArray(request.receipts) && request.receipts.length <= 48
		&& request.receipts.some((receipt) => receipt.registration === registration && receipt.consumer === request.consumer));
}
