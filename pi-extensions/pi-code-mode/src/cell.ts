import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import { LIMITS, errorText } from "./limits.ts";
import { UsageLedger } from "./usage.ts";
import type { ToolBridge, Trace } from "./bridge.ts";
import { RuntimeResetError, UnconfirmedRuntimeStop } from "./errors.ts";

export type CellState = "running" | "awaiting_approval" | "settling" | "terminating" | "completed" | "terminated" | "failed";
export interface Observation {
	cellId: string; state: CellState; text: string; error?: string;
	hasMoreOutput: boolean; hasMoreTraces: boolean; failed: boolean; calls: number; peak: number; traces: Trace[];
	usage?: Usage; epoch: number; fresh: boolean; effectsUnsettled: boolean; hostDurationNs: number;
	wallMs: number; truncated: boolean; droppedBytes: number; runtimeReset: boolean; hostCompleted: boolean;
	errorKind?: string; originToolCallId?: string; observerFailures: number;
}
export class Cell {
	readonly id = `cm-${randomUUID()}`;
	readonly controller = new AbortController();
	readonly usage = new UsageLedger();
	readonly deadline: number;
	readonly finished: Promise<void>;
	bridge?: ToolBridge;
	epoch = 0;
	fresh = false;
	hostDurationNs = 0;
	hostCompleted = false;
	runtimeReset = false;
	truncated = false;
	droppedBytes = 0;
	errorKind?: string;
	readonly createdAt = Date.now();
	private endedAt?: number;
	private unconfirmed = false;
	private deliveredTraces = new Map<string, string>();
	state: CellState = "running";
	error?: string;
	private output: Buffer = Buffer.alloc(0);
	private bytes = 0;
	private emitted = false;
	private observing = false;
	private wakes = new Set<() => void>();
	private userTerminated = false;
	private timer: ReturnType<typeof setTimeout>;
	constructor(timeoutMs: number, run: (cell: Cell) => Promise<"completed" | "terminated">, readonly origin?: string) {
		this.deadline = Date.now() + timeoutMs;
		this.timer = setTimeout(() => this.cancel("Cell execution deadline exceeded", false, "deadline"), timeoutMs);
		this.finished = Promise.resolve().then(() => run(this)).then((state) => { this.state = state; }).catch((error) => {
			this.error = errorText(error);
			if (error instanceof RuntimeResetError) { this.runtimeReset = true; this.errorKind ??= error.kind; }
			this.unconfirmed = error instanceof UnconfirmedRuntimeStop;
			this.state = this.controller.signal.aborted && !this.bridge?.unsettled && !this.unconfirmed
				&& !(error instanceof RuntimeResetError && error.kind !== "runtime") ? "terminated" : "failed";
		}).finally(() => {
			this.endedAt = Date.now();
			clearTimeout(this.timer);
			for (const wake of this.wakes) wake();
		});
	}
	get terminal(): boolean { return ["completed", "terminated", "failed"].includes(this.state); }
	get visibleState(): CellState { return this.state === "running" && this.bridge?.pendingApprovals ? "awaiting_approval" : this.state; }
	append(text: string): void {
		const data = Buffer.from((this.emitted ? "\n" : "") + text);
		if (this.truncated) { this.droppedBytes += data.length; return; }
		let end = Math.min(data.length, Math.max(0, LIMITS.outputBytes - this.bytes));
		while (end > 0 && end < data.length && (data[end] & 0xc0) === 0x80) end--;
		this.bytes += end;
		this.output = Buffer.concat([this.output, data.subarray(0, end)]);
		this.emitted = true;
		if (end < data.length) {
			this.truncated = true;
			this.droppedBytes += data.length - end;
			this.errorKind = "output";
			this.error = "Code Mode output budget exceeded; bounded prefix retained. Writes are not rolled back.";
			this.cancel(this.error, false, "output");
		}
	}
	cancel(reason: string, userRequested = false, kind = "cancelled"): void {
		if (this.terminal) return;
		if (!this.controller.signal.aborted) this.userTerminated = userRequested;
		this.error ??= reason;
		this.errorKind ??= kind;
		this.state = "terminating";
		this.controller.abort(new Error(reason));
		this.bridge?.stop(new Error(reason));
	}
	settling(): void { if (!this.controller.signal.aborted) this.state = "settling"; }
	async observe(yieldMs: number, maxTokens: number, signal?: AbortSignal): Promise<Observation> {
		if (this.observing) throw new Error("This cell already has an observer");
		signal?.throwIfAborted();
		this.observing = true;
		let wake!: () => void;
		let abort!: () => void;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (!this.terminal && yieldMs > 0) await new Promise<void>((resolve, reject) => {
				wake = resolve;
				abort = () => reject(new Error("Cell observation cancelled; cell lifetime is independent"));
				this.wakes.add(wake);
				signal?.addEventListener("abort", abort, { once: true });
				timer = setTimeout(resolve, yieldMs);
			});
			// Human approval is not a polling workload. Zero-yield stays nonblocking;
			// positive observations hold until the current prompt closes or cancellation.
			if (yieldMs > 0) await this.bridge?.waitForApprovals(signal);
			signal?.throwIfAborted(); // cancelled observations consume neither output nor usage
			let end = Math.min(this.output.length, maxTokens * 4);
			while (end > 0 && end < this.output.length && (this.output[end] & 0xc0) === 0x80) end--;
			const text = this.output.subarray(0, end).toString("utf8");
			this.output = this.output.subarray(end);
			const traces: Trace[] = [];
			let traceBytes = 2, hasMoreTraces = false;
			for (const trace of this.bridge?.traces ?? []) {
				const json = JSON.stringify(trace);
				if (this.deliveredTraces.get(trace.id) === json) continue;
				const size = Buffer.byteLength(json) + 1;
				if (traceBytes + size > LIMITS.traceBytes) { hasMoreTraces = true; continue; }
				traceBytes += size;
				traces.push({ ...trace });
			}
			const observation: Observation = {
				cellId: this.id, state: this.visibleState, text,
				error: this.state === "completed" ? undefined : this.error,
				hasMoreOutput: this.output.length > 0,
				hasMoreTraces,
				failed: this.truncated || this.state === "failed" || (this.state === "terminated" && !this.userTerminated),
				calls: this.bridge?.calls ?? 0, peak: this.bridge?.peak ?? 0,
				traces,
				usage: this.usage.take(), epoch: this.epoch, fresh: this.fresh,
				effectsUnsettled: Boolean(this.bridge?.unsettled || this.unconfirmed),
				hostDurationNs: this.hostDurationNs,
				wallMs: (this.endedAt ?? Date.now()) - this.createdAt,
				truncated: this.truncated, droppedBytes: this.droppedBytes,
				runtimeReset: this.runtimeReset, hostCompleted: this.hostCompleted,
				errorKind: this.errorKind, originToolCallId: this.origin,
				observerFailures: this.bridge?.observerFailures ?? 0,
			};
			for (const trace of observation.traces) this.deliveredTraces.set(trace.id, JSON.stringify(trace));
			this.fresh = false;
			return observation;
		} finally {
			this.observing = false;
			this.wakes.delete(wake);
			if (abort) signal?.removeEventListener("abort", abort);
			clearTimeout(timer);
		}
	}
}
