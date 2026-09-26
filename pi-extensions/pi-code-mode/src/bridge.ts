import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue, Usage } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import type { CodeModeTool, CodeModePolicy, CodeModeObserver, CodeModeApproval, InvocationContext, PolicyCall } from "./contributions.ts";
import { ApprovalQueue } from "./approvals.ts";
import { frozen } from "./catalog.ts";
import { Scheduler } from "./scheduler.ts";
import { isUnsettledEffect, unsettledEffect } from "./errors.ts";
import { LIMITS, errorText } from "./limits.ts";
import { observeCompletion } from "./observers.ts";

export interface Trace {
	id: string; name: string; state: "queued" | "awaiting_approval" | "running" | "completed" | "failed" | "cancelled";
	queuedAt: number; startedAt?: number; settledAt?: number;
}
export interface BridgeDiagnostics {
	origin?: string; epoch?: number; observers?: readonly CodeModeObserver[];
	approvals?: readonly CodeModeApproval[]; approvalQueue?: ApprovalQueue;
	scheduler?: Scheduler;
}
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
async function policyWork<T>(run: (signal: AbortSignal) => T | Promise<T>, outer: AbortSignal, interrupt: (error: unknown) => void): Promise<T> {
	const signal = AbortSignal.any([outer, AbortSignal.timeout(LIMITS.policyMs)]);
	signal.throwIfAborted();
	const abort = () => interrupt(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	try {
		// Interrupt delivery promptly, but retain the actual hook in the invocation
		// lifetime (and any exclusive slot) until its cleanup really settles.
		const value = await run(signal);
		signal.throwIfAborted();
		return value;
	} finally { signal.removeEventListener("abort", abort); }
}

export class ToolBridge {
	private scheduler: Scheduler;
	private running = 0;
	private peakCount = 0;
	private preflight = new AbortController();
	private tasks = new Set<Promise<unknown>>();
	private approvalTasks = new Set<Promise<void>>();
	private approvalQueue: ApprovalQueue;
	private count = 0;
	readonly traces: Trace[] = [];
	observerFailures = 0;
	unsettled?: Error;
	constructor(
		readonly tools: readonly CodeModeTool[],
		private policies: readonly CodeModePolicy[],
		private cellId: string, private cwd: string,
		private signal: AbortSignal, private getContext: () => ExtensionContext | undefined,
		private account: (usage?: Usage) => void,
		private fatal: (error: Error) => void,
		private diagnostics: BridgeDiagnostics = {},
	) {
		this.approvalQueue = diagnostics.approvalQueue ?? new ApprovalQueue();
		this.scheduler = diagnostics.scheduler ?? new Scheduler();
	}
	private failUnsettled(error: unknown): void {
		if (!isUnsettledEffect(error) || this.unsettled) return;
		this.unsettled = unsettledEffect(error.message);
		// Close shared admission BEFORE aborting preflight can pump queued work.
		this.scheduler.stop(this.unsettled);
		this.stop(this.unsettled);
		this.fatal(this.unsettled);
	}
	private async ownerWork<T>(run: () => T | Promise<T>): Promise<T> {
		try { return await run(); }
		catch (error) { this.failUnsettled(error); throw error; }
	}
	get origin(): string | undefined { return this.diagnostics.origin; }
	get pendingApprovals(): number { return this.approvalTasks.size; }
	async waitForApprovals(signal?: AbortSignal): Promise<void> {
		const combined = AbortSignal.any([this.signal, ...(signal ? [signal] : [])]);
		if (combined.aborted || !this.approvalTasks.size) return;
		let abort!: () => void;
		try {
			await Promise.race([Promise.allSettled([...this.approvalTasks]), new Promise<void>((resolve) => {
				abort = resolve;
				combined.addEventListener("abort", abort, { once: true });
			})]);
		} finally { combined.removeEventListener("abort", abort); }
	}

	invoke(name: string, input: unknown, id: string, callSignal: AbortSignal): Promise<unknown> {
		if (++this.count > LIMITS.calls) return Promise.reject(new Error("Code Mode call budget exceeded"));
		if (!id || id.length > 128 || name.length > 82) return Promise.reject(new Error("Invalid nested trace identity"));
		const tool = this.tools.find((item) => item.name === name);
		if (!tool) return Promise.reject(new Error("Tool is not authorized for this cell"));
		const signal = AbortSignal.any([this.signal, callSignal]);
		const preflightSignal = AbortSignal.any([signal, this.preflight.signal]);
		const trace: Trace = { id, name, state: "queued", queuedAt: Date.now() };
		this.traces.push(trace);
		let interrupt!: (error: unknown) => void;
		const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
		const execute = async () => {
			preflightSignal.throwIfAborted();
			const rawContext = this.getContext();
			const context: InvocationContext = Object.freeze({
				cellId: this.cellId, toolCallId: id, cwd: this.cwd, signal,
				originToolCallId: this.origin, epoch: this.diagnostics.epoch,
				pi: rawContext ? { ...rawContext, signal } : undefined,
			});
			// Host V1 serializes absent, undefined and top-level null identically.
			// Contributions require object schemas; field-level null stays intact.
			const normalized = input ?? {};
			let args: unknown;
			try { args = frozen(structuredClone(tool.prepare ? tool.prepare(normalized) : normalized)); }
			catch (error) {
				// Synchronous owner failures must stop a sibling invoked immediately
				// afterward, not wait for the outer promise's rejection handler.
				this.failUnsettled(error); throw error;
			}
			if (!Check(tool.parameters, args)) throw new Error("Invalid nested tool arguments");
			const call: PolicyCall = Object.freeze({ name, effect: tool.effect, input: args, context });
			for (const policy of this.policies) {
				if (!policy.before) continue;
				const decision = await policyWork((policySignal) => this.ownerWork(() => policy.before!({
					...call, context: { ...context, signal: policySignal, pi: rawContext ? { ...rawContext, signal: policySignal } : undefined },
				})), preflightSignal, interrupt);
				if (decision?.block) throw new Error(decision.reason ?? "Code Mode policy denied the call");
			}
			const required = [...new Set([tool.approval, ...this.policies.map((p) => p.approval)].filter((id): id is string => id !== undefined))];
			const providers = required.map((id) => {
				const provider = this.diagnostics.approvals?.find((item) => item.id === id);
				if (!provider) throw new Error(`Missing Code Mode approval provider: ${id}`);
				return provider;
			});
			for (const provider of providers) {
				trace.state = "awaiting_approval";
				const pending = this.approvalQueue.request({
					id: provider.id, approve: (call) => this.ownerWork(() => provider.approve(call)),
				}, Object.freeze({ ...call, context: Object.freeze({
					...context, signal: preflightSignal, pi: rawContext ? { ...rawContext, signal: preflightSignal } : undefined,
				}) }));
				this.approvalTasks.add(pending);
				try { await pending; } finally { this.approvalTasks.delete(pending); }
			}
			preflightSignal.throwIfAborted();
			trace.state = "queued";
			return this.scheduler.run(!(tool.effect === "read" && tool.parallel === true), preflightSignal, async () => {
				this.running++; this.peakCount = Math.max(this.peakCount, this.running);
				try {
					preflightSignal.throwIfAborted();
					trace.state = "running";
					trace.startedAt = Date.now();
					const result = await tool.invoke(args, context);
					this.account(result?.usage);
					if (!result || !("value" in result) || Object.keys(result).some((key) => !["value", "usage"].includes(key))) {
						throw new Error("Contribution result must be {value,usage?}; Pi terminate/addedToolNames controls must stay direct");
					}
					let value = jsonValue(result.value);
					for (const policy of this.policies) {
						if (policy.after) value = jsonValue(await policyWork((policySignal) => this.ownerWork(() => policy.after!({
							...call, context: { ...context, signal: policySignal, pi: rawContext ? { ...rawContext, signal: policySignal } : undefined },
						}, frozen(structuredClone(value)))), signal, interrupt));
					}
					signal.throwIfAborted();
					trace.state = "completed";
					return value;
				} catch (error) {
					// Must happen BEFORE Scheduler releases the exclusive slot/pumps.
					this.failUnsettled(error);
					throw error;
				} finally { this.running--; }
			});
		};
		const task = execute().catch((error) => {
			this.failUnsettled(error);
			trace.state = preflightSignal.aborted ? "cancelled" : "failed";
			throw error;
		}).finally(() => {
			trace.settledAt = Date.now();
			observeCompletion(this.diagnostics.observers ?? [], Object.freeze({
				cellId: this.cellId, toolCallId: id, name, originToolCallId: this.origin, epoch: this.diagnostics.epoch,
				state: trace.state as "completed" | "failed" | "cancelled",
				queuedAt: trace.queuedAt, startedAt: trace.startedAt, settledAt: trace.settledAt,
			}), () => { this.observerFailures++; });
		});
		this.tasks.add(task);
		void task.finally(() => this.tasks.delete(task)).catch(() => {});
		// Only delivery races cancellation. Settlement/receipts follow task,
		// including policy cleanup and late structural fatal errors.
		return Promise.race([task, interrupted]).catch((error) => {
			throw new Error(errorText(isUnsettledEffect(error) ? unsettledEffect(error.message) : error));
		});
	}
	stop(error = new Error("Code Mode bridge stopped")): void { this.preflight.abort(error); }
	stopScheduling(error: Error): void { this.scheduler.stop(error); }
	async settled(): Promise<void> { await Promise.allSettled([...this.tasks]); }
	get calls(): number { return this.count; }
	get peak(): number { return this.peakCount; }
}
