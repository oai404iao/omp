import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { withFileMutationQueue, type ToolLoadout, type ToolLoadoutChanges } from "@earendil-works/pi-coding-agent";
import { NATIVE_MUTATION_TOOL_NAMES } from "@oai404iao/pi-codex-runtime/internal/capabilities";
import { applyPatch, resolvePatchPath, type ApplyPatchResult } from "../patch/apply.js";
import { parseApplyPatch } from "../patch/parser.js";
import { createApplyPatchRenderers } from "../patch/render.js";
import { applyPatchOutputSchema } from "./apply-patch-output.js";

export const APPLY_PATCH_HIDDEN_TOOL_NAMES = ["read", ...NATIVE_MUTATION_TOOL_NAMES] as const;

export interface ApplyPatchInput {
	input: string;
}

export const applyPatchToolSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		input: { type: "string", description: "Raw Codex patch text, from *** Begin Patch to *** End Patch. Use Add, Update, or Delete file sections. File paths can be relative or absolute. Add lines start with +; update hunks start with @@ and use space, +, or - for each line." },
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

interface MutationTarget {
	path: string;
	key: string;
	identity: string;
	inode?: string;
}

async function missingTargetIdentity(path: string): Promise<string> {
	let ancestor = path;
	for (;;) {
		try {
			return resolve(await realpath(ancestor), relative(ancestor, path));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		// A dangling symlink is not a missing directory: its future identity
		// cannot be inferred from its lexical parent.
		const entry = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		if (entry || dirname(ancestor) === ancestor) throw new Error(`Cannot resolve patch target identity: ${path}`);
		ancestor = dirname(ancestor);
	}
}

async function mutationTarget(path: string): Promise<MutationTarget> {
	try {
		const key = await realpath(path);
		const info = await stat(key, { bigint: true });
		return { path, key, identity: key, inode: `${info.dev}:${info.ino}` };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { path, key: path, identity: await missingTargetIdentity(path) };
	}
}

export async function executeApplyPatchTool(params: ApplyPatchInput, cwd: string, signal?: AbortSignal): Promise<{ content: Array<{ type: "text"; text: string }>; details: ApplyPatchResult; structuredContent: ApplyPatchResult }> {
	signal?.throwIfAborted();
	if (!params || typeof params.input !== "string") throw new Error("apply_patch requires an input string.");
	let targets: MutationTarget[];
	try {
		targets = await Promise.all(applyPatchTargetPaths(params.input, cwd).map(mutationTarget));
		const identities = new Set<string>();
		const inodes = new Set<string>();
		for (const target of targets) {
			if (identities.has(target.identity) || (target.inode !== undefined && inodes.has(target.inode))) {
				throw new Error(`Patch paths alias the same target: ${target.path}`);
			}
			identities.add(target.identity);
			if (target.inode !== undefined) inodes.add(target.inode);
		}
		// Order by semantic identity even for missing files: Pi's queue key can
		// become canonical when another mutation creates a file while we wait.
		targets.sort((a, b) => a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`apply_patch verification failed: ${message}`);
	}
	let result: ApplyPatchResult | undefined;
	const runAt = async (index: number): Promise<void> => {
		signal?.throwIfAborted();
		for (const target of targets) {
			const current = await mutationTarget(target.path);
			if (current.key !== target.key || current.identity !== target.identity || current.inode !== target.inode) {
				throw new Error(`Patch target identity changed while acquiring mutation queues: ${target.path}`);
			}
		}
		signal?.throwIfAborted();
		if (index >= targets.length) {
			result = await applyPatch(params.input, { cwd });
			return;
		}
		await withFileMutationQueue(targets[index]!.key, () => runAt(index + 1));
	};
	await runAt(0);
	if (!result) throw new Error("apply_patch did not produce a result.");
	return {
		content: [{ type: "text", text: result.summary }],
		details: result,
		structuredContent: result,
	};
}

export function createApplyPatchToolDefinition(options: { cwd?: string; deferRendering?: boolean } = {}) {
	const definition = {
		name: "apply_patch",
		label: "Apply Patch",
		description: "The `apply_patch` tool can be used to edit files. Pass the Codex patch text as the `input` argument.",
		promptSnippet: "Edit files using the Codex patch format.",
		parameters: applyPatchToolSchema,
		outputSchema: applyPatchOutputSchema,
		prepareLoadout(loadout: ToolLoadout): ToolLoadoutChanges | undefined {
			if (!loadout.declared.some(tool => tool.name === "apply_patch")) return undefined;
			return {
				hiddenDeclarations: loadout.declared
					.filter(tool => APPLY_PATCH_HIDDEN_TOOL_NAMES.some(name => name === tool.name))
					.map(tool => tool.name),
			};
		},
		async execute(_toolCallId: string, params: ApplyPatchInput, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string }) {
			const cwd = ctx?.cwd ?? options.cwd ?? process.cwd();
			return executeApplyPatchTool(params, cwd, signal);
		},
	};
	return { ...definition, ...(!options.deferRendering ? createApplyPatchRenderers() : {}) };
}
