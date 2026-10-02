import type { Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function hasProjectedToolLoadout(pi: ExtensionAPI): boolean {
	return (pi.getActiveTools?.() ?? []).some(name => name === "codemode" || name === "tool_search");
}

export function activeToolSnapshot(pi: ExtensionAPI): Tool[] {
	const active = new Set(pi.getActiveTools?.() ?? []);
	return (pi.getAllTools?.() ?? [])
		.filter(tool => active.has(tool.name))
		.map(({ name, description, parameters }) => ({ name, description, parameters }));
}
