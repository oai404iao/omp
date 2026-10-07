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
