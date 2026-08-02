import { applyPatch, resolvePatchPath, type ApplyPatchResult } from "../patch/apply.js";
import { parseApplyPatch } from "../patch/parser.js";
import { createApplyPatchRenderers } from "../patch/render.js";

export interface ApplyPatchInput {
	input: string;
}

export const applyPatchToolSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		input: { type: "string", description: "Raw Codex patch text. File paths may be relative or absolute. Add File content lines start with +; Update File chunks use context, +, and - lines." },
	},
	required: ["input"],
};

export function applyPatchTargetPaths(input: string, cwd: string): string[] {
	const parsed = parseApplyPatch(input);
	const paths = new Set<string>();
	for (const action of parsed.actions) {
		paths.add(resolvePatchPath(action.path, { cwd }));
		if (action.kind === "update" && action.moveTo) paths.add(resolvePatchPath(action.moveTo, { cwd }));
	}
	return [...paths].sort();
}

async function withMutationQueue(path: string, fn: () => Promise<void>): Promise<void> {
	try {
		const mod = await import("@earendil-works/pi-coding-agent");
		const queue = (mod as { withFileMutationQueue?: (path: string, fn: () => Promise<void>) => Promise<void> }).withFileMutationQueue;
		if (typeof queue === "function") return queue(path, fn);
	} catch {
		// Unit tests can run outside Pi without peer dependencies installed.
	}
	return fn();
}

export async function executeApplyPatchTool(params: ApplyPatchInput, cwd: string): Promise<{ content: Array<{ type: "text"; text: string }>; details: ApplyPatchResult }> {
	if (!params || typeof params.input !== "string") throw new Error("apply_patch requires an input string.");
	let targets: string[];
	try {
		targets = applyPatchTargetPaths(params.input, cwd);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`apply_patch verification failed: ${message}`);
	}
	let result: ApplyPatchResult | undefined;
	const runAt = async (index: number): Promise<void> => {
		if (index >= targets.length) {
			result = await applyPatch(params.input, { cwd });
			return;
		}
		await withMutationQueue(targets[index]!, () => runAt(index + 1));
	};
	await runAt(0);
	if (!result) throw new Error("apply_patch did not produce a result.");
	return {
		content: [{ type: "text", text: result.summary }],
		details: result,
	};
}

export function createApplyPatchToolDefinition(options: { cwd?: string; deferRendering?: boolean } = {}) {
	const definition: Record<string, unknown> = {
		renderShell: "self",
		name: "apply_patch",
		label: "Apply Patch",
		description: "Use apply_patch to edit files with the Codex patch format. A patch starts with *** Begin Patch, contains one or more Add, Update, or Delete file sections, and ends with *** End Patch.",
		promptSnippet: "Apply Codex-style multi-file patches with contextual update hunks and explicit Add, Update, or Delete headers.",
		promptGuidelines: [
			"Use apply_patch for concise multi-file edits when a Codex-style patch is clearer than separate edit/write calls.",
			"In apply_patch, paths may be relative to the current working directory or absolute; prefix every Add File content line with +; and use @@ class/function context plus surrounding lines when repeated code needs disambiguation.",
			"Use *** End of File in apply_patch when a hunk must match the end of a file.",
		],
		parameters: applyPatchToolSchema,
		async execute(_toolCallId: string, params: ApplyPatchInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
			const cwd = ctx?.cwd ?? options.cwd ?? process.cwd();
			return executeApplyPatchTool(params, cwd);
		},
	};
	if (!options.deferRendering) Object.assign(definition, createApplyPatchRenderers());
	return definition;
}
