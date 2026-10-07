import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { claimSessionFeature } from "./session-claims.js";
import { beginCodexTurn, captureCodexTurnAttribution, endCodexTurn } from "./codex-wire-identity.js";
import { readCodexTurnAttribution, readSubagentLineage, TURN_ATTRIBUTION_CHANNEL } from "./codex-session-lineage.js";

/** Logical task causality also spans agents that do not emit Codex wire identity. */
export function installCodexTurnLifecycle(pi: ExtensionAPI): void {
	if (!claimSessionFeature(pi, "logical-turn-identity")) return;
	const unsubscribe = pi.events?.on(TURN_ATTRIBUTION_CHANNEL, value => {
		const request = value as { sessionId?: string; accept?: (attribution: ReturnType<typeof captureCodexTurnAttribution>) => void };
		if (typeof request?.accept === "function") request.accept(captureCodexTurnAttribution(request.sessionId));
	});
	pi.on("before_agent_start", (_event, ctx) => {
		const session = ctx.sessionManager;
		const sessionId = session?.getSessionId?.();
		if (!sessionId) return;
		const entries = session.getEntries?.() ?? [];
		const lineage = readSubagentLineage(entries);
		beginCodexTurn(sessionId, {
			parentPiSessionId: lineage?.parentPiSessionId,
			attribution: readCodexTurnAttribution(session.getBranch?.() ?? entries),
		});
	});
	pi.on("agent_settled", (_event, ctx) => {
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (sessionId) endCodexTurn(sessionId);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribe?.();
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (sessionId) endCodexTurn(sessionId);
	});
}
