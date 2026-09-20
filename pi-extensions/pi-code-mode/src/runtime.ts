import { randomUUID } from "node:crypto";
import { prepareHost } from "./asset.ts";
import { ToolBridge } from "./bridge.ts";
import { LIMITS, errorText } from "./limits.ts";
import { Supervisor } from "./supervisor.ts";
import { Wire, object, string, identifier, type ObjectValue } from "./wire.ts";

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
	private active?: Active;
	private closing?: Promise<void>;
	private constructor(private supervisor: Supervisor, private wire: Wire, kernel: Record<string, string>) {
		this.kernelLimits = kernel;
		wire.onDelegate = (message) => this.delegate(message);
		wire.onCancel = (id) => this.active?.delegates.get(id)?.abort(new Error("Nested call cancelled"));
		wire.onFailure = (error) => {
			this.active?.controller.abort(error);
			this.active?.rejectCell(error);
			this.active?.bridge.stop(error);
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
			await wire.send({ type: "connection/hello", supportedVersions: [1], requiredCapabilities: [], optionalCapabilities: [] });
			const hello = object(await ready);
			if (hello.selectedVersion !== 1 || !Array.isArray(hello.capabilities) || hello.capabilities.length) throw new Error("Incompatible Host protocol");
			const kernel = await supervisor.verify(startup);
			const runtime = new Runtime(supervisor, wire, kernel);
			const opened = object(await wire.request({ method: "session/open", sessionId: runtime.sessionId }, startup));
			if (opened.type !== "session/ready" || opened.sessionId !== runtime.sessionId) throw new Error("Invalid Host session");
			return runtime;
		} catch (error) {
			wire.fail(new Error(errorText(error)));
			await supervisor.stop();
			throw error;
		}
	}

	get failed(): boolean { return Boolean(this.wire.failure || this.closing); }

	private delegate(message: ObjectValue): void {
		const current = this.active;
		if (!current || this.failed) { this.wire.fail(new Error("Unexpected or stale tool request")); return; }
		const id = Number(message.id);
		if (++current.requests > LIMITS.calls || current.delegates.has(id)) { this.wire.fail(new Error("Code Mode call budget or delegate identity violated")); return; }
		if (current.signal.aborted) return; // pump will terminate; never dispatch after cancellation
		const controller = new AbortController();
		current.delegates.set(id, controller);
		void (async () => {
			let result: unknown;
			try {
				if (message.sessionId !== this.sessionId) throw new Error("Wrong delegate session");
				const request = object(message.request);
				if (request.type !== "tool/invoke") throw new Error("Only authorized tool invocations are supported; notifications are disabled");
				const call = object(request.invocation);
				const cell = await current.cell;
				if (call.cell_id !== cell || call.tool_kind !== "function") throw new Error("Wrong delegate cell or kind");
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
			finally { current.delegates.delete(id); }
			if (this.active === current && !current.signal.aborted && !controller.signal.aborted && !this.failed) {
				await this.wire.send({ type: "delegate/response", id, result });
			}
		})().catch((error) => this.wire.fail(new Error(errorText(error))));
	}

	async run(code: string, bridge: ToolBridge, cellSignal: AbortSignal, timeoutMs: number,
		emit: (text: string) => void, settling: () => void): Promise<"completed" | "terminated"> {
		if (this.failed || this.active) throw new Error("Code Mode runtime is unavailable or busy");
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
		this.active = active;
		let disarm: (() => Promise<void>) | undefined;
		try {
			disarm = await this.supervisor.arm(signal, Math.ceil(timeoutMs / 1000) + 5);
			signal.throwIfAborted();
			const operation = this.wire.start({
				method: "session/execute", sessionId: this.sessionId, request: {
					tool_call_id: randomUUID(),
					enabled_tools: bridge.tools.map((tool) => ({
						name: tool.name, tool_name: { name: tool.name, namespace: null }, description: tool.description,
						kind: "function", input_schema: tool.parameters, output_schema: null,
					})),
					source: code, yield_time_ms: 100, max_output_tokens: 8000,
				},
			}, transport());
			const start = object(await operation.started);
			if (start.type !== "execution/started") throw new Error("Invalid execute acknowledgement");
			const cellId = identifier(start.cellId);
			resolveCell(cellId);
			let observation = await operation.initial;
			for (;;) {
				const variants = object(observation);
				const keys = Object.keys(variants);
				if (keys.length !== 1 || !["Result", "Yielded", "Terminated"].includes(keys[0])) throw new Error("Invalid Host observation");
				const kind = keys[0];
				const body = object(variants[kind]);
				if (body.cell_id !== cellId || !Array.isArray(body.content_items)) throw new Error("Invalid Host cell output");
				for (const raw of body.content_items) {
					const item = object(raw);
					if (item.type !== "input_text") throw new Error("Code Mode supports text output only; image/audio helpers are unavailable");
					const next = string(item.text);
					emit(next);
				}
				if (kind === "Terminated" || kind === "Result") {
					if (body.error_text != null) throw new Error(`Script failed: ${string(body.error_text)}`);
					settling();
					bridge.stop();
					await bridge.settled();
					if (bridge.unsettled) throw bridge.unsettled;
					await disarm();
					disarm = undefined;
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
			controller.abort(error);
			bridge.stop();
			await this.close();
			throw new Error(`${errorText(error)}\nRuntime reset; JSON store lost. External side effects are not rolled back.`);
		} finally {
			bridge.stop();
			await bridge.settled();
			// On failure the supervisor owns disarming, and only after proving
			// the Host stopped. Never remove a still-needed independent deadline.
			if (this.active === active) this.active = undefined;
		}
	}

	close(): Promise<void> {
		return this.closing ??= (async () => {
			this.active?.controller.abort(new Error("Code Mode runtime closed"));
			this.active?.bridge.stop();
			this.wire.fail(new Error("Code Mode runtime closed; JSON store lost"));
			await this.supervisor.stop();
		})();
	}
}
