import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Runtime } from "./runtime.ts";
import { ReadRoot } from "./readonly.ts";
import { ToolBridge } from "./bridge.ts";
import { Cell, type Observation } from "./cell.ts";
import { localTools, READ_ONLY, type Grants } from "./builtin-tools.ts";
import { toolPrompt, type Catalog } from "./catalog.ts";
import { LIMITS } from "./limits.ts";
import { RuntimeResetError, UnconfirmedRuntimeStop } from "./errors.ts";
import { ApprovalQueue } from "./approvals.ts";
import { Scheduler } from "./scheduler.ts";

export interface ExecOptions { yield_time_ms?: number; timeout_ms?: number; max_tokens?: number }
export interface WaitOptions { yield_time_ms?: number; max_tokens?: number; terminate?: boolean }
function range(value: number | undefined, fallback: number, max: number, min = 0): number {
	const number = value ?? fallback;
	if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error("Invalid Code Mode time/output budget");
	return number;
}
export class CodeSession {
	private approvals = new ApprovalQueue();
	private root?: ReadRoot;
	private runtime?: Runtime;
	private cells = new Map<string, Cell>();
	private initialization?: Promise<Runtime>;
	private initController?: AbortController;
	private scheduler = new Scheduler();
	private capacity = 1;
	private reportedEpoch = 0;
	private idle?: ReturnType<typeof setTimeout>;
	private epoch = 0;
	private changes = 0;
	private disposed = false;
	private lifecycle: Promise<void> = Promise.resolve();
	private authorization = 0;
	private revoked = true;
	private poisoned = false;
	private context?: ExtensionContext;
	private grants: Grants = READ_ONLY;
	hostPath = "";
	onDiscard?: (observation: Pick<Observation, "cellId" | "state" | "usage">) => void;

	get enabled(): boolean { return Boolean(this.root && !this.disposed && !this.revoked); }
	get blocked(): boolean { return this.poisoned || this.approvals.stalled; }
	get rootPath(): string | undefined { return this.root?.path; }
	get busy(): boolean { return Boolean(this.cells.size || this.changes); }
	get maxCells(): number { return this.capacity; }
	setMaxCells(value: number): void {
		if (this.busy || !Number.isSafeInteger(value) || value < 1 || value > LIMITS.maxCells) throw new Error("maxCells must be 1–4 and changed only while idle");
		this.capacity = value;
	}
	get cellList(): { id: string; state: string }[] { return [...this.cells.values()].map((cell) => ({ id: cell.id, state: cell.visibleState })); }
	get activeCell(): { id: string; state: string } | undefined { return this.cells.size === 1 ? this.cellList[0] : undefined; }
	setContext(ctx: ExtensionContext): void { this.context = ctx; }
	block(error: Error): void { this.poisoned = true; this.scheduler.stop(error); this.cancel(error.message); }
	private change(action: () => Promise<void>): Promise<void> {
		this.changes++;
		const work = this.lifecycle.catch(() => {}).then(action);
		this.lifecycle = work.finally(() => { this.changes--; });
		void this.lifecycle.catch(() => {});
		return this.lifecycle;
	}
	async authorize(path: string, host: string, grants: Grants = READ_ONLY): Promise<void> {
		if (this.disposed || this.busy || this.poisoned) throw new Error("Code Mode is closing, blocked or busy");
		if (!host) throw new Error("Provide --code-mode-host /absolute/path/to/the/pinned/executable");
		const generation = ++this.authorization;
		await this.change(async () => {
			if (this.disposed) throw new Error("Code Mode session was disposed");
			await this.resetRuntime();
			await this.root?.close();
			this.root = undefined;
			const grant = await ReadRoot.grant(path);
			if (this.disposed || generation !== this.authorization) { await grant.close(); throw new Error("Read authorization was superseded"); }
			this.root = grant;
			this.grants = { ...grants, tools: [...grants.tools] };
			this.revoked = false;
			this.hostPath = host;
		});
	}
	catalog(external: Catalog = { tools: [], policies: [] }): Catalog {
		if (!this.root || !this.enabled) throw new Error("Code Mode requires explicit authorization");
		const tools = [...localTools(this.root, this.grants), ...external.tools.filter((tool) => this.grants.tools.includes(tool.name))];
		if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("Duplicate nested tool names");
		toolPrompt(tools); // enforce prompt and wire catalog budget before effects
		return { tools, policies: external.policies, observers: external.observers, approvals: external.approvals };
	}
	private async getRuntime(current: Cell): Promise<Runtime> {
		if (!this.initialization && (!this.runtime || this.runtime.failed)) {
			if ([...this.cells.values()].some((cell) => cell !== current && !cell.terminal && cell.bridge)) {
				throw new RuntimeResetError("Shared runtime reset is still settling; collect sibling cells", "runtime");
			}
			const controller = new AbortController();
			this.initController = controller;
			this.initialization = (async () => {
				try {
					await this.runtime?.close();
					const runtime = await Runtime.create(this.hostPath, controller.signal);
					this.runtime = runtime;
					this.scheduler = new Scheduler();
					this.epoch++;
					return runtime;
				} catch (error) {
					if (error instanceof UnconfirmedRuntimeStop) this.block(error);
					throw error;
				}
			})();
			void this.initialization.finally(() => { this.initialization = undefined; this.initController = undefined; }).catch(() => {});
		}
		const runtime = await (this.initialization ?? this.runtime!);
		current.epoch = this.epoch;
		current.fresh = this.reportedEpoch !== this.epoch;
		this.reportedEpoch = this.epoch;
		return runtime;
	}
	async execute(code: string, signal?: AbortSignal, options: ExecOptions = {}, external?: Catalog, origin?: string): Promise<Observation> {
		if (!this.root || !this.enabled) throw new Error("Code Mode requires explicit local authorization");
		if (this.changes || this.blocked || this.cells.size >= this.capacity
			|| (this.runtime?.failed && [...this.cells.values()].some((cell) => !cell.terminal))) {
			throw new Error(`Code Mode capacity ${this.capacity} reached, changing or blocked; collect results with wait: ${JSON.stringify(this.cellList)}`);
		}
		if (!code.trim() || Buffer.byteLength(code) > LIMITS.codeBytes) throw new Error("Code must be nonempty and at most 24 KiB");
		const timeout = range(options.timeout_ms, LIMITS.executionMs, LIMITS.executionMs, 1);
		const yieldMs = range(options.yield_time_ms, 1000, LIMITS.observeMs);
		const maxTokens = range(options.max_tokens, 8192, 8192, 1);
		signal?.throwIfAborted();
		const catalog = this.catalog(external);
		const cwd = this.root.path;
		clearTimeout(this.idle);
		const cell = new Cell(timeout, async (current) => {
			const controller = current.controller;
			controller.signal.throwIfAborted();
			const runtime = await this.getRuntime(current);
			if (controller.signal.aborted) return "terminated";
			current.bridge = new ToolBridge(catalog.tools, catalog.policies, current.id, cwd, controller.signal,
				() => this.context, (usage) => current.usage.add(usage), (error) => this.block(error),
				{ origin: current.origin, epoch: current.epoch, observers: catalog.observers, approvals: catalog.approvals,
					approvalQueue: this.approvals, scheduler: this.scheduler });
			try {
				return await runtime.run(code, current.bridge, controller.signal,
					Math.max(1, current.deadline - Date.now()), (text) => current.append(text), () => current.settling(),
					(ns) => { current.hostDurationNs += ns; }, () => { current.hostCompleted = true; });
			} finally { if (current.bridge.unsettled) this.block(current.bridge.unsettled); }
		}, origin?.slice(0, 256));
		this.cells.set(cell.id, cell);
		return this.observe(cell, yieldMs, maxTokens, signal);
	}
	async wait(id: string, options: WaitOptions = {}, signal?: AbortSignal): Promise<Observation> {
		const cell = this.cells.get(id);
		if (this.disposed || !cell) throw new Error("Unknown, consumed or stale Code Mode cell");
		const yieldMs = range(options.yield_time_ms, 1000, LIMITS.observeMs);
		const maxTokens = range(options.max_tokens, 8192, 8192, 1);
		if (options.terminate) cell.cancel("Termination requested; side effects are not rolled back", true);
		return this.observe(cell, yieldMs, maxTokens, signal);
	}
	private async observe(cell: Cell, yieldMs: number, maxTokens: number, signal?: AbortSignal): Promise<Observation> {
		const value = await cell.observe(yieldMs, maxTokens, signal);
		if (this.cells.get(cell.id) === cell && ["completed", "terminated", "failed"].includes(value.state) && !value.hasMoreOutput && !value.hasMoreTraces) {
			this.cells.delete(cell.id);
			if (!this.cells.size) {
				this.idle = setTimeout(() => { void this.invalidate().catch(() => {}); }, LIMITS.idleMs);
				this.idle.unref();
			}
		}
		return value;
	}
	cancel(reason = "Agent interrupted"): void {
		this.scheduler.pause(() => { for (const cell of this.cells.values()) cell.cancel(reason); });
	}
	terminate(id: string): void {
		const cell = this.cells.get(id);
		if (!cell) throw new Error("Unknown, consumed or stale Code Mode cell");
		cell.cancel("Termination requested; side effects are not rolled back", true);
	}
	terminateAll(): void {
		this.scheduler.pause(() => { for (const cell of this.cells.values()) this.terminate(cell.id); });
	}
	private async resetRuntime(): Promise<void> {
		clearTimeout(this.idle);
		this.cancel("Code Mode session changed");
		let failure: unknown;
		this.initController?.abort(new Error("Code Mode session changed during startup"));
		try { await this.initialization; } catch (error) { if (error instanceof UnconfirmedRuntimeStop) failure = error; }
		try { await this.runtime?.close(); } catch (error) { failure = error; }
		const cells = [...this.cells.values()];
		if (cells.length) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([Promise.all(cells.map((cell) => cell.finished)), new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Tool effects are still settling; session is blocked")), 5000);
				})]);
			} catch (error) {
				this.poisoned = true; failure ??= error;
				// A noncooperative invocation can report usage after teardown's bound.
				// Preserve its receipt without admitting another cell or pretending
				// settlement was confirmed. Synchronous take prevents duplicate audits.
				for (const cell of cells) void cell.finished.then(() => {
					const usage = cell.usage.take();
					if (usage) this.onDiscard?.({ cellId: cell.id, state: cell.state, usage });
				}).catch(() => {});
			}
			finally { clearTimeout(timer); }
			for (const cell of cells) if (cell.terminal) {
				// Teardown must not acquire a second observer. The synchronous ledger
				// gives each receipt to either the waiting tool or this audit, never both.
				const usage = cell.usage.take();
				if (usage) this.onDiscard?.({ cellId: cell.id, state: cell.state, usage });
			}
		}
		try { await this.runtime?.close(); } catch (error) { failure ??= error; }
		if (failure || this.poisoned) {
			this.poisoned = true;
			throw failure ?? new Error("Unconfirmed tool effects; restart required");
		}
		this.cells.clear();
		this.runtime = undefined;
		this.scheduler = new Scheduler();
	}
	async invalidate(): Promise<void> { this.cancel("Code Mode context changed"); await this.change(() => this.resetRuntime()); }
	async revoke(dispose = false): Promise<void> {
		this.authorization++;
		this.revoked = true;
		if (dispose) this.disposed = true;
		this.cancel("Code Mode authorization revoked");
		await this.change(async () => {
			await this.resetRuntime();
			await this.root?.close();
			this.root = undefined;
		});
	}
}
