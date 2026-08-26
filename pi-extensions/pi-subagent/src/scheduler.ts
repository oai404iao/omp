export interface BackgroundRunPermit {
	release(): void;
}

export interface BackgroundRunAcquireOptions {
	signal?: AbortSignal;
	waitForCapacity?: boolean;
}

export class BackgroundConcurrencyLimitError extends Error {
	constructor(readonly limit: number) {
		super(
			`background subagent concurrency limit (${limit}) is already in use; wait for an active background run to finish`,
		);
		this.name = "BackgroundConcurrencyLimitError";
	}
}

interface BackgroundRunWaiter {
	resolve: (permit: BackgroundRunPermit) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export class BackgroundRunLimiter {
	private active = 0;
	private readonly waiters: BackgroundRunWaiter[] = [];
	private closedError: Error | undefined;

	constructor(private limit = 4) {
		validateLimit(limit);
	}

	get activeCount(): number {
		return this.active;
	}

	get pendingCount(): number {
		return this.waiters.length;
	}

	configure(limit: number): void {
		validateLimit(limit);
		if (limit === this.limit) return;
		this.limit = limit;
		this.drain();
	}

	acquire(
		options: BackgroundRunAcquireOptions = {},
	): Promise<BackgroundRunPermit> {
		if (this.closedError) return Promise.reject(this.closedError);
		if (options.signal?.aborted) {
			return Promise.reject(abortReason(options.signal));
		}
		if (this.waiters.length === 0 && this.active < this.limit) {
			this.active += 1;
			return Promise.resolve(this.createPermit());
		}
		if (options.waitForCapacity === false) {
			return Promise.reject(new BackgroundConcurrencyLimitError(this.limit));
		}

		return new Promise<BackgroundRunPermit>((resolve, reject) => {
			const waiter: BackgroundRunWaiter = {
				resolve,
				reject,
				...(options.signal ? { signal: options.signal } : {}),
			};
			if (options.signal) {
				waiter.onAbort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(abortReason(options.signal!));
					this.drain();
				};
				options.signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.waiters.push(waiter);
		});
	}

	close(error = new Error("background subagent scheduler is shutting down")): void {
		if (this.closedError) return;
		this.closedError = error;
		for (const waiter of this.waiters.splice(0)) {
			this.removeAbortListener(waiter);
			waiter.reject(error);
		}
	}

	private createPermit(): BackgroundRunPermit {
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.active = Math.max(0, this.active - 1);
				this.drain();
			},
		};
	}

	private drain(): void {
		while (this.waiters.length > 0) {
			const waiter = this.waiters[0]!;
			if (waiter.signal?.aborted) {
				this.waiters.shift();
				this.removeAbortListener(waiter);
				waiter.reject(abortReason(waiter.signal));
				continue;
			}
			if (this.closedError) {
				this.waiters.shift();
				this.removeAbortListener(waiter);
				waiter.reject(this.closedError);
				continue;
			}
			if (this.active >= this.limit) return;
			this.waiters.shift();
			this.removeAbortListener(waiter);
			this.active += 1;
			waiter.resolve(this.createPermit());
		}
	}

	private removeAbortListener(waiter: BackgroundRunWaiter): void {
		if (waiter.signal && waiter.onAbort) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
		}
	}
}

export class AgentOperationQueue {
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
		const predecessor = this.tails.get(agentId) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = predecessor.catch(() => {}).then(() => gate);
		this.tails.set(agentId, tail);

		await predecessor.catch(() => {});
		try {
			return await operation();
		} finally {
			release();
			if (this.tails.get(agentId) === tail) this.tails.delete(agentId);
		}
	}

	async waitForIdle(): Promise<void> {
		while (this.tails.size > 0) {
			await Promise.all([...this.tails.values()].map((tail) => tail.catch(() => {})));
		}
	}
}

function validateLimit(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new Error("background run limit must be a positive safe integer");
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error(signal.reason ? String(signal.reason) : "background run scheduling aborted");
}
