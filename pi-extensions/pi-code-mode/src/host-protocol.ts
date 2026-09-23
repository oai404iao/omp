import { object } from "./wire.ts";

export const RESOURCE_LIMITS = "session-cell-execution-resource-limits";
export function negotiatedLimits(value: unknown): boolean {
	const hello = object(value);
	if (hello.type !== "connection/ready" || hello.selectedVersion !== 1 || !Array.isArray(hello.capabilities)
		|| hello.capabilities.some((item) => item !== RESOURCE_LIMITS)
		|| new Set(hello.capabilities).size !== hello.capabilities.length) throw new Error("Incompatible Host protocol/capabilities");
	return hello.capabilities.includes(RESOURCE_LIMITS);
}
export function hostDuration(value: unknown): number {
	if (value === undefined) return 0;
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid Host operation duration");
	return value as number;
}
