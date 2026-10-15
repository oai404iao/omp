import type { Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCodexBroker } from "@oai404iao/pi-codex-runtime/internal/broker";
import { snapshotOwnedToolProtocols } from "@oai404iao/pi-codex-runtime/internal/tool-activation";

export function hasProjectedToolLoadout(pi: ExtensionAPI): boolean {
	return (pi.getActiveTools?.() ?? []).some(name => name === "codemode" || name === "tool_search");
}

export function activeToolSnapshot(pi: ExtensionAPI): Tool[] {
	const active = new Set(pi.getActiveTools?.() ?? []);
	const tools = (pi.getAllTools?.() ?? []).filter(tool => active.has(tool.name));
	if (tools.length === 0) return [];
	const protocols = typeof pi.on === "function" ? snapshotOwnedToolProtocols(pi, getCodexBroker(pi)) : new Map();
	for (const [name, protocol] of protocols) {
		if (!active.has(name)) continue;
		for (const hidden of protocol.hiddenTools ?? []) active.delete(hidden);
	}
	return tools
		.filter(tool => active.has(tool.name))
		.map(({ name, description, parameters }) => ({ name, description, parameters }));
}
