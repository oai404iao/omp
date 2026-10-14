import type { AssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

export const PREVIEW_LIMIT = 240;
const INSPECT_LIMIT = 4096;
type ActivityContent = { summary: string; preview?: string };

/** Bounded presentation only: never mutate the transcript or expose opaque blocks. */
export function activityText(text: string, limit = PREVIEW_LIMIT, multiline = true): string {
	const inspected = text.slice(0, INSPECT_LIMIT).replace(/\r\n/g, "\n");
	const plain = stripTerminalSequences(inspected)
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
	const normalized = (multiline ? plain : plain.replace(/\s+/g, " ")).trim();
	const points = Array.from(normalized);
	const truncated = points.length > limit || text.length > INSPECT_LIMIT;
	return points.slice(0, Math.max(0, limit - (truncated ? 1 : 0))).join("") + (truncated && limit > 0 ? "…" : "");
}

function string(value: unknown): string {
	return typeof value === "string" ? value.slice(0, INSPECT_LIMIT) : "";
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textBlocks(value: unknown): string {
	if (typeof value === "string") return value.slice(0, INSPECT_LIMIT);
	if (!Array.isArray(value)) return "";
	let text = "";
	for (const block of value.slice(0, 64)) {
		const item = object(block);
		if (item.type === "text" && typeof item.text === "string") {
			text += `${text ? "\n" : ""}${item.text.slice(0, INSPECT_LIMIT - text.length)}`;
			if (text.length >= INSPECT_LIMIT) break;
		}
	}
	return text;
}

export function resultPreview(result: unknown): string {
	const value = object(result);
	return activityText(typeof result === "string" ? result : textBlocks(value.content));
}

/** Only known semantic fields are inspected, never arbitrary credential/signature fields. */
export function toolActivity(name: string, args: unknown): ActivityContent {
	const value = object(args);
	const path = activityText(string(value.path ?? value.file_path), 160, false);
	let summary = path;
	let preview = "";
	if (name === "bash" || name === "powershell") {
		preview = string(value.command) ? `${name === "bash" ? "$" : "PS>"} ${string(value.command)}` : "";
		summary = "";
	} else if (name === "write") {
		preview = string(value.content);
	} else if (name === "edit") {
		const edits = Array.isArray(value.edits) ? value.edits : [value];
		const first = object(edits[0]);
		summary = path + (edits.length > 1 ? ` · ${edits.length} replacements` : "");
		preview = `- ${activityText(string(first.oldText), 110)}\n+ ${activityText(string(first.newText), 110)}`;
		if (!first.oldText && !first.newText) preview = "";
	} else if (name === "apply_patch") {
		const lines = string(value.input).split("\n");
		const headers = lines.filter(line => /^\*\*\* (?:Add|Update|Delete) File: |^\*\*\* Move to: /.test(line));
		summary = activityText(headers.slice(0, 3).map(line => line.replace(/^\*\*\* /, "")).join(" · "), 160, false);
		preview = lines.filter(line => /^[+-]/.test(line) || /^@@/.test(line)).slice(0, 8).join("\n");
		if (!preview) preview = headers.join("\n") || string(value.input);
	} else if (!["read", "ls", "find", "grep"].includes(name)) {
		// Unknown tools use a conservative field allowlist, not a raw args dump.
		for (const key of ["command", "query", "pattern", "url", "message", "input"]) {
			if (typeof value[key] === "string") { preview = string(value[key]); break; }
		}
		if (!summary) summary = activityText(preview, 160, false);
	} else if (name === "grep" || name === "find") {
		preview = string(value.pattern);
	}
	const safe = activityText(preview);
	return { summary, ...(safe ? { preview: safe } : {}) };
}

export function responseActivity(message: AssistantMessage): ActivityContent {
	const text = textBlocks(message.content);
	const calls = message.content.slice(0, 64).filter(block => block.type === "toolCall").slice(0, 5).map(block => block.name);
	const fallback = calls.length ? `Requested ${calls.join(", ")}` :
		message.errorMessage ? message.errorMessage : message.stopReason === "pending" ? "Generating response…" : "No text response";
	return { summary: activityText(text || fallback, 160, false), preview: activityText(text || fallback) };
}

export function toolResultActivity(input: ActivityContent, result: unknown, isError = false): ActivityContent {
	const output = resultPreview(result);
	return {
		summary: input.summary,
		preview: activityText(isError && output ? output : [input.preview, output ? `› ${output}` : ""].filter(Boolean).join("\n")),
	};
}
