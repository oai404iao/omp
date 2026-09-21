import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConstrainedSamplingConfig } from "@earendil-works/pi-ai";
import { LIMITS } from "./limits.ts";
import type { ExecOptions } from "./session.ts";

export const TRANSPORT_DISCOVER = "@oai404iao/pi-code-mode:transport/v1";
export const TRANSPORT_DISCOVER_V2 = "@oai404iao/pi-code-mode:transport/v2";
export const TRANSCRIPT_SEMANTICS = Object.freeze(["sections", "tool-removal", "tool-redefinition", "forced-prompt", "compaction-checkpoint", "exec-history"]);
export interface TransportCapability {
	readonly stream: unknown;
	readonly input: "pi-transcript/1";
	readonly formats: readonly ("json" | "grammar")[];
	readonly projection: "effective-checkpoint" | "transcript-deltas";
	readonly semantics: readonly string[];
}
export type ProtocolMode = "json" | "auto" | "grammar";
export const EXEC_SAMPLING: ConstrainedSamplingConfig = {
	type: "grammar", variants: { openai_lark: "start: SOURCE\nSOURCE: /[\\s\\S]+/\n" },
};
const optionNames = ["yield_time_ms", "timeout_ms", "max_tokens"] as const;
type ExecInput = ExecOptions & { code: string };
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Code Mode arguments must be an object");
	return value as Record<string, unknown>;
}
function options(value: unknown): ExecOptions {
	const input = record(value);
	const result: ExecOptions = {};
	for (const [key, val] of Object.entries(input)) {
		if (!optionNames.includes(key as typeof optionNames[number])) throw new Error(`Unknown exec option: ${key}`);
		if (val === undefined) continue;
		const min = key === "yield_time_ms" ? 0 : 1;
		const max = key === "yield_time_ms" ? LIMITS.observeMs : key === "timeout_ms" ? LIMITS.executionMs : 8192;
		if (!Number.isSafeInteger(val) || (val as number) < min || (val as number) > max) throw new Error(`Invalid exec option: ${key}`);
		result[key as keyof ExecOptions] = val as number;
	}
	return result;
}
function splitSource(code: string): { code: string; options: ExecOptions; pragma: boolean } {
	if (!code.trim() || Buffer.byteLength(code) > LIMITS.codeBytes) throw new Error("Code must be nonempty and at most 24 KiB, including the exec pragma");
	if (!/^[ \t]*\/\/ @exec:/.test(code)) return { code, options: {}, pragma: false };
	const end = code.indexOf("\n");
	if (end < 0) throw new Error("The exec pragma must be followed by a newline and JavaScript");
	const header = code.slice(0, end).replace(/^[ \t]*\/\/ @exec:[ \t]*/, "").trim();
	const body = code.slice(end + 1);
	if (!body.trim()) throw new Error("The exec pragma requires a nonempty JavaScript body");
	let value: unknown;
	try { value = JSON.parse(header); } catch { throw new Error("The exec pragma must contain a JSON options object"); }
	return { code: body, options: options(value), pragma: true };
}
export function decodeExec(input: unknown): ExecInput {
	const args = record(input);
	if (typeof args.code !== "string") throw new Error("Code Mode requires string argument code");
	const { code: _code, ...outer } = args;
	const explicit = options(outer);
	const source = splitSource(args.code);
	for (const name of optionNames) {
		if (explicit[name] !== undefined && source.options[name] !== undefined && explicit[name] !== source.options[name])
			throw new Error(`Conflicting exec pragma and JSON option: ${name}`);
	}
	return { code: source.code, ...source.options, ...explicit };
}
export function encodeExec(input: unknown): string {
	const args = record(input);
	const normalized = decodeExec(input);
	const source = splitSource(args.code as string);
	const { code, ...controls } = normalized;
	if (optionNames.every((name) => controls[name] === source.options[name])) return args.code as string;
	const encoded = `// @exec: ${JSON.stringify(controls)}\n${code}`;
	if (Buffer.byteLength(encoded) > LIMITS.codeBytes) throw new Error("Canonical exec input exceeds 24 KiB");
	return encoded;
}
export function protocolMode(value: unknown): ProtocolMode {
	if (value === undefined || value === "json") return "json";
	if (value === "auto" || value === "grammar") return value;
	throw new Error("Code Mode protocol must be json, auto or grammar");
}
function compatibleHistory(ctx: ExtensionContext): boolean {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) if (block.type === "toolCall" && block.name === "exec") {
			try { encodeExec(block.arguments); } catch { return false; }
		}
	}
	return true;
}
export function resolveProtocol(pi: ExtensionAPI, ctx: ExtensionContext, mode: ProtocolMode): { grammar: boolean; reason: string } {
	if (mode === "json") return { grammar: false, reason: "explicit JSON" };
	const model = ctx.model;
	if (!model || !["openai-responses", "openai-codex-responses", "azure-openai-responses", "openai-completions"].includes(model.api)
		|| (model.compat as { supportsOpenAIGrammarTools?: boolean } | undefined)?.supportsOpenAIGrammarTools !== true)
		return { grammar: false, reason: "model/API does not declare grammar support" };
	const override = ctx.modelRegistry.getRegisteredProviderConfig(model.provider)?.streamSimple
		?? ctx.modelRegistry.getRegisteredNativeProvider(model.provider)?.streamSimple;
	if (override) {
		let offers = 0;
		const matches: TransportCapability[] = [];
		let open = true;
		pi.events.emit(TRANSPORT_DISCOVER_V2, { protocol: 2, accept(capability: TransportCapability) {
			if (!open) return;
			if (++offers > 16) return;
			if (capability?.stream === override) matches.push(capability);
		} });
		open = false;
		if (offers > 16 || matches.length > 1) return { grammar: false, reason: "conflicting/oversized transcript transport handshake" };
		if (matches.length) {
			const capability = matches[0];
			if (capability.input !== "pi-transcript/1" || !Array.isArray(capability.formats)
				|| capability.formats.length > 2 || !capability.formats.includes("json") || !capability.formats.includes("grammar")
				|| !["effective-checkpoint", "transcript-deltas"].includes(capability.projection)
				|| !Array.isArray(capability.semantics) || capability.semantics.length > 16
				|| !TRANSCRIPT_SEMANTICS.every((feature) => capability.semantics.includes(feature)))
				return { grammar: false, reason: "active transport lacks required transcript semantics" };
			if (!compatibleHistory(ctx)) return { grammar: false, reason: "exec history contains incompatible arguments; select JSON or a clean branch" };
			return { grammar: true, reason: `declared grammar with ${capability.projection} projection` };
		}
		let accepted = false, count = 0;
		pi.events.emit(TRANSPORT_DISCOVER, { version: 1, accept(stream: unknown) { count++; if (stream === override) accepted = true; } });
		if (!accepted || count > 16) return { grammar: false, reason: "active custom transport has no matching grammar handshake" };
	}
	if (!compatibleHistory(ctx)) return { grammar: false, reason: "exec history contains incompatible arguments; select JSON or a clean branch" };
	return { grammar: true, reason: "declared model capability and supported transport" };
}

/** Projection only: persisted calls/results and cell IDs remain untouched.
 * Encode JSON controls in the raw string so a later grammar provider cannot
 * silently discard them. Already-raw inputs are preserved byte-for-byte. */
export function projectExecHistory(messages: ContextEvent["messages"]): ContextEvent["messages"] {
	return messages.map((message) => {
		if (message.role !== "assistant") return message;
		return { ...message, content: message.content.map((block) => {
			if (block.type !== "toolCall" || block.name !== "exec") return block;
			try { return { ...block, arguments: { code: encodeExec(block.arguments) } }; }
			catch { return block; } // invalid historical calls are never invented/coerced
		}) };
	});
}
