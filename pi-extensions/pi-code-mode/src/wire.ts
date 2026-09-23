import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { LIMITS, errorText } from "./limits.ts";

export type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Host object");
	return value as ObjectValue;
}
export function string(value: unknown): string {
	if (typeof value !== "string" || value.length > LIMITS.frameBytes) throw new Error("Invalid Host string");
	return value;
}
export function identifier(value: unknown): string {
	const text = string(value);
	if (!text || text.length > 128) throw new Error("Invalid Host identifier");
	return text;
}

interface Observer { resolve(value: unknown): void; reject(error: Error): void }

export class Wire {
	private buffer: Buffer = Buffer.alloc(0);
	private observers = new Map<string, Observer>();
	private writes = Promise.resolve();
	private queuedBytes = 0;
	private stderr = "";
	private nextId = 0;
	failure?: Error;
	onDelegate: (message: ObjectValue) => void = () => { this.fail(new Error("Unexpected Host delegate")); };
	onCancel: (id: number) => void = () => {};
	onFailure: (error: Error) => void = () => {};

	constructor(private child: ChildProcessWithoutNullStreams) {
		child.on("error", (error) => this.fail(error));
		child.stdin.on("error", (error) => this.fail(error));
		child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-2048); });
		child.on("close", (code, signal) => this.fail(new Error(`Host exited (${code ?? signal}); runtime/store lost. ${this.stderr}`)));
		child.stdout.on("data", (chunk: Buffer) => {
			if (this.failure) return;
			try {
				// Stream framing: never concatenate an unbounded frame.
				let input = chunk;
				while (input.length && !this.failure) {
					const needed = this.buffer.length < 4 ? 4 - this.buffer.length : 4 + this.buffer.readUInt32LE(0) - this.buffer.length;
					const take = Math.min(input.length, needed);
					this.buffer = Buffer.concat([this.buffer, input.subarray(0, take)]);
					input = input.subarray(take);
					if (this.buffer.length < 4) continue;
					const length = this.buffer.readUInt32LE(0);
					if (!length || length > LIMITS.frameBytes) throw new Error("Host IPC frame budget exceeded");
					if (this.buffer.length < length + 4) continue;
					const message = object(JSON.parse(this.buffer.subarray(4).toString("utf8")));
					this.buffer = Buffer.alloc(0);
					this.receive(message);
				}
			} catch (error) { this.fail(new Error(errorText(error))); }
		});
	}

	fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		for (const observer of this.observers.values()) observer.reject(error);
		this.observers.clear();
		this.onFailure(error);
	}

	private receive(message: ObjectValue): void {
		if (this.failure) return;
		const type = string(message.type);
		if (type === "delegate/request" || type === "delegate/cancel") {
			if (!Number.isSafeInteger(message.id) || Number(message.id) < 0) throw new Error("Invalid delegate ID");
			if (type === "delegate/request") this.onDelegate(message);
			else this.onCancel(Number(message.id));
			return;
		}
		if (type === "cell/closed") { identifier(message.cellId); identifier(message.sessionId); return; }
		const key = `${type}:${message.id ?? 0}`;
		const observer = this.observers.get(key);
		if (!observer) throw new Error(`Unexpected Host response: ${type}`);
		if (message.result !== undefined) {
			const result = object(message.result);
			if (result.status === "error") observer.reject(new Error(string(result.message)));
			else if (result.status === "ok" && "value" in result) observer.resolve(result.value);
			else throw new Error("Invalid Host operation result");
		} else observer.resolve(message);
		this.observers.delete(key);
	}

	expect(type: string, id: number, signal: AbortSignal): Promise<unknown> {
		if (this.failure) return Promise.reject(this.failure);
		signal.throwIfAborted();
		const key = `${type}:${id}`;
		if (this.observers.has(key) || this.observers.size >= LIMITS.maxCells * 2 + 2) throw new Error("Host observer budget exceeded");
		const promise = new Promise<unknown>((resolve, reject) => {
			const aborted = () => this.fail(new Error("Code Mode operation cancelled or timed out"));
			const finish = () => signal.removeEventListener("abort", aborted);
			this.observers.set(key, {
				resolve: (value) => { finish(); resolve(value); },
				reject: (error) => { finish(); reject(error); },
			});
			signal.addEventListener("abort", aborted, { once: true });
		});
		void promise.catch(() => {});
		return promise;
	}

	send(message: unknown): Promise<void> {
		if (this.failure) return Promise.reject(this.failure);
		const data = Buffer.from(JSON.stringify(message));
		if (data.length > LIMITS.frameBytes || this.queuedBytes + data.length > 2 * LIMITS.frameBytes) {
			this.fail(new Error("Host outgoing IPC budget exceeded"));
			return Promise.reject(this.failure);
		}
		const frame = Buffer.allocUnsafe(data.length + 4);
		frame.writeUInt32LE(data.length);
		data.copy(frame, 4);
		this.queuedBytes += data.length;
		const write = this.writes.then(() => new Promise<void>((resolve, reject) => {
			if (this.failure) { reject(this.failure); return; }
			this.child.stdin.write(frame, (error) => error ? reject(error) : resolve());
		})).finally(() => { this.queuedBytes -= data.length; });
		this.writes = write.catch((error) => this.fail(new Error(errorText(error))));
		return write;
	}

	request(request: unknown, signal: AbortSignal): Promise<unknown> {
		const id = ++this.nextId;
		const response = this.expect("operation/response", id, signal);
		void this.send({ type: "operation/request", id, request }).catch((error) => this.fail(error));
		return response;
	}

	start(request: unknown, signal: AbortSignal): { started: Promise<unknown>; initial: Promise<unknown> } {
		const id = ++this.nextId;
		const started = this.expect("operation/response", id, signal);
		const initial = this.expect("execute/initialResponse", id, signal);
		void this.send({ type: "operation/request", id, request }).catch((error) => this.fail(error));
		return { started, initial };
	}
}
