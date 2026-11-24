import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addPackageTool, ensureCodexServices } from "@oai404iao/pi-codex-runtime";
import { knownEndpointModel } from "@oai404iao/pi-codex-runtime/internal/endpoint-state";
import { loadModelSettings } from "@oai404iao/pi-codex-runtime/internal/model-catalog/runtime";
import { loadSettings } from "@oai404iao/pi-codex-runtime/internal/settings";
import { createCodexApplyPatchCustomTool } from "./providers/codex-apply-patch-tool.js";
import { APPLY_PATCH_HIDDEN_TOOL_NAMES, createApplyPatchToolDefinition, type ApplyPatchInput } from "./tools/apply-patch.js";
import { executeWithToolResult } from "./tools/tool-result.js";

export default function codexApplyPatch(pi: ExtensionAPI): void {
	const broker = ensureCodexServices(pi);
	if (!broker.claim("package:apply-patch")) return;
	const settings = loadSettings();
	if (!settings.enabled || !settings.applyPatch) return;
	const definition = createApplyPatchToolDefinition({ deferRendering: settings.deferApplyPatchRendering });
	const parameters = { ...(definition.parameters as object) };
	broker.ownedTools.set("apply_patch", {
		parameters,
		description: definition.description,
		protocol: {
			customTool: createCodexApplyPatchCustomTool(),
			inputProperty: "input",
			hiddenTools: APPLY_PATCH_HIDDEN_TOOL_NAMES,
		},
	});
	addPackageTool(broker, "apply_patch", exposure => {
		pi.registerTool({
			...definition, parameters, exposure,
			execute(id: string, input: ApplyPatchInput, signal: AbortSignal | undefined, update: unknown, ctx: ExtensionContext) {
				return executeWithToolResult(signal, async () => {
					const settings = loadSettings(ctx.cwd);
					if (!settings.enabled || !settings.applyPatch) throw new Error("apply_patch is disabled by global settings.");
					const model = knownEndpointModel(ctx.model ?? {}, ctx.sessionManager?.getSessionId?.());
					const profile = loadModelSettings(model, ctx.cwd, settings).modelProfile?.effective;
					if (!profile?.enabled || !profile.tools.applyPatch) throw new Error("apply_patch is not enabled for the active model profile.");
					if (profile.tools.applyPatch === "custom" && (!broker.engine?.customTools || !broker.engine.supports(model))) {
						throw new Error("Custom apply_patch requires pi-codex-core with a compatible Responses engine. Select an explicitly supported function profile for independent execution.");
					}
					return definition.execute(id, input, signal, update, ctx);
				}, message => /^apply_patch verification failed: Failed to find (?:context|expected lines)\b/.test(message)
					? `${message}\nCheck the current file contents and rebuild the hunk before retrying.`
					: message);
			},
		} as never);
	});
}
