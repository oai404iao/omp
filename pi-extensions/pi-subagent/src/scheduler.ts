/** Serialize operations after resolving their canonical agent path. */
export class AgentOperationQueue {
	private readonly tails = new Map<string, Promise<unknown>>();

	run<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(operation);
		this.tails.set(key, next);
		void next.finally(() => {
			if (this.tails.get(key) === next) this.tails.delete(key);
		}).catch(() => {});
		return next;
	}

	async drain(): Promise<void> {
		while (this.tails.size) await Promise.allSettled([...this.tails.values()]);
	}
}

/** Fail-fast active-run admission. Root turns and mailbox IO do not use slots. */
export class ExecutionLimiter {
	private active = 0;
	constructor(readonly limit: number) {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid concurrency limit");
	}
	get count(): number { return this.active; }
	acquire(): () => void {
		if (this.active >= this.limit) throw new Error(`subagent capacity reached (${this.limit} active runs)`);
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
		};
	}
}
