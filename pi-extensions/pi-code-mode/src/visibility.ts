import type { CodeModeTool } from "./contributions.ts";
import { isDirectName, type CodeModeDirectBinding, type DirectToolLease } from "./direct-binding.ts";

export type VisibilityMode = "mixed" | "hide-bridged";
export function visibilityMode(value: unknown): VisibilityMode {
	if (value === undefined || value === "mixed") return "mixed";
	if (value === "hide-bridged") return value;
	throw new Error("Code Mode visibility must be mixed or hide-bridged; strict only is not supported");
}

/** Receipts for cooperative owners only; never writes a foreign active set. */
export class Visibility {
	private leases = new Map<string, { binding: CodeModeDirectBinding; lease: DirectToolLease }>();
	get names(): string[] { return [...this.leases.keys()]; }
	release(): void {
		const failures: unknown[] = [];
		for (const [name, item] of this.leases) {
			try { item.lease.release(); this.leases.delete(name); } catch (error) { failures.push(error); }
		}
		if (failures.length) throw new Error("Code Mode owner failed to release tool visibility", { cause: failures[0] });
	}
	sync(mode: VisibilityMode, tools: readonly CodeModeTool[]): void {
		try {
			const desired = new Map<string, CodeModeDirectBinding>();
			if (mode === "hide-bridged") for (const tool of tools) {
				const binding = tool.direct;
				if (!binding) continue;
				if (binding.version !== 1 || !isDirectName(binding.name) || typeof binding.acquire !== "function"
					|| desired.has(binding.name)) throw new Error("Invalid/duplicate Code Mode direct binding");
				desired.set(binding.name, binding);
			}
			for (const [name, item] of this.leases) {
				if (desired.get(name) !== item.binding || !item.lease.reconcile()) {
					item.lease.release();
					this.leases.delete(name);
				}
			}
			for (const [name, binding] of desired) {
				if (this.leases.has(name)) continue;
				const lease = binding.acquire();
				if (!lease) continue; // no live, consenting direct owner
				if (typeof lease.reconcile !== "function" || typeof lease.release !== "function") throw new Error("Visibility leases must be synchronous");
				this.leases.set(name, { binding, lease });
			}
		} catch (error) {
			this.release(); // rollback only our receipts, not an old full active set
			throw error;
		}
	}
}
