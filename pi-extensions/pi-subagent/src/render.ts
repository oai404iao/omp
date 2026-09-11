import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { DelegationDetails, ParentMessageDetails } from "./types.ts";
import { formatUsage } from "./result.ts";

export function renderDelegationCall(
	args: {
		agent?: string;
		task_name?: string;
		description?: string;
		prompt?: string;
		context?: { mode?: string };
	},
	theme: {
		fg(color: any, text: string): string;
		bold(text: string): string;
	},
	provider: "spawn" | "fork",
	runtimeMode: "foreground" | "background" = "background",
): Text {
	const contextMode = provider === "fork" ? "all_completed" : (args.context?.mode ?? "fresh");
	const mode = `${contextMode} · ${runtimeMode}`;
	let text =
		theme.fg("toolTitle", theme.bold(provider === "fork" ? "subagent_fork " : "subagent ")) +
		theme.fg("accent", args.agent ?? "…") +
		theme.fg("muted", ` [${mode}]`);
	if (args.description) text += `\n  ${theme.fg("dim", args.description)}`;
	if (args.task_name) text += `\n  ${theme.fg("dim", `path: ${args.task_name}`)}`;
	return new Text(text, 0, 0);
}

export function renderDelegationResult(
	details: DelegationDetails | undefined,
	content: string,
	options: { expanded: boolean; isPartial: boolean },
	theme: {
		fg(color: any, text: string): string;
		bold(text: string): string;
	},
): Text | Container {
	if (!details) return new Text(content || "(no output)", 0, 0);
	const taskPath = details.taskPath || details.agentId;
	const contextMode =
		details.context?.mode
		?? (details.provider === "fork" ? "all_completed" : "fresh");
	const running = options.isPartial || details.status === "starting" || details.status === "running";
	const icon = running
		? theme.fg("warning", "◌")
		: details.status === "failed"
			? theme.fg("error", "✗")
			: theme.fg("success", "✓");
	const header = `${icon} ${theme.fg("toolTitle", theme.bold(details.agent))} ${theme.fg(
		"muted",
		`[${details.provider}/${details.mode}/${contextMode}]`,
	)} ${theme.fg("accent", taskPath)} ${theme.fg("dim", details.agentId)}`;

	if (!options.expanded) {
		const lines = [header, theme.fg("muted", details.label)];
		const trace = details.trace.slice(-5);
		for (const item of trace) {
			const prefix = item.type === "tool" ? "→ " : "";
			const preview = item.text.split("\n").slice(0, 2).join("\n");
			lines.push(theme.fg(item.type === "tool" ? "muted" : "toolOutput", `${prefix}${preview}`));
		}
		if (details.usage) lines.push(theme.fg("dim", formatUsage(details.usage)));
		if (details.sessionFile) lines.push(theme.fg("dim", `session: ${details.sessionFile}`));
		return new Text(lines.join("\n"), 0, 0);
	}

	const container = new Container();
	container.addChild(new Text(header, 0, 0));
	container.addChild(new Text(theme.fg("muted", `Task: ${details.label}`), 0, 0));
	if (details.trace.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Activity ───"), 0, 0));
		for (const item of details.trace) {
			if (item.type === "tool") container.addChild(new Text(theme.fg("muted", `→ ${item.text}`), 0, 0));
		}
	}
	if (details.output) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
		container.addChild(new Markdown(details.output, 0, 0, getMarkdownTheme()));
	}
	if (details.usage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", formatUsage(details.usage)), 0, 0));
	}
	if (details.sessionFile) container.addChild(new Text(theme.fg("dim", `session: ${details.sessionFile}`), 0, 0));
	return container;
}

export function renderParentMessage(
	content: string,
	details: ParentMessageDetails | undefined,
	expanded: boolean,
	outputPad: number,
	theme: {
		fg(color: any, text: string): string;
		bold(text: string): string;
	},
): Text | Markdown {
	if (expanded) return new Markdown(content, outputPad, 0, getMarkdownTheme());
	const label = details?.label ? ` — ${details.label}` : "";
	return new Text(
		theme.fg("accent", "●") +
			" " +
			theme.fg("toolTitle", theme.bold("subagent report")) +
			theme.fg(
				"muted",
				` ${details?.taskPath ?? details?.childAgentId ?? "unknown"}${label}`,
			),
		outputPad,
		0,
	);
}
