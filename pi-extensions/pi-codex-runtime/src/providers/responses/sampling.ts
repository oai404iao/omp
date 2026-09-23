import type { Tool } from "@earendil-works/pi-ai";

export interface GrammarInputBuffer { input: string; started: boolean; closed: boolean }
export interface GrammarSampling { format: "lark" | "regex"; definition: string; inputProperty: string }

// Pi's extension loader aliases SDK roots to files, so api/* subpath imports
// do not resolve in production extensions. Implement the small wire contract
// locally rather than resolving private SDK dist paths.
export function resolveGrammarSampling(tool: Tool, supported: boolean): GrammarSampling | undefined {
	const sampling = tool.constrainedSampling;
	if (!supported || !sampling || sampling.type !== "grammar") return undefined;
	const schema = tool.parameters as { type?: unknown; required?: unknown; properties?: Record<string, { type?: unknown }> };
	const required = schema.required;
	if (schema.type !== "object" || !Array.isArray(required) || required.length !== 1
		|| typeof required[0] !== "string" || schema.properties?.[required[0]]?.type !== "string") {
		throw new Error(`Tool ${tool.name} grammar requires exactly one required string property`);
	}
	for (const [variant, format] of [["openai_lark", "lark"], ["openai_regex", "regex"]] as const) {
		const definition = sampling.variants[variant];
		if (typeof definition === "string" && definition.trim()) return { format, definition, inputProperty: required[0] };
	}
	throw new Error(`Tool ${tool.name} has no supported grammar variant`);
}
export function grammarToolInput(name: string, args: Record<string, unknown>, property: string): string {
	const value = args[property];
	if (typeof value !== "string") throw new Error(`Grammar tool ${name} requires string argument ${property}`);
	return value;
}
export function grammarInputDelta(buffer: GrammarInputBuffer, property: string, next: string, close: boolean): string | undefined {
	if (buffer.closed) {
		if (next !== buffer.input) throw new Error("Grammar input changed after it was closed");
		return undefined;
	}
	if (!next.startsWith(buffer.input)) throw new Error("Grammar input is not monotonic");
	const suffix = JSON.stringify(next.slice(buffer.input.length)).slice(1, -1);
	const delta = (buffer.started ? "" : `{${JSON.stringify(property)}:"`) + suffix + (close ? '"}' : "");
	buffer.input = next;
	buffer.started = true;
	buffer.closed = close;
	return delta || undefined;
}
