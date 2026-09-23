import type { CodeModeApproval, PolicyCall } from "./contributions.ts";

interface Request {
	provider: CodeModeApproval; call: PolicyCall;
	resolve(): void; reject(error: unknown): void; abort(): void;
}
/** The UI slot belongs to the actual provider promise, not an abort race.
 * A noncooperative dialog blocks replacement dialogs until it really closes. */
export class ApprovalQueue {
	private queue: Request[] = [];
	private active?: Request;
	get stalled(): boolean { return Boolean(this.active?.call.context.signal.aborted); }
	get pending(): number { return this.queue.length + Number(Boolean(this.active)); }
	request(provider: CodeModeApproval, call: PolicyCall): Promise<void> {
		const signal = call.context.signal;
		signal.throwIfAborted();
		if (this.stalled || this.pending >= 16) return Promise.reject(new Error("Code Mode approval queue blocked/full"));
		return new Promise<void>((resolve, reject) => {
			const request: Request = { provider, call, resolve, reject, abort: () => {
				if (this.active === request) return; // settlement is deliberately not fabricated
				this.queue = this.queue.filter((item) => item !== request);
				signal.removeEventListener("abort", request.abort);
				reject(signal.reason);
			} };
			this.queue.push(request);
			signal.addEventListener("abort", request.abort, { once: true });
			this.pump();
		});
	}
	private pump(): void {
		if (this.active) return;
		const request = this.queue.shift();
		if (!request) return;
		this.active = request;
		const signal = request.call.context.signal;
		void Promise.resolve().then(async () => {
			signal.throwIfAborted();
			const approved = await request.provider.approve(request.call);
			signal.throwIfAborted();
			if (approved !== true) throw new Error(`Code Mode approval denied: ${request.provider.id}`);
		}).then(request.resolve, request.reject).finally(() => {
			signal.removeEventListener("abort", request.abort);
			this.active = undefined;
			this.pump();
		});
	}
}
