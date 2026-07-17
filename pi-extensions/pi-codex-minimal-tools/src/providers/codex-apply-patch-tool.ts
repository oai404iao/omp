import { readFileSync } from "node:fs";

export const CODEX_APPLY_PATCH_DESCRIPTION = "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.";

let grammar: string | undefined;

export function codexApplyPatchGrammar(): string {
	grammar ??= readFileSync(new URL("./codex-apply-patch.lark", import.meta.url), "utf8");
	return grammar;
}

export function createCodexApplyPatchCustomTool(): Record<string, unknown> {
	return {
		type: "custom",
		name: "apply_patch",
		description: CODEX_APPLY_PATCH_DESCRIPTION,
		format: {
			type: "grammar",
			syntax: "lark",
			definition: codexApplyPatchGrammar(),
		},
	};
}