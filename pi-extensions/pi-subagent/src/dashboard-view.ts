import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { DashboardAgent, DashboardSnapshot } from "./dashboard-types.ts";

export const AGENT_ROW_HEIGHT = 5;

/** Treat transcript/role text as data, never terminal instructions or hyperlinks. */
export function dashboardText(text: string, multiline = false): string {
	const plain = stripTerminalSequences(text.replace(/\r\n/g, "\n"))
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
	return multiline ? plain : plain.replace(/\s+/g, " ").trim();
}

export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function tail(text: string, width: number): string {
	if (width <= 0) return "";
	const length = visibleWidth(text);
	return length <= width ? text : `…${sliceByColumn(text, length - width + 1, width - 1, true)}`;
}

function count(value: number, compact = false): string {
	if (!Number.isFinite(value) || value < 0) return "—";
	if (!compact) return Math.round(value).toLocaleString("en-US");
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(Math.round(value));
}

function cost(value: number | null): string {
	if (value === null || !Number.isFinite(value) || value < 0) return "—";
	return value > 0 && value < 0.001 ? "~<$0.001" : `~$${value.toFixed(3)}`;
}

function duration(milliseconds: number): string {
	const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
}

export function agentDuration(agent: DashboardAgent, now: number): string {
	if (agent.durationMs === undefined && agent.activeSince === undefined) return "—";
	const active = agent.activeSince === undefined ? 0 : Math.max(0, now - agent.activeSince);
	const total = (agent.durationMs ?? 0) + active;
	return Number.isFinite(total) ? `${agent.durationPartial ? "≥" : ""}${duration(total)}` : "—";
}

const pad = (n: number) => String(n).padStart(2, "0");
function time(timestamp: number): string {
	const date = new Date(timestamp);
	return Number.isFinite(timestamp) ? `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` : "—";
}

function created(value: string | number, full = false): string {
	const stamp = typeof value === "number" ? value : Date.parse(value);
	if (!Number.isFinite(stamp)) return "—";
	const date = new Date(stamp);
	if (!Number.isFinite(date.getTime())) return "—";
	const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	const offset = -date.getTimezoneOffset();
	const zone = `${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
	return full ? `${day} ${time(stamp)} ${zone}` : time(stamp);
}

const STATUS: Record<DashboardAgent["status"], { text: string; color: ThemeColor }> = {
	pending_init: { text: "○ Starting", color: "muted" },
	running: { text: "● Running", color: "accent" },
	completed: { text: "✓ Completed", color: "success" },
	interrupted: { text: "■ Interrupted", color: "warning" },
	errored: { text: "! Errored", color: "error" },
};

function status(agent: DashboardAgent, theme: Theme): string {
	const value = STATUS[agent.status];
	return theme.fg(value.color, value.text);
}

export function dashboardSummary(snapshot: DashboardSnapshot): [string, string] {
	const agents = snapshot.agents;
	const known = agents.filter(agent => agent.usage.available);
	const priced = known.filter(agent => agent.usage.cost !== null);
	const total = (key: "requests" | "tools" | "totalTokens") =>
		known.length || !agents.length ? count(known.reduce((sum, agent) => sum + agent.usage[key], 0), true) : "—";
	const amount = priced.length || !agents.length ? cost(priced.reduce((sum, agent) => sum + (agent.usage.cost ?? 0), 0)) : "—";
	const partial = known.length !== agents.length || priced.length !== agents.length;
	return [
		`Current session · ${agents.length} agents · ${snapshot.activeCount}/${snapshot.maxConcurrentAgents} active` +
		` · ${agents.filter(agent => agent.status === "completed").length} completed` +
		` · ${agents.filter(agent => agent.status === "errored").length} errored`,
		`Est. ${amount} · ${total("requests")} req · ${total("tools")} tools · ${total("totalTokens")} tokens` +
		(partial ? " · partial data" : ""),
	];
}

export function renderAgentRows(
	snapshot: DashboardSnapshot, selected: string | undefined, width: number, theme: Theme, now: number,
	durations?: ReadonlyMap<string, string>,
): string[] {
	if (!snapshot.agents.length) {
		return ["No subagents in this session.", "", "Use spawn_agent to start a task.", "/subagents catalog shows available roles."]
			.map(line => fit(theme.fg("muted", line), width));
	}
	return snapshot.agents.flatMap(agent => {
		const picked = agent.path === selected;
		const label = STATUS[agent.status].text;
		const typeWidth = Math.min(14, Math.max(0, Math.floor(width / 5)));
		const pathWidth = Math.max(1, width - visibleWidth(label) - typeWidth - 6);
		const path = tail(dashboardText(agent.path), pathWidth);
		const first = `${picked ? "›" : " "} ${theme.fg(picked ? "accent" : "text", fit(path, pathWidth))}` +
			` ${theme.fg("muted", fit(dashboardText(agent.type), typeWidth))}  ${status(agent, theme)}`;
		const usage = agent.usage;
		const metric = (value: number) => usage.available ? count(value, true) : "—";
		const lines = [
			first,
			`  ${dashboardText(agent.topic) || "No task topic available"}`,
			`  ${usage.available ? cost(usage.cost) : "—"} · ${durations?.get(agent.path) ?? agentDuration(agent, now)} · ${metric(usage.requests)} req` +
				` · ${metric(usage.tools)} tools · ${metric(usage.totalTokens)} tok`,
			theme.fg("muted", `  ${created(agent.createdAt)}` +
				(agent.dataError ? " · partial data" : "")),
			"",
		];
		return lines.map((line, index) => {
			const padded = fit(line, width);
			return picked && index < AGENT_ROW_HEIGHT - 1 ? theme.bg("selectedBg", padded) : padded;
		});
	});
}

export function renderAgentDetails(
	agent: DashboardAgent | undefined, width: number, theme: Theme, now: number, taskExpanded = false,
): string[] {
	if (!agent) return [fit(theme.fg("muted", "Select an agent to see details."), width)];
	const lines: string[] = [];
	const heading = (text: string) => { lines.push(theme.fg("accent", theme.bold(text))); };
	const field = (name: string, value: string, maxLines = Infinity) => {
		const prefix = `${name.padEnd(Math.min(12, Math.max(1, width - 8)))} `;
		const available = Math.max(1, width - visibleWidth(prefix));
		let wrapped = wrapTextWithAnsi(value, available);
		if (wrapped.length > maxLines) wrapped = [...wrapped.slice(0, maxLines - 1), "… Enter to expand task"];
		for (let i = 0; i < wrapped.length; i++) {
			lines.push((i === 0 ? theme.fg("muted", prefix) : " ".repeat(visibleWidth(prefix))) + wrapped[i]);
		}
	};
	const plainField = (name: string, value: string) => field(name, dashboardText(value, true) || "—");
	heading("AGENT INFO");
	plainField("Path", agent.path);
	field("Type", `${dashboardText(agent.type)} · ${status(agent, theme)}`);
	plainField("Parent", agent.parentPath);
	plainField("Model", `${agent.model} · ${agent.thinkingLevel}`);
	field("Created", created(agent.createdAt, true));
	field("Task", dashboardText(agent.task || agent.topic, true) || "—", taskExpanded ? Infinity : 3);
	if (agent.error) field("Error", theme.fg("error", dashboardText(agent.error, true)));
	if (agent.dataError) field("Data", theme.fg("warning", dashboardText(agent.dataError, true)));
	lines.push("");
	heading("USAGE");
	const context = agent.context;
	if (context) {
		const percent = context.percent;
		if (context.tokens === null || percent === null || !Number.isFinite(percent)) {
			field("Context", "— · waiting for next response");
		} else {
			const size = Math.min(16, Math.max(3, width - 25));
			const used = Math.round(Math.min(100, Math.max(0, percent)) * size / 100);
			field("Context", `${theme.fg("accent", "█".repeat(used))}${theme.fg("dim", "░".repeat(size - used))} ~${percent.toFixed(0)}%`);
			field("", `~${count(context.tokens, true)} / ${count(context.contextWindow, true)} tokens`);
		}
	} else field("Context", "— · no snapshot");
	field("Cost / time", `${agent.usage.available ? cost(agent.usage.cost) : "—"} · ${agentDuration(agent, now)}` +
		(agent.durationPartial ? " · partial" : ""));
	if (agent.usage.available && agent.usage.cost === null) field("", "Price unavailable");
	const usage = agent.usage;
	const metric = (value: number) => usage.available ? count(value) : "—";
	field("Requests", `${metric(usage.requests)} model rounds · ${metric(usage.tools)} top-level tools`);
	if (usage.nestedTools || usage.nestedToolsPartial || !usage.available) {
		field("Nested tools", `${metric(usage.nestedTools)}${usage.nestedToolsPartial ? " · partial" : ""}`);
	}
	if (width >= 48) field("Tokens", `Input ${metric(usage.input)} · Output ${metric(usage.output)}`);
	else { field("Input", metric(usage.input)); field("Output", metric(usage.output)); }
	if (usage.reasoning !== undefined) field("↳ Reasoning", `${metric(usage.reasoning)} · included in output`);
	if (width >= 48) field("Cache", `Read ${metric(usage.cacheRead)} · Write ${metric(usage.cacheWrite)}`);
	else { field("Cache read", metric(usage.cacheRead)); field("Cache write", metric(usage.cacheWrite)); }
	field("Total", metric(usage.totalTokens));
	if (!usage.available) lines.push(theme.fg("warning", "Usage unavailable; not zero."));
	lines.push("");
	heading("RECENT ACTIVITY");
	if (!agent.activity.length) lines.push(theme.fg("muted", "No recorded activity yet."));
	const icons = { running: "●", success: "✓", error: "!", interrupted: "■", info: "·" };
	for (const entry of [...agent.activity].sort((a, b) => b.timestamp - a.timestamp)) {
		const color = entry.status === "error" ? "error" : entry.status === "success" ? "success" :
			entry.status === "interrupted" ? "warning" : entry.status === "running" ? "accent" : "muted";
		const summary = entry.kind === "response" && entry.preview ? "" : dashboardText(entry.summary);
		lines.push(`${theme.fg("muted", time(entry.timestamp))} ${theme.fg(color, icons[entry.status])} ` +
			`${dashboardText(entry.label)}${summary ? ` ${theme.fg("muted", summary)}` : ""}`);
		if (entry.preview) {
			const wrapped = wrapTextWithAnsi(dashboardText(entry.preview, true), Math.max(1, width - 2));
			const preview = wrapped.slice(0, 3);
			if (wrapped.length > 3) preview[2] = truncateToWidth(preview[2], Math.max(1, width - 3), "") + "…";
			lines.push(...preview.map(line => `  ${theme.fg("muted", line)}`));
		}
	}
	return lines.map(line => fit(line, width));
}
