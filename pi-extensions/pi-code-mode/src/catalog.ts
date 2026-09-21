import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DISCOVER, OBSERVERS, APPROVALS, type CodeModeApproval, type CodeModeObserver, type CodeModeProvider, type CodeModePolicy, type CodeModeTool, type Discovery } from "./contributions.ts";
import { LIMITS } from "./limits.ts";
import { schemaType } from "./schema-description.ts";
import { DISCOVER_V2, isPolicyId, requiredPolicyIds, features, availability, type DiscoveryReceipt, type DiscoveryV2, type Registration } from "./discovery.ts";
import { DiscoveryState } from "./discovery-state.ts";

const identifier = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const component = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && identifier.test(value);
export function isContributionName(name: string): boolean {
	const parts = name.split("__");
	return parts.length === 2 && parts.every(component);
}
export function frozen<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) frozen(item);
		Object.freeze(value);
	}
	return value;
}
export interface CatalogDiagnostic { name: string; state: "available" | "unavailable" | "incompatible" | "legacy"; reason?: string }
export interface Catalog { tools: CodeModeTool[]; policies: CodeModePolicy[]; observers?: readonly CodeModeObserver[]; approvals?: readonly CodeModeApproval[]; diagnostics?: readonly CatalogDiagnostic[] }
export function collect(pi: ExtensionAPI, requiredPolicies: readonly string[] = [], state = new DiscoveryState()): Catalog {
	const required = requiredPolicyIds(requiredPolicies);
	const providers: CodeModeProvider[] = [];
	const policies: CodeModePolicy[] = [];
	const observers: CodeModeObserver[] = [];
	const approvals: CodeModeApproval[] = [];
	let overflow = false;
	let invalid = false;
	let invalidReason = "Invalid/duplicate/incompatible or not-ready Code Mode discovery registration";
	const hello = state.hello();
	const diagnostics: CatalogDiagnostic[] = [];
	const v2Owners = new Set<string>();
	let declarations = 0;
	let declarationFailure: string | undefined;
	const declarationError = (message: string): never => { declarationFailure = message; throw new Error(message); };
	const checkProvider = (provider: CodeModeProvider) => {
		if (!Array.isArray(provider.tools) || provider.tools.length > 64 || (declarations += provider.tools.length) > 64)
			declarationError("Code Mode declaration budget exceeded");
		for (const tool of provider.tools) {
			if (typeof tool?.description !== "string" || tool.description.length > 2000
				|| !tool.parameters || Buffer.byteLength(JSON.stringify(tool.parameters)) > 8000)
				declarationError("Code Mode declaration schema/description budget exceeded");
			if (tool.outputSchema !== undefined && Buffer.byteLength(JSON.stringify(tool.outputSchema)) > 8000)
				declarationError("Invalid contribution output schema/budget");
		}
	};
	const receipts: DiscoveryReceipt[] = [];
	const registrations = new Set<string>();
	const pendingPolicies = new Map<string, Registration>();
	let attempts = 0;
	let discovering = true;
	pi.events.emit(DISCOVER_V2, { hello, offer(value) {
		if (!discovering) return { status: "incompatible" };
		if (++attempts > 128) { overflow = true; return { status: "incompatible" }; }
		try {
			const { registration, requires } = value;
			const key = `${value.kind}:${registration.owner}`;
			const pending = pendingPolicies.get(key);
			if (!(value.kind === "policy" ? isPolicyId(registration.owner) : component(registration.owner)) || typeof registration.instanceId !== "string"
				|| !registration.instanceId || registration.instanceId.length > 128
				|| !Number.isSafeInteger(registration.revision) || registration.revision < 1
				|| (registrations.has(key) && pending !== registration)) throw new Error("Invalid/duplicate Code Mode registration");
			features(requires);
			state.mark(value.kind, registration);
			registrations.add(key);
			if (value.kind === "provider") checkProvider(value.provider);
			const available = availability(value.availability);
			if (value.kind === "policy" && value.availability) {
				const { state, reason } = value.availability;
				if (reason !== undefined && (typeof reason !== "string" || reason.length > 256)) throw new Error("Invalid policy reason");
				if (state === "not-ready") {
					if (pending || pendingPolicies.size + policies.length >= 16) throw new Error("Duplicate/oversized pending policies");
					pendingPolicies.set(key, registration);
					return { status: "unavailable" };
				}
				if (state === "failed" || state === "unavailable") { invalid = true; return { status: "unavailable" }; }
				if (state !== "available") throw new Error("Invalid policy availability");
			}
			const missing = requires.filter((feature) => !hello.features.includes(feature));
			if (missing.length) {
				// An incompatible global policy cannot disappear from enforcement.
				if (value.kind === "policy") invalid = true;
				diagnostics.push({ name: registration.owner, state: "incompatible", reason: missing.join(",") });
				return { status: "incompatible", missing };
			}
			if (value.kind !== "policy" && available.state !== "available") {
				diagnostics.push({ name: registration.owner, state: "unavailable", reason: available.reason ?? available.state });
				return { status: "unavailable" };
			}
			if (value.kind === "provider" && registration.owner === value.provider.id && providers.length < 32) {
				state.observe(value.kind, registration, value.provider);
				providers.push(value.provider); v2Owners.add(value.provider.id);
			}
			else if (value.kind === "policy" && value.policy && registration.owner === value.policy.id && policies.length < 16) {
				state.observe(value.kind, registration, value.policy);
				policies.push(value.policy);
				pendingPolicies.delete(key);
			}
			else if (value.kind === "approval" && value.approval.id === registration.owner && approvals.length < 16) {
				state.observe(value.kind, registration, value.approval); approvals.push(value.approval);
			}
			else if (value.kind === "observer" && value.observer.id === registration.owner && observers.length < 16) {
				state.observe(value.kind, registration, value.observer); observers.push(value.observer);
			}
			else throw new Error("Invalid Code Mode offer/budget");
			receipts.push(Object.freeze({ registration, consumer: hello }));
			return { status: "compatible" };
		} catch {
			// Pi's bus swallows listener errors; latch failure before returning.
			invalid = true;
			if (["provider", "policy", "observer", "approval"].includes(value?.kind))
				invalidReason = `Invalid/duplicate Code Mode ${value.kind} registration`;
			return { status: "incompatible" };
		}
	} } satisfies DiscoveryV2);
	discovering = false;
	pi.events.emit(DISCOVER, { version: 1,
		consumer: hello, receipts: Object.freeze(receipts),
		provider: (value) => {
			if (state.hasOwner("provider", value?.id)) { invalid = true; return; }
			try { checkProvider(value); } catch { overflow = true; return; }
			if (providers.length >= 32) overflow = true; else providers.push(value);
		},
		policy: (value) => {
			if (state.hasOwner("policy", value?.id)) { invalid = true; return; }
			if (policies.length >= 16) overflow = true; else policies.push(value);
		},
	} satisfies Discovery);
	pi.events.emit(OBSERVERS, { version: 1, consumer: hello, receipts, accept(value: CodeModeObserver) {
		if (state.hasOwner("observer", value?.id)) { invalid = true; return; }
		if (observers.length >= 16) overflow = true; else observers.push(value);
	} });
	pi.events.emit(APPROVALS, { version: 1, consumer: hello, receipts, accept(value: CodeModeApproval) {
		if (state.hasOwner("approval", value?.id)) { invalid = true; return; }
		if (approvals.length >= 16) overflow = true; else approvals.push(value);
	} });
	if (declarationFailure) throw new Error(declarationFailure);
	if (overflow) throw new Error("Code Mode discovery budget exceeded");
	if (invalid || pendingPolicies.size) throw new Error(invalidReason);
	const owners = new Set<string>();
	const names = new Set<string>();
	const tools: CodeModeTool[] = [];
	for (const provider of providers) {
		if (!component(provider.id) || owners.has(provider.id) || !Array.isArray(provider.tools)) throw new Error("Invalid/duplicate Code Mode provider");
		owners.add(provider.id);
		const missingFeatures = features(provider.requires ?? []).filter((feature) => !hello.features.includes(feature));
		if (availability(provider.availability).state !== "available" || missingFeatures.length) {
			diagnostics.push({ name: provider.id, state: missingFeatures.length ? "incompatible" : "unavailable", reason: missingFeatures.join(",") || provider.availability?.reason });
			continue;
		}
		for (const tool of provider.tools) {
			const name = `${provider.id}__${tool.name}`;
			if (!component(tool.name) || names.has(name) || typeof tool.description !== "string"
				|| !tool.description || tool.description.length > 2000 || tool.parameters?.type !== "object"
				|| !["read", "write", "process"].includes(tool.effect) || typeof tool.invoke !== "function"
				|| (tool.parallel && tool.effect !== "read")
				|| (tool.approval !== undefined && !component(tool.approval))) throw new Error(`Invalid Code Mode tool: ${name}`);
			names.add(name);
			const missing = features(tool.requires ?? []).filter((feature) => !hello.features.includes(feature));
			const available = availability(tool.availability);
			const expected = requiredPolicyIds(tool.requiredPolicies ?? []);
			const absent = expected.filter((id) => !policies.some((policy) => policy.id === id));
			if (missing.length || available.state !== "available" || absent.length) {
				diagnostics.push({ name, state: missing.length ? "incompatible" : "unavailable",
					reason: missing.join(",") || (absent.length ? `missing-policy:${absent.join(",")}` : available.reason ?? available.state) });
				continue;
			}
			diagnostics.push({ name, state: v2Owners.has(provider.id) ? "available" : "legacy" });
			const parameters = frozen(structuredClone(tool.parameters));
			if (Buffer.byteLength(JSON.stringify(parameters)) > 8000) throw new Error("Contribution schema budget exceeded");
			const outputSchema = tool.outputSchema === undefined ? undefined : frozen(structuredClone(tool.outputSchema));
			if (outputSchema !== undefined && (!outputSchema || typeof outputSchema !== "object"
				|| Array.isArray(outputSchema) || Buffer.byteLength(JSON.stringify(outputSchema)) > 8000)) throw new Error("Invalid contribution output schema/budget");
			tools.push(Object.freeze({ ...tool, name, parameters, outputSchema }));
			if (tools.length > 64) throw new Error("Contribution tool budget exceeded");
		}
	}
	const policyNames = new Set<string>();
	for (const policy of policies) {
		if (features(policy.requires ?? []).some((feature) => !hello.features.includes(feature))) throw new Error("Incompatible Code Mode policy features");
		if (!isPolicyId(policy.id) || policyNames.has(policy.id)
			|| (!policy.before && !policy.after && !policy.approval)
			|| (policy.approval !== undefined && !component(policy.approval))
			|| (policy.before !== undefined && typeof policy.before !== "function")
			|| (policy.after !== undefined && typeof policy.after !== "function")) throw new Error("Invalid/duplicate Code Mode policy");
		policyNames.add(policy.id);
	}
	const missingPolicies = required.filter((id) => !policyNames.has(id));
	if (missingPolicies.length) throw new Error(`Missing required Code Mode policies: ${missingPolicies.join(", ")}`);
	const observerIds = new Set<string>();
	for (const observer of observers) {
		if (!component(observer.id) || observerIds.has(observer.id) || typeof observer.complete !== "function") throw new Error("Invalid/duplicate Code Mode observer");
		observerIds.add(observer.id);
	}
	const approvalIds = new Set<string>();
	for (const approval of approvals) {
		if (!component(approval.id) || approvalIds.has(approval.id) || typeof approval.approve !== "function") throw new Error("Invalid/duplicate Code Mode approval");
		approvalIds.add(approval.id);
	}
	for (const policy of policies) {
		if (policy.approval && !approvalIds.has(policy.approval)) throw new Error(`Code Mode policy approval unavailable: ${policy.id}`);
	}
	if (state.hello().generation !== hello.generation) throw new Error("Code Mode discovery generation changed during collection");
	return { tools, policies: policies.map((p) => Object.freeze({ ...p })).sort((a, b) => a.id.localeCompare(b.id)),
		approvals: approvals.map((a) => Object.freeze({ ...a })),
		observers: observers.map((o) => Object.freeze({ ...o })).sort((a, b) => a.id.localeCompare(b.id)),
		...(diagnostics.length ? { diagnostics } : {}) };
}
export function toolPrompt(tools: readonly CodeModeTool[]): string {
	const text = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map((tool) =>
		`tools.${tool.name}(args: ${schemaType(tool.parameters)}): Promise<${schemaType(tool.outputSchema)}>;\n${tool.description}`).join("\n");
	if (Buffer.byteLength(text) > LIMITS.catalogBytes) throw new Error("Code Mode tool catalog exceeds prompt budget; authorize fewer tools");
	return text;
}
