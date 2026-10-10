import type { Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCodexBroker } from "@oai404iao/pi-codex-runtime/internal/broker";
import { NATIVE_MUTATION_TOOL_NAMES } from "@oai404iao/pi-codex-runtime/internal/capabilities";
import { ownsRegisteredTool } from "@oai404iao/pi-codex-runtime/internal/tool-activation";

export function hasProjectedToolLoadout(pi: ExtensionAPI): boolean {
	return (pi.getActiveTools?.() ?? []).some(name => name === "codemode" || name === "tool_search");
}

export function activeToolSnapshot(pi: ExtensionAPI): Tool[] {
	const active = new Set(pi.getActiveTools?.() ?? []);
	if (active.has("apply_patch") && ownsRegisteredTool(pi, getCodexBroker(pi), "apply_patch")) {
		for (const name of NATIVE_MUTATION_TOOL_NAMES) active.delete(name);
	}
	return (pi.getAllTools?.() ?? [])
		.filter(tool => active.has(tool.name))
		.map(({ name, description, parameters }) => ({ name, description, parameters }));
}
