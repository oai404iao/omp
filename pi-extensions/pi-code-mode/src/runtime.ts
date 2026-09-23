import { randomUUID } from "node:crypto";
import { prepareHost } from "./asset.ts";
import { ToolBridge } from "./bridge.ts";
import { LIMITS, errorText } from "./limits.ts";
import { Supervisor } from "./supervisor.ts";
import { Wire, object, string, identifier, type ObjectValue } from "./wire.ts";
import { RESOURCE_LIMITS, negotiatedLimits, hostDuration } from "./host-protocol.ts";
import { ScriptFailure, UnsupportedOutput, RuntimeResetError, UnconfirmedRuntimeStop } from "./errors.ts";

interface Active {
	controller: AbortController;
	signal: AbortSignal;
	bridge: ToolBridge;
	cell: Promise<string>;
	resolveCell(value: string): void;
	rejectCell(error: Error): void;
	delegates: Map<number, AbortController>;
	ids: Set<string>;
	requests: number;
}

export class Runtime {
	readonly sessionId = randomUUID();
	readonly kernelLimits: Record<string, string>;
	private active = new Set<Active>();
	private cells = new Map<string, Active>();
	private starting?: Active;
	private starts: Promise<void> = Promise.resolve();
	private delegates = new Map<number, AbortController>();
	private delegateIds = new Set<number>();
	private highestDelegate = -1;
	private closing?: Promise<void>;
	private constructor(private supervisor: Supervisor, private wire: Wire, kernel: Record<string, string>) {
		this.kernelLimits = kernel;
		wire.onDelegate = (message) => this.delegate(message);
		wire.onCancel = (id) => this.delegates.get(id)?.abort(new Error("Nested call cancelled"));
		wire.onFailure = (error) => {
			this.stopAdmission(error);
			for (const active of this.active) {
				active.controller.abort(error);
				active.rejectCell(error);
				active.bridge.stop(error);
			}
			void supervisor.stop().catch(() => {});
		};
	}

	static async create(source: string, signal: AbortSignal): Promise<Runtime> {
		const asset = await prepareHost(source);
		signal.throwIfAborted();
		const supervisor = new Supervisor(asset.binary, asset.directory);
		const wire = new Wire(supervisor.child);
		try {
			const startup = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
			const ready = wire.expect("connection/ready", 0, startup);
			await wire.send({ type: "connection/hello", supportedVersions: [1], requiredCapabilities: [], optionalCapabilities: [RESOURCE_LIMITS] });
			const limits = negotiatedLimits(await ready);
			const kernel = await supervisor.verify(startup);
			const runtime = new Runtime(supervisor, wire, kernel);
			const opened = object(await wire.request({ method: "session/open", sessionId: runtime.sessionId,
				...(limits ? { cellExecutionLimits: { maxYieldTimeMs: 250 } } : {}) }, startup));
			if (opened.type !== "session/ready" || opened.sessionId !== runtime.sessionId) throw new Error("Invalid Host session");
			return runtime;
		} catch (error) {
			wire.fail(new Error(errorText(error)));
			try { await supervisor.stop(); }
			catch (cleanup) { throw new UnconfirmedRuntimeStop(errorText(cleanup)); }
			throw error;
		}
	}

	get failed(): boolean { return Boolean(this.wire.failure || this.closing); }
	private stopAdmission(error: Error): void {
		// Stop ALL gates before aborting even one queued call: abort removes queue
		// entries and would otherwise pump a not-yet-cancelled sibling.
		for (const active of this.active) active.bridge.stopScheduling(error);
	}

	private delegate(message: ObjectValue): void {
		let call: ObjectValue;
		try {
			if (message.sessionId !== this.sessionId) throw new Error("Wrong delegate session");
			const request = object(message.request);
			if (request.type !== "tool/invoke") throw new Error("Only authorized tool invocations are supported; notifications are disabled");
			call = object(request.invocation);
			if (call.tool_kind !== "function") throw new Error("Wrong delegate kind");
			identifier(call.cell_id);
		} catch (error) { this.wire.fail(new Error(errorText(error))); return; }
		const current = this.cells.get(String(call.cell_id)) ?? this.starting;
		if (!current || this.failed) { this.wire.fail(new Error("Unexpected or stale tool request")); return; }
		const id = Number(message.id);
		if (++current.requests > LIMITS.calls || !Number.isSafeInteger(id) || id < 0
			|| id <= this.highestDelegate - LIMITS.delegateHistory || this.delegateIds.has(id)) {
			this.wire.fail(new Error("Code Mode call budget or delegate identity/reorder window violated")); return;
		}
		// Host allocates IDs atomically before async routing, so wire arrival is
		// NOT guaranteed monotonic. Retain a bounded reorder window; all older IDs
		// fail closed forever, including retired cells' replays/late cancels.
		this.highestDelegate = Math.max(this.highestDelegate, id);
		this.delegateIds.add(id);
		if (this.delegateIds.size > LIMITS.delegateHistory) {
			for (const seen of this.delegateIds) if (seen <= this.highestDelegate - LIMITS.delegateHistory) this.delegateIds.delete(seen);
		}
		if (current.signal.aborted) return; // pump will terminate; never dispatch after cancellation
		const controller = new AbortController();
		current.delegates.set(id, controller);
		this.delegates.set(id, controller);
		void (async () => {
			let result: unknown;
			const cell = await current.cell;
			// Early delegates may wait for the ONE serialized start ACK. They may
			// never bind to another cell merely because it was most recently started.
			if (call.cell_id !== cell) throw new Error("Wrong delegate cell");
			try {
				const toolId = identifier(call.runtime_tool_call_id);
				if (current.ids.has(toolId)) throw new Error("Repeated nested call identity");
				current.ids.add(toolId);
				const name = object(call.tool_name);
				if (name.namespace != null || !current.bridge.tools.some((item) => item.name === name.name)) throw new Error("Tool is not authorized for Code Mode");
				const signal = AbortSignal.any([current.signal, controller.signal]);
				signal.throwIfAborted();
				const value = await current.bridge.invoke(string(name.name), call.input, toolId, signal);
				signal.throwIfAborted();
				result = { status: "ok", value: { type: "tool/result", result: value } };
			} catch (error) { result = { status: "error", message: errorText(error) }; }
			finally { current.delegates.delete(id); this.delegates.delete(id); }
			if (this.active.has(current) && !current.signal.aborted && !controller.signal.aborted && !this.failed) {
				await this.wire.send({ type: "delegate/response", id, result });
			}
		})().catch((error) => this.wire.fail(new Error(errorText(error))));
	}

	private start(active: Active, request: unknown): Promise<{ cellId: string; initial: Promise<unknown> } | undefined> {
		const work = this.starts.then(async () => {
			if (this.failed) throw new Error("Shared Code Mode runtime/store lost");
			if (active.signal.aborted) return;
			this.starting = active;
			try {
				const operation = this.wire.start(request, AbortSignal.timeout(5000));
				const start = object(await operation.started);
				if (start.type !== "execution/started") throw new Error("Invalid execute acknowledgement");
				const cellId = identifier(start.cellId);
				if (this.cells.has(cellId)) throw new Error("Repeated Host cell identity");
				this.cells.set(cellId, active);
				active.resolveCell(cellId);
				return { cellId, initial: operation.initial };
			} finally { this.starting = undefined; }
		});
		this.starts = work.then(() => {}, () => {});
		return work;
	}

	async run(code: string, bridge: ToolBridge, cellSignal: AbortSignal, timeoutMs: number,
		emit: (text: string) => void, settling: () => void, duration: (ns: number) => void = () => {},
		hostCompleted: () => void = () => {}): Promise<"completed" | "terminated"> {
		if (this.failed || this.active.size >= LIMITS.maxCells) throw new RuntimeResetError("Shared Code Mode runtime is unavailable or full", "runtime");
		if (!code.trim() || Buffer.byteLength(code) > LIMITS.codeBytes) throw new Error("Code must be nonempty and at most 24 KiB");
		const controller = new AbortController();
		const signal = AbortSignal.any([cellSignal, controller.signal]);
		// Cell cancellation is NOT a wire/observer cancellation. The pump finishes
		// its short observation then explicitly terminates the backend cell.
		const transport = () => AbortSignal.timeout(5000);
		let resolveCell!: Active["resolveCell"];
		let rejectCell!: Active["rejectCell"];
		const cell = new Promise<string>((resolve, reject) => { resolveCell = resolve; rejectCell = reject; });
		void cell.catch(() => {});
		const active: Active = { controller, signal, bridge, cell, resolveCell, rejectCell, requests: 0, delegates: new Map(), ids: new Set() };
		this.active.add(active);
		let disarm: (() => Promise<void>) | undefined;
		let effectsSettled = false;
		try {
			// Complete/verify the OS timer even if one cell cancels during startup.
			// Partial arming failures still reset the whole Host, never a sibling's timer.
			disarm = await this.supervisor.arm(AbortSignal.timeout(5000), Math.ceil(timeoutMs / 1000) + 5);
			const operation = await this.start(active, {
				method: "session/execute", sessionId: this.sessionId, request: {
					tool_call_id: bridge.origin ?? randomUUID(),
					enabled_tools: bridge.tools.map((tool) => ({
						name: tool.name, tool_name: { name: tool.name, namespace: null }, description: tool.description,
						kind: "function", input_schema: null, output_schema: null,
					})),
					source: code, yield_time_ms: 100, max_output_tokens: 8000,
				},
			});
			if (!operation) {
				rejectCell(new Error("Cell cancelled before execution"));
				bridge.stop();
				await bridge.settled();
				effectsSettled = true;
				if (bridge.unsettled) throw bridge.unsettled;
				if (this.failed || controller.signal.aborted) throw new Error("Shared Host failed before cell execution; siblings/store lost");
				await disarm(); disarm = undefined;
				if (this.failed || controller.signal.aborted) throw new Error("Shared Host failed during pre-start watchdog settlement; siblings/store lost");
				return "terminated";
			}
			const { cellId } = operation;
			let observation = await operation.initial;
			for (;;) {
				const variants = object(observation);
				const keys = Object.keys(variants);
				if (keys.length !== 1 || !["Result", "Yielded", "Terminated"].includes(keys[0])) throw new Error("Invalid Host observation");
				const kind = keys[0];
				const body = object(variants[kind]);
				if (body.cell_id !== cellId || !Array.isArray(body.content_items)) throw new Error("Invalid Host cell output");
				if (kind === "Result") hostCompleted();
				duration(hostDuration(body.code_mode_host_duration_ns));
				for (const raw of body.content_items) {
					const item = object(raw);
					if (item.type !== "input_text") throw new UnsupportedOutput("Code Mode supports text output only; image/audio helpers are unavailable");
					const next = string(item.text);
					emit(next);
				}
				if (kind === "Terminated" || kind === "Result") {
					if (body.error_text != null) throw new ScriptFailure(`Script failed: ${string(body.error_text)}`);
					settling();
					bridge.stop();
					await bridge.settled();
					effectsSettled = true;
					if (bridge.unsettled) throw bridge.unsettled;
					if (this.failed || controller.signal.aborted) throw new Error("Shared Host failed during cell settlement; siblings/store lost");
					await disarm();
					disarm = undefined;
					if (this.failed || controller.signal.aborted) throw new Error("Shared Host failed during watchdog settlement; siblings/store lost");
					return kind === "Terminated" || signal.aborted ? "terminated" : "completed";
				}
				const response = object(await this.wire.request({
					...(signal.aborted
						? { method: "session/terminate", cellId }
						: { method: "session/wait", request: { cell_id: cellId, yield_time_ms: 250 } }),
					sessionId: this.sessionId,
				}, transport()));
				if (response.type !== "wait/completed") throw new Error("Invalid Host wait response");
				const outcome = object(response.outcome);
				if (!("LiveCell" in outcome) || Object.keys(outcome).length !== 1) throw new Error("Code Mode cell is no longer live");
				observation = outcome.LiveCell;
			}
		} catch (error) {
			rejectCell(new Error(errorText(error)));
			this.stopAdmission(new Error(errorText(error)));
			controller.abort(error);
			bridge.stop();
			let message = errorText(error);
			try { await this.close(); }
			catch (cleanup) {
				bridge.unsettled ??= new Error(`Host stop unconfirmed: ${errorText(cleanup)}`);
				message += `\n${bridge.unsettled.message}`;
			}
			throw new RuntimeResetError(message, error instanceof ScriptFailure ? "script" : error instanceof UnsupportedOutput ? "unsupported-output" : "runtime");
		} finally {
			bridge.stop();
			// No asynchronous gap after the final success/failure check: retirement
			// must be atomic with that decision. Failure still waits entered effects.
			if (!effectsSettled) await bridge.settled();
			// On failure the supervisor owns disarming, and only after proving
			// the Host stopped. Never remove a still-needed independent deadline.
			this.active.delete(active);
			for (const [id, current] of this.cells) if (current === active) this.cells.delete(id);
			for (const id of active.delegates.keys()) this.delegates.delete(id);
		}
	}

	close(): Promise<void> {
		return this.closing ??= (async () => {
			this.stopAdmission(new Error("Shared Code Mode runtime closed"));
			for (const active of this.active) {
				active.controller.abort(new Error("Shared Code Mode runtime closed; sibling cells/store lost"));
				active.bridge.stop();
			}
			this.wire.fail(new Error("Code Mode runtime closed; JSON store lost"));
			try { await this.supervisor.stop(); }
			catch (error) { throw new UnconfirmedRuntimeStop(errorText(error)); }
		})();
	}
}
