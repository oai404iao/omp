import { createCodexApplyPatchCustomTool } from "@oai404iao/pi-codex-tools/internal/providers/codex-apply-patch-tool";
import type { ToolProtocol } from "@oai404iao/pi-codex-runtime/internal/broker";

export const fixtureToolProtocols: ReadonlyMap<string, ToolProtocol> = new Map([["apply_patch", {
	customTool: createCodexApplyPatchCustomTool(), inputProperty: "input",
}]]);
