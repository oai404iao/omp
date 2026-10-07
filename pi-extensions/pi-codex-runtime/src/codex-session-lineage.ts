import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { canonicalAgentName, isUuidV7, type CodexTurnAttribution } from "./codex-identity-types.js";

export const TURN_ATTRIBUTION_CHANNEL = "@oai404iao/pi-codex:turn-attribution:v1";
export const TURN_ATTRIBUTION_CUSTOM_TYPE = "pi-codex/turn-attribution";
export interface SubagentLineage {
	agentId: string;
	parentAgentId: string;
	parentPiSessionId: string;
	parentSessionFile?: string;
	relation: "spawn" | "fork";
	agentName?: string;
}
function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function readSubagentLineage(entries: readonly SessionEntry[]): SubagentLineage | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom") continue;
		const lineage = record(entry.data);
		if (entry.customType === "pi-subagent/lineage") {
			if (lineage?.version !== 1 || lineage.openAIIdentity !== true
				|| (lineage.relation !== "spawn" && lineage.relation !== "fork")
				|| typeof lineage.agentId !== "string" || typeof lineage.parentAgentId !== "string"
				|| typeof lineage.parentPiSessionId !== "string") return undefined;
			const name = typeof lineage.agentPath === "string" ? lineage.agentPath
				: typeof lineage.agentName === "string" ? lineage.agentName : undefined;
			return {
				agentId: lineage.agentId, parentAgentId: lineage.parentAgentId,
				parentPiSessionId: lineage.parentPiSessionId, relation: lineage.relation,
				...(typeof lineage.parentSessionFile === "string" ? { parentSessionFile: lineage.parentSessionFile } : {}),
				...(name ? { agentName: canonicalAgentName(name) } : {}),
			};
		}
		if (entry.customType !== "pi-subagent/descriptor") continue;
		const runtime = record(lineage?.runtime);
		if (lineage?.version !== 2 || runtime?.openAIIdentity !== true
			|| (lineage.provider !== "spawn" && lineage.provider !== "fork")
			|| typeof lineage.agentId !== "string" || typeof lineage.parentAgentId !== "string"
			|| typeof lineage.parentPiSessionId !== "string") return undefined;
		const agent = record(lineage.agent);
		const name = typeof lineage.path === "string" ? lineage.path : typeof agent?.name === "string" ? agent.name : undefined;
		return {
			agentId: lineage.agentId, parentAgentId: lineage.parentAgentId,
			parentPiSessionId: lineage.parentPiSessionId, relation: lineage.provider,
			...(typeof lineage.parentSessionFile === "string" ? { parentSessionFile: lineage.parentSessionFile } : {}),
			...(name ? { agentName: canonicalAgentName(name) } : {}),
		};
	}
	return undefined;
}
export function readCodexTurnAttribution(entries: readonly SessionEntry[]): CodexTurnAttribution | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== TURN_ATTRIBUTION_CUSTOM_TYPE) continue;
		const data = record(entry.data);
		if (data?.version !== 1) continue;
		return {
			...(isUuidV7(data.parentTurnId) ? { parentTurnId: data.parentTurnId } : {}),
			...(isUuidV7(data.rootTurnId) ? { rootTurnId: data.rootTurnId } : {}),
		};
	}
	return undefined;
}
