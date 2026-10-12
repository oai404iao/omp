import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export interface AgentRenderDetails {
	agentType?: string;
	agentTypes?: Record<string, string>;
}

export function renderAgentCall(
	name: string, args: Record<string, unknown>, theme: Theme, agentType?: string,
): Text {
	const target = args.task_name ?? args.target ?? args.path_prefix ?? "";
	const heading = theme.fg("toolTitle", theme.bold(`${name} ${target}`.trim()));
	const type = name === "spawn_agent" ? (typeof args.agent_type === "string" ? args.agent_type : "default") : agentType;
	const metadata = name === "list_agents" ? "" :
		`\n${theme.fg("muted", `${name === "wait_agent" ? "Caller Type" : "Type"}: ${type ?? "unknown"}`)}`;
	const timeout = name === "wait_agent" && typeof args.timeout_ms === "number" ?
		`\n${theme.fg("muted", `Timeout: ${args.timeout_ms} ms`)}` : "";
	const message = typeof args.message === "string" ? args.message.replace(/\s+/g, " ").slice(0, 160) : "";
	return new Text(heading + metadata + timeout + (message ? `\n${theme.fg("muted", message)}` : ""), 0, 0);
}

export function renderAgentResult(
	content: Array<{ type: string; text?: string }>, expanded: boolean, theme: Theme,
	details: AgentRenderDetails = {}, callerType = false,
): Text {
	const text = content.filter(item => item.type === "text").map(item => item.text ?? "").join("\n");
	let display = text;
	try {
		const value = JSON.parse(text);
		if (Array.isArray(value.agents)) {
			display = value.agents.map((agent: { agent_name: string; agent_status: string }) =>
				`${agent.agent_name} [${agent.agent_status}] · Type: ${details.agentTypes?.[agent.agent_name] ?? "unknown"}`).join("\n");
		} else if (typeof value.task_name === "string") display = `Started ${value.task_name}`;
	} catch { /* Partial results need not be JSON. */ }
	if (details.agentType) display = `${callerType ? "Caller Type" : "Type"}: ${details.agentType}\n${display}`;
	const lines = display.split("\n");
	return new Text(theme.fg("toolOutput", expanded ? display :
		lines.slice(0, 8).join("\n") + (lines.length > 8 ? "\n…" : "")), 0, 0);
}

export function renderAgentMessage(content: string, expanded: boolean, theme: Theme): Text {
	const lines = content.split("\n");
	return new Text(theme.fg("toolOutput", expanded ? content :
		lines.slice(0, 6).join("\n") + (lines.length > 6 ? "\n…" : "")), 0, 0);
}
