import type { Usage } from "@earendil-works/pi-ai";

const counters = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const costs = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
export class UsageLedger {
	private pending?: Usage;
	add(value: Usage | undefined): void {
		if (value === undefined) return;
		const valid = (number: unknown) => typeof number === "number" && Number.isFinite(number) && number >= 0;
		if (!value || !value.cost || counters.some((key) => !valid(value[key])) || costs.some((key) => !valid(value.cost[key]))
			|| Object.keys(value).some((key) => ![...counters, "reasoning", "cacheWrite1h", "cost"].includes(key))
			|| Object.keys(value.cost).some((key) => !(costs as readonly string[]).includes(key))
			|| (value.reasoning !== undefined && !valid(value.reasoning))
			|| (value.cacheWrite1h !== undefined && !valid(value.cacheWrite1h))) throw new Error("Invalid contributed usage");
		const next = structuredClone(value);
		if (this.pending) {
			for (const key of counters) next[key] += this.pending[key];
			for (const key of costs) next.cost[key] += this.pending.cost[key];
			for (const key of ["reasoning", "cacheWrite1h"] as const) {
				if (next[key] !== undefined || this.pending[key] !== undefined) next[key] = (next[key] ?? 0) + (this.pending[key] ?? 0);
			}
		}
		if (counters.some((key) => !valid(next[key])) || costs.some((key) => !valid(next.cost[key]))
			|| (next.reasoning !== undefined && !valid(next.reasoning))
			|| (next.cacheWrite1h !== undefined && !valid(next.cacheWrite1h))) throw new Error("Usage overflow");
		this.pending = next;
	}
	take(): Usage | undefined { const value = this.pending; this.pending = undefined; return value; }
}
