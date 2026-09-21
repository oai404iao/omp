import { randomUUID } from "node:crypto";
import type { CodeModeProvider, CodeModePolicy, CodeModeApproval, CodeModeObserver } from "./contributions.ts";
import { FEATURES, type ConsumerHello, type Registration } from "./discovery.ts";
import { LIMITS } from "./limits.ts";
import type { Catalog } from "./catalog.ts";

interface Contract { json: string; references: unknown[] }
export function providerContract(provider: CodeModeProvider): Contract {
	return {
		json: JSON.stringify([provider.requires, provider.availability, provider.tools.map((tool) => [
			tool.name, tool.parameters, tool.effect, tool.parallel, tool.approval, tool.requires, tool.requiredPolicies, tool.availability,
		])]),
		references: provider.tools.flatMap((tool) => [tool.prepare, tool.invoke, tool.direct]),
	};
}
export function sameContract(a: Contract, b: Contract): boolean {
	return a.json === b.json && a.references.length === b.references.length && a.references.every((value, i) => value === b.references[i]);
}
export function sameExecutableCatalog(a: Catalog, b: Catalog): boolean {
	const tools = (catalog: Catalog) => providerContract({ id: "snapshot", tools: [...catalog.tools].sort((x, y) => x.name.localeCompare(y.name)) });
	if (!sameContract(tools(a), tools(b))) return false;
	const callbacks = (catalog: Catalog) => [
		...catalog.policies.map((p) => [p.id, p.approval, JSON.stringify(p.requires), p.before, p.after]).flat(),
		...[...(catalog.approvals ?? [])].sort((x, y) => x.id.localeCompare(y.id)).map((p) => [p.id, p.approve]).flat(),
	];
	const x = callbacks(a), y = callbacks(b);
	return x.length === y.length && x.every((value, i) => value === y[i]);
}

/** Instance-local, bounded history. Nothing here is restored from transcript. */
export class DiscoveryState {
	readonly instanceId = randomUUID();
	private generation = 1;
	private revisions = new Map<string, { revision: number; contract?: Contract; withdrawnThrough?: number }>();
	advance(): void {
		if (!Number.isSafeInteger(++this.generation)) throw new Error("Code Mode generation exhausted");
	}
	hello(): ConsumerHello {
		return Object.freeze({ protocol: 2, instanceId: this.instanceId, generation: this.generation, features: FEATURES,
			limits: Object.freeze({ resultBytes: LIMITS.resultBytes, callsPerCell: LIMITS.calls, maxCells: LIMITS.maxCells }) });
	}
	isStale(kind: string, registration: Registration): boolean {
		const previous = this.revisions.get(`${kind}:${registration.owner}:${registration.instanceId}`);
		return previous !== undefined && registration.revision < previous.revision;
	}
	hasOwner(kind: string, owner: string): boolean {
		const prefix = `${kind}:${owner}:`;
		return [...this.revisions.keys()].some((key) => key.startsWith(prefix));
	}
	mark(kind: string, registration: Registration): void {
		const key = `${kind}:${registration.owner}:${registration.instanceId}`;
		const previous = this.revisions.get(key);
		if (previous && registration.revision < previous.revision) throw new Error("Code Mode stale registration revision");
		if (!previous && this.revisions.size >= 256) throw new Error("Code Mode registration history budget exceeded");
		if (!previous || registration.revision > previous.revision)
			this.revisions.set(key, { revision: registration.revision, withdrawnThrough: previous?.withdrawnThrough });
	}
	withdraw(kind: string, registration: Registration): void {
		this.mark(kind, registration);
		const record = this.revisions.get(`${kind}:${registration.owner}:${registration.instanceId}`)!;
		record.withdrawnThrough = registration.revision;
	}
	observe(kind: string, registration: Registration, value: CodeModeProvider | CodeModePolicy | CodeModeApproval | CodeModeObserver): void {
		const key = `${kind}:${registration.owner}:${registration.instanceId}`;
		this.mark(kind, registration);
		const contract = kind === "provider" ? providerContract(value as CodeModeProvider)
			: { json: JSON.stringify([(value as CodeModePolicy).approval, (value as CodeModePolicy).requires]),
				references: [(value as CodeModePolicy).before, (value as CodeModePolicy).after,
					(value as CodeModeApproval).approve, (value as CodeModeObserver).complete] };
		const previous = this.revisions.get(key);
		if (previous?.withdrawnThrough !== undefined && registration.revision <= previous.withdrawnThrough)
			throw new Error("Code Mode withdrawn registration revision");
		if (previous && (registration.revision < previous.revision
			|| (registration.revision === previous.revision && previous.contract && !sameContract(contract, previous.contract))))
			throw new Error("Code Mode stale revision or unannounced executable replacement");
		if (!previous && this.revisions.size >= 256) throw new Error("Code Mode registration history budget exceeded");
		this.revisions.set(key, { revision: registration.revision, contract, withdrawnThrough: previous?.withdrawnThrough });
	}
}
