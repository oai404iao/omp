import { definitions, writeSchema, type ReadRoot } from "./readonly.ts";
import { runProcess, processSchema } from "./process.ts";
import { jsonValue } from "./bridge.ts";
import type { CodeModeTool } from "./contributions.ts";

export interface Grants { write: boolean; process: boolean; tools: readonly string[] }
export const READ_ONLY: Grants = { write: false, process: false, tools: [] };
export function localTools(root: ReadRoot, grants: Grants): CodeModeTool[] {
	const tools: CodeModeTool[] = definitions.map((tool) => ({
		name: tool.name, description: tool.description, parameters: tool.schema, effect: "read", parallel: true,
		invoke: async (args, ctx) => ({ value: jsonValue(await root.invoke(tool.name, args, ctx.signal)) }),
	}));
	if (grants.write) tools.push({
		name: "write", effect: "write",
		description: "Atomically create/replace a UTF-8 file under the authorized root, existing parent directories only. {path,content}, <=128 KiB. No symlink traversal. Returns {path,bytesWritten,committed}. Cancellation does not undo a committed rename.",
		parameters: writeSchema, invoke: async (args, ctx) => ({ value: jsonValue(await root.write(args, ctx.signal)) }),
	});
	if (grants.process) tools.push({
		name: "bash", effect: "process", parameters: processSchema,
		description: "Execute a local bash command with full current-user authority, NOT a filesystem/network sandbox. {command,timeout_ms?}, default 30s, max 300s. Starts in the granted directory; no inherited credentials or shell startup files. Supervised local cgroup; remote/deliberately escaped work is not undone. Returns {stdout,stderr,exitCode}.",
		invoke: async (args, ctx) => ({ value: jsonValue(await runProcess(root, args, ctx.signal)) }),
	});
	return tools;
}
