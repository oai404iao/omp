import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { createCodexSubagentInlineExtension } from "@oai404iao/pi-codex-runtime/subagent-inline";

const PACKAGE = "@oai404iao/pi-codex-runtime";
const ENTRY = `${PACKAGE}/subagent-inline`;

export type CodexIntegration =
	| { status: "ready"; create: typeof createCodexSubagentInlineExtension }
	| { status: "absent" }
	| { status: "failed"; cause: unknown };

/** Resolve once during extension activation, before any child can start. */
export async function loadCodexIntegration(): Promise<CodexIntegration> {
	const require = createRequire(import.meta.url);
	try {
		try {
			require.resolve(ENTRY);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if ((code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") &&
				!require.resolve.paths(PACKAGE)?.some(path => existsSync(join(path, PACKAGE)))) {
				return { status: "absent" };
			}
			throw error;
		}
		const integration = await import("@oai404iao/pi-codex-runtime/subagent-inline");
		if (typeof integration.createCodexSubagentInlineExtension !== "function") {
			throw new Error(`${ENTRY} does not export createCodexSubagentInlineExtension`);
		}
		return { status: "ready", create: integration.createCodexSubagentInlineExtension };
	} catch (cause) {
		return { status: "failed", cause };
	}
}
