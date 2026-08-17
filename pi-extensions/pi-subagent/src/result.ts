import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { SubagentStopReason, SubagentUsage } from "./types.ts";

export interface TruncatedText {
	text: string;
	truncated: boolean;
	omittedBytes: number;
}

export function truncateUtf8(input: string, maxBytes: number): TruncatedText {
	const totalBytes = Buffer.byteLength(input, "utf8");
	if (totalBytes <= maxBytes) return { text: input, truncated: false, omittedBytes: 0 };
	const buffer = Buffer.from(input, "utf8");
	let end = Math.min(maxBytes, buffer.length);
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	const text = buffer.subarray(0, end).toString("utf8");
	return { text, truncated: true, omittedBytes: totalBytes - Buffer.byteLength(text, "utf8") };
}

export function emptyUsage(): SubagentUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
		turns: 0,
	};
}

export function addUsage(target: SubagentUsage, usage: Usage, countTurn = true): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.cost.input += usage.cost.input;
	target.cost.output += usage.cost.output;
	target.cost.cacheRead += usage.cost.cacheRead;
	target.cost.cacheWrite += usage.cost.cacheWrite;
	target.cost.total += usage.cost.total;
	if (countTurn) target.turns++;
}

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
}

export function finalAssistantText(messages: readonly AgentMessage[], startIndex: number, streamedFallback = ""): string {
	for (let index = messages.length - 1; index >= startIndex; index--) {
		const text = assistantText(messages[index]);
		if (text.trim().length > 0) return text;
	}
	return streamedFallback;
}

export function finalStopReason(
	messages: readonly AgentMessage[],
	startIndex: number,
	fallback: SubagentStopReason = "error",
): SubagentStopReason {
	for (let index = messages.length - 1; index >= startIndex; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		switch (message.stopReason) {
			case "stop":
				return "completed";
			case "length":
				return "max-tokens";
			case "aborted":
				return "aborted";
			case "error":
				return "error";
			case "toolUse":
			case "pending":
				return fallback;
			default:
				return fallback;
		}
	}
	return fallback;
}

export function formatUsage(usage: SubagentUsage): string {
	const parts = [`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
	return parts.join(" ");
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatToolArguments(name: string, args: Record<string, unknown>): string {
	if (name === "bash" && typeof args.command === "string") {
		return `$ ${singleLine(args.command, 100)}`;
	}
	const path = args.path ?? args.file_path;
	if (typeof path === "string" && ["read", "write", "edit", "ls"].includes(name)) {
		return `${name} ${singleLine(path, 100)}`;
	}
	if (name === "grep" && typeof args.pattern === "string") {
		return `grep /${singleLine(args.pattern, 60)}/`;
	}
	const encoded = JSON.stringify(args);
	return `${name} ${singleLine(encoded, 100)}`;
}

function singleLine(value: string, limit: number): string {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length > limit ? `${line.slice(0, limit)}…` : line;
}
