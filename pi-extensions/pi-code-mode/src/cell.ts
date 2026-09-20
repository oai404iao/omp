import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import { LIMITS, errorText } from "./limits.ts";
import { UsageLedger } from "./usage.ts";
import type { ToolBridge, Trace } from "./bridge.ts";

export type CellState = "running" | "settling" | "terminating" | "completed" | "terminated" | "failed";
export interface Observation {
	cellId: string; state: CellState; text: string; error?: string;
	hasMoreOutput: boolean; failed: boolean; calls: number; peak: number; traces: Trace[];
	usage?: Usage; epoch: number; fresh: boolean; effectsUnsettled: boolean;
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
	state: CellState = "running";
	error?: string;
	private output: Buffer = Buffer.alloc(0);
	private bytes = 0;
	private emitted = false;
	private observing = false;
	private wakes = new Set<() => void>();
	private userTerminated = false;
	private timer: ReturnType<typeof setTimeout>;
	constructor(timeoutMs: number, run: (cell: Cell) => Promise<"completed" | "terminated">) {
		this.deadline = Date.now() + timeoutMs;
		this.timer = setTimeout(() => this.cancel("Cell execution deadline exceeded"), timeoutMs);
		this.finished = Promise.resolve().then(() => run(this)).then((state) => { this.state = state; }).catch((error) => {
			this.error = errorText(error);
			this.state = this.controller.signal.aborted && !this.bridge?.unsettled ? "terminated" : "failed";
		}).finally(() => {
			clearTimeout(this.timer);
			for (const wake of this.wakes) wake();
		});
	}
	get terminal(): boolean { return ["completed", "terminated", "failed"].includes(this.state); }
	append(text: string): void {
		const data = Buffer.from((this.emitted ? "\n" : "") + text);
		if (this.bytes + data.length > LIMITS.outputBytes) throw new Error("Code Mode output budget exceeded");
		this.bytes += data.length;
		this.output = Buffer.concat([this.output, data]);
		this.emitted = true;
	}
	cancel(reason: string, userRequested = false): void {
		if (this.terminal) return;
		this.userTerminated ||= userRequested;
		this.error ??= reason;
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
			signal?.throwIfAborted(); // cancelled observations consume neither output nor usage
			let end = Math.min(this.output.length, maxTokens * 4);
			while (end > 0 && end < this.output.length && (this.output[end] & 0xc0) === 0x80) end--;
			const text = this.output.subarray(0, end).toString("utf8");
			this.output = this.output.subarray(end);
			const observation: Observation = {
				cellId: this.id, state: this.state, text,
				error: this.state === "completed" ? undefined : this.error,
				hasMoreOutput: this.output.length > 0,
				failed: this.state === "failed" || (this.state === "terminated" && !this.userTerminated),
				calls: this.bridge?.calls ?? 0, peak: this.bridge?.peak ?? 0,
				traces: this.bridge?.traces.map((trace) => ({ ...trace })) ?? [],
				usage: this.usage.take(), epoch: this.epoch, fresh: this.fresh,
				effectsUnsettled: Boolean(this.bridge?.unsettled),
			};
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
