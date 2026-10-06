import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export function renderAgentCall(name: string, args: Record<string, unknown>, theme: Theme): Text {
	const target = args.task_name ?? args.target ?? args.path_prefix ?? "";
	const heading = theme.fg("toolTitle", theme.bold(`${name} ${target}`.trim()));
	const message = typeof args.message === "string" ? args.message.replace(/\s+/g, " ").slice(0, 160) : "";
	return new Text(heading + (message ? `\n${theme.fg("muted", message)}` : ""), 0, 0);
}

export function renderAgentResult(content: Array<{ type: string; text?: string }>, expanded: boolean, theme: Theme): Text {
	const text = content.filter(item => item.type === "text").map(item => item.text ?? "").join("\n");
	let display = text;
	try {
		const value = JSON.parse(text);
		if (Array.isArray(value.agents)) {
			display = value.agents.map((agent: { agent_name: string; agent_status: string }) =>
				`${agent.agent_name} [${agent.agent_status}]`).join("\n");
		} else if (typeof value.task_name === "string") display = `Started ${value.task_name}`;
	} catch { /* Partial results need not be JSON. */ }
	const lines = display.split("\n");
	return new Text(theme.fg("toolOutput", expanded ? display :
		lines.slice(0, 8).join("\n") + (lines.length > 8 ? "\n…" : "")), 0, 0);
}

export function renderAgentMessage(content: string, expanded: boolean, theme: Theme): Text {
	const lines = content.split("\n");
	return new Text(theme.fg("toolOutput", expanded ? content :
		lines.slice(0, 6).join("\n") + (lines.length > 6 ? "\n…" : "")), 0, 0);
}
