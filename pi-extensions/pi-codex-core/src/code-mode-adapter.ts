import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCodeModeContribution, type OwnedCodeModeTool } from "@oai404iao/pi-codex-runtime/internal/code-mode-contributions";
import { computeToolCapabilities } from "@oai404iao/pi-codex-runtime/internal/capabilities";
import { loadSettings } from "@oai404iao/pi-codex-runtime/internal/settings";
import { applyPatchToolSchema, executeApplyPatchTool, type ApplyPatchInput } from "./tools/apply-patch.js";

export function registerPatchContribution(pi: ExtensionAPI): void {
	const enabled = (ctx: ExtensionContext) => computeToolCapabilities(ctx.model, loadSettings(ctx.cwd)).apply_patch.enabled;
	const tool: OwnedCodeModeTool = {
		name: "apply_patch", effect: "write",
		description: "Apply a Codex multi-file patch. Uses the installed core executor and Pi file mutation queue. Relative/absolute paths have full owner authority, not Code Mode root confinement. No rollback; an entered patch must finish settling on abort. Pi direct tool hooks are not inherited.",
		parameters: applyPatchToolSchema,
		async invoke(input, ctx) {
			ctx.signal.throwIfAborted();
			if (!ctx.pi || !enabled(ctx.pi)) throw new Error("Codex apply_patch is not enabled for the current model");
			const result = await executeApplyPatchTool(input as ApplyPatchInput, ctx.cwd, ctx.signal);
			return { value: result.details };
		},
	};
	registerCodeModeContribution(pi, "codex_core", (ctx) => enabled(ctx) ? [tool] : []);
}
