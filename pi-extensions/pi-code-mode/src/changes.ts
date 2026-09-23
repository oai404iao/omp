import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Registration } from "./discovery.ts";

export const CHANGED_V2 = "@oai404iao/pi-code-mode:changed/v2";
export type ChangeKind = "execution" | "policy" | "approval" | "presentation" | "observer";
export interface ContributionChange {
	readonly protocol: 2;
	readonly registration: Registration;
	readonly kind: ChangeKind;
	readonly phase: "withdrawn" | "ready" | "disposed";
}
export function announce(pi: ExtensionAPI, registration: Registration, kind: ChangeKind, phase: ContributionChange["phase"]): void {
	const change: ContributionChange = Object.freeze({ protocol: 2, registration, kind, phase });
	pi.events.emit(CHANGED_V2, change);
	pi.events.emit("@oai404iao/pi-code-mode:changed/v1", { version: 1, change });
}
export function contributionChange(value: unknown): value is ContributionChange {
	const change = value as ContributionChange | undefined;
	return change?.protocol === 2 && ["execution", "policy", "approval", "presentation", "observer"].includes(change.kind)
		&& ["withdrawn", "ready", "disposed"].includes(change.phase)
		&& typeof change.registration?.owner === "string" && change.registration.owner.length <= 82
		&& typeof change.registration.instanceId === "string" && change.registration.instanceId.length > 0 && change.registration.instanceId.length <= 128
		&& Number.isSafeInteger(change.registration.revision) && change.registration.revision > 0;
}
