import type { CodeModeObserver, CompletionReceipt } from "./contributions.ts";
import { LIMITS } from "./limits.ts";

export function observeCompletion(observers: readonly CodeModeObserver[], receipt: CompletionReceipt, failed: () => void): void {
	for (const observer of observers) {
		const signal = AbortSignal.timeout(LIMITS.policyMs);
		let abort!: () => void;
		const timeout = new Promise<never>((_, reject) => {
			abort = () => reject(new Error("Observer budget exceeded"));
			signal.addEventListener("abort", abort, { once: true });
		});
		void Promise.race([Promise.resolve().then(() => observer.complete(receipt, signal)), timeout])
			.catch(() => {
				failed();
				process.stderr.write(`Code Mode diagnostic observer failed: ${observer.id}\n`);
			}).finally(() => signal.removeEventListener("abort", abort));
	}
}
