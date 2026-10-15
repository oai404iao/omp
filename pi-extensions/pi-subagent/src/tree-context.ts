import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { TREE_CUSTOM_TYPE } from "./store.ts";

export const INDEPENDENT_TREE_CONTEXT = "This is a new independent agent tree; no child agents were inherited. " +
	"Agent paths in copied history belong to the old tree and cannot control this tree. " +
	"Spawn new agents to continue delegation.";

/** Session identity, not a lifecycle event reason, decides whether history was copied. */
export function independentTreeContext(manager: SessionManager): string | undefined {
	const sessionId = manager.getSessionId();
	const copiedMarker = manager.getEntries().some(entry => entry.type === "custom" &&
		entry.customType === TREE_CUSTOM_TYPE &&
		(entry.data as { rootSessionId?: string } | undefined)?.rootSessionId !== sessionId);
	return manager.getHeader()?.parentSession || copiedMarker ? INDEPENDENT_TREE_CONTEXT : undefined;
}
