import { LIMITS } from "./limits.ts";

interface Job {
	exclusive: boolean;
	start(): void;
	reject(error: Error): void;
}
/** FIFO writer barrier. Exclusive tools overlap with no bridge tool, not just
 * other writers. This is NOT a lock over arbitrary direct Pi tools. */
export class Scheduler {
	private running = 0;
	private exclusive = false;
	private queue: Job[] = [];
	private stopped?: Error;
	private tasks = new Set<Promise<unknown>>();
	peak = 0;

	run<T>(exclusive: boolean, signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
		if (this.stopped || signal.aborted) return Promise.reject(this.stopped ?? signal.reason);
		if (this.queue.length >= LIMITS.queue) return Promise.reject(new Error("Code Mode queue budget exceeded"));
		const work = new Promise<T>((resolve, reject) => {
			this.queue.push({ exclusive, reject, start: () => {
				this.running++; this.exclusive = exclusive; this.peak = Math.max(this.peak, this.running);
				void (async () => {
					try { signal.throwIfAborted(); resolve(await execute()); }
					catch (error) { reject(error); }
					finally { this.running--; if (exclusive) this.exclusive = false; this.pump(); }
				})();
			} });
			this.pump();
		});
		this.tasks.add(work);
		void work.finally(() => this.tasks.delete(work)).catch(() => {});
		return work;
	}
	private pump(): void {
		while (!this.stopped && !this.exclusive && this.queue.length && this.running < LIMITS.concurrency) {
			if (this.queue[0].exclusive && this.running) return;
			this.queue.shift()!.start();
		}
	}
	stop(error = new Error("Code Mode dispatch stopped")): void {
		this.stopped ??= error;
		for (const job of this.queue.splice(0)) job.reject(this.stopped);
	}
	async settled(): Promise<void> { await Promise.allSettled([...this.tasks]); }
}
