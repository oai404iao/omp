import { LIMITS } from "./limits.ts";

interface Job {
	exclusive: boolean;
	start(): void;
	reject(error: unknown): void;
}
/** FIFO writer barrier. Exclusive tools overlap with no bridge tool, not just
 * other writers. This is NOT a lock over arbitrary direct Pi tools. */
export class Scheduler {
	private running = 0;
	private exclusive = false;
	private queue: Job[] = [];
	private stopped?: Error;
	private paused = 0;
	private tasks = new Set<Promise<unknown>>();
	peak = 0;

	run<T>(exclusive: boolean, signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
		if (this.stopped || signal.aborted) return Promise.reject(this.stopped ?? signal.reason);
		if (this.queue.length >= LIMITS.queue) return Promise.reject(new Error("Code Mode queue budget exceeded"));
		const work = new Promise<T>((resolve, reject) => {
			const abort = () => {
				this.queue = this.queue.filter((item) => item !== job);
				job.reject(signal.reason);
				this.pump();
			};
			const job: Job = { exclusive, reject: (error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			}, start: () => {
				signal.removeEventListener("abort", abort);
				this.running++; this.exclusive = exclusive; this.peak = Math.max(this.peak, this.running);
				void (async () => {
					try { signal.throwIfAborted(); resolve(await execute()); }
					catch (error) { reject(error); }
					finally { this.running--; if (exclusive) this.exclusive = false; this.pump(); }
				})();
			} };
			this.queue.push(job);
			signal.addEventListener("abort", abort, { once: true });
			this.pump();
		});
		this.tasks.add(work);
		void work.finally(() => this.tasks.delete(work)).catch(() => {});
		return work;
	}
	private pump(): void {
		while (!this.paused && !this.stopped && !this.exclusive && this.queue.length && this.running < LIMITS.concurrency) {
			if (this.queue[0].exclusive && this.running) return;
			this.queue.shift()!.start();
		}
	}
	/** Bulk cancellation must not pump a sibling between individual aborts. */
	pause<T>(action: () => T): T {
		this.paused++;
		try { return action(); } finally { this.paused--; this.pump(); }
	}
	stop(error = new Error("Code Mode dispatch stopped")): void {
		this.stopped ??= error;
		for (const job of this.queue.splice(0)) job.reject(this.stopped);
	}
	async settled(): Promise<void> { await Promise.allSettled([...this.tasks]); }
}
