import { readFileSync } from "node:fs";

// Description from OpenAI Codex (Apache-2.0); see THIRD_PARTY_NOTICES.md.
export const CODEX_APPLY_PATCH_DESCRIPTION = "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.";

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
