import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue, Usage } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import type { CodeModeTool, CodeModePolicy, InvocationContext, PolicyCall } from "./contributions.ts";
import { frozen } from "./catalog.ts";
import { Scheduler } from "./scheduler.ts";
import { UnsettledEffect } from "./process.ts";
import { LIMITS, errorText } from "./limits.ts";

export interface Trace { id: string; name: string; state: "queued" | "running" | "completed" | "failed" | "cancelled" }
export function jsonValue(value: unknown): JsonValue {
	let nodes = 0;
	const seen = new Set<unknown>();
	const check = (item: unknown, depth: number): void => {
		if (++nodes > 10000 || depth > 64) throw new Error("Tool result complexity budget exceeded");
		if (item === null || typeof item === "boolean") return;
		if (typeof item === "number" && Number.isFinite(item)) return;
		if (typeof item === "string" && Buffer.byteLength(item) <= LIMITS.resultBytes) return;
		if (typeof item !== "object" || !item || seen.has(item)) throw new Error("Tool values must be finite, acyclic JSON");
		if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("Tool values must be plain JSON");
		seen.add(item);
		for (const [key, child] of Object.entries(item)) {
			if (Buffer.byteLength(key) > LIMITS.resultBytes) throw new Error("Tool key budget exceeded");
			check(child, depth + 1);
		}
		seen.delete(item);
	};
	check(value, 0);
	const text = JSON.stringify(value);
	if (Buffer.byteLength(text) > LIMITS.resultBytes) throw new Error("Tool result byte budget exceeded");
	return JSON.parse(text) as JsonValue;
}
async function policyWork<T>(run: (signal: AbortSignal) => T | Promise<T>, outer: AbortSignal): Promise<T> {
	const signal = AbortSignal.any([outer, AbortSignal.timeout(LIMITS.policyMs)]);
	signal.throwIfAborted();
	let abort!: () => void;
	try {
		return await Promise.race([Promise.resolve().then(() => run(signal)), new Promise<never>((_, reject) => {
			abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
		})]);
	} finally { signal.removeEventListener("abort", abort); }
}

export class ToolBridge {
	private scheduler = new Scheduler();
	private count = 0;
	readonly traces: Trace[] = [];
	unsettled?: Error;
	constructor(
		readonly tools: readonly CodeModeTool[],
		private policies: readonly CodeModePolicy[],
		private cellId: string, private cwd: string,
		private signal: AbortSignal, private getContext: () => ExtensionContext | undefined,
		private account: (usage?: Usage) => void,
		private fatal: (error: Error) => void,
	) {}

	invoke(name: string, input: unknown, id: string, callSignal: AbortSignal): Promise<unknown> {
		if (++this.count > LIMITS.calls) return Promise.reject(new Error("Code Mode call budget exceeded"));
		const tool = this.tools.find((item) => item.name === name);
		if (!tool) return Promise.reject(new Error("Tool is not authorized for this cell"));
		const signal = AbortSignal.any([this.signal, callSignal]);
		const trace: Trace = { id, name, state: "queued" };
		this.traces.push(trace);
		const execute = async () => {
			trace.state = "running";
			const rawContext = this.getContext();
			const context: InvocationContext = Object.freeze({
				cellId: this.cellId, toolCallId: id, cwd: this.cwd, signal,
				pi: rawContext ? { ...rawContext, signal } : undefined,
			});
			const args = frozen(structuredClone(tool.prepare ? tool.prepare(input) : input));
			if (!Check(tool.parameters, args)) throw new Error("Invalid nested tool arguments");
			const call: PolicyCall = Object.freeze({ name, effect: tool.effect, input: args, context });
			for (const policy of this.policies) {
				if (!policy.before) continue;
				const decision = await policyWork((policySignal) => policy.before!({
					...call, context: { ...context, signal: policySignal, pi: rawContext ? { ...rawContext, signal: policySignal } : undefined },
				}), signal);
				if (decision?.block) throw new Error(decision.reason ?? "Code Mode policy denied the call");
			}
			signal.throwIfAborted();
			const result = await tool.invoke(args, context);
			this.account(result?.usage);
			if (!result || !("value" in result) || Object.keys(result).some((key) => !["value", "usage"].includes(key))) {
				throw new Error("Contribution result must be {value,usage?}; Pi terminate/addedToolNames controls must stay direct");
			}
			let value = jsonValue(result.value);
			for (const policy of this.policies) {
				if (policy.after) value = jsonValue(await policyWork((policySignal) => policy.after!({
					...call, context: { ...context, signal: policySignal, pi: rawContext ? { ...rawContext, signal: policySignal } : undefined },
				}, frozen(structuredClone(value))), signal));
			}
			signal.throwIfAborted();
			trace.state = "completed";
			return value;
		};
		return this.scheduler.run(!(tool.effect === "read" && tool.parallel === true), signal, async () => {
			try { return await execute(); }
			catch (error) {
				// Must happen BEFORE Scheduler releases the exclusive slot/pumps.
				if (error instanceof UnsettledEffect) {
					this.unsettled = error;
					this.scheduler.stop(error);
					this.fatal(error);
				}
				throw error;
			}
		}).catch((error) => {
			trace.state = signal.aborted ? "cancelled" : "failed";
			throw new Error(errorText(error));
		});
	}
	stop(error?: Error): void { this.scheduler.stop(error); }
	async settled(): Promise<void> { await this.scheduler.settled(); }
	get calls(): number { return this.count; }
	get peak(): number { return this.scheduler.peak; }
}
