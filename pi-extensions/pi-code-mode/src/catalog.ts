import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DISCOVER, OBSERVERS, APPROVALS, type CodeModeApproval, type CodeModeObserver, type CodeModeProvider, type CodeModePolicy, type CodeModeTool, type Discovery } from "./contributions.ts";
import { LIMITS } from "./limits.ts";
import { schemaType } from "./schema-description.ts";

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
export interface Catalog { tools: CodeModeTool[]; policies: CodeModePolicy[]; observers?: readonly CodeModeObserver[]; approvals?: readonly CodeModeApproval[] }
export function collect(pi: ExtensionAPI): Catalog {
	const providers: CodeModeProvider[] = [];
	const policies: CodeModePolicy[] = [];
	const observers: CodeModeObserver[] = [];
	const approvals: CodeModeApproval[] = [];
	let overflow = false;
	pi.events.emit(DISCOVER, { version: 1,
		provider: (value) => { if (providers.length >= 32) overflow = true; else providers.push(value); },
		policy: (value) => { if (policies.length >= 16) overflow = true; else policies.push(value); },
	} satisfies Discovery);
	pi.events.emit(OBSERVERS, { version: 1, accept(value: CodeModeObserver) {
		if (observers.length >= 16) overflow = true; else observers.push(value);
	} });
	pi.events.emit(APPROVALS, { version: 1, accept(value: CodeModeApproval) {
		if (approvals.length >= 16) overflow = true; else approvals.push(value);
	} });
	if (overflow) throw new Error("Code Mode discovery budget exceeded");
	const owners = new Set<string>();
	const names = new Set<string>();
	const tools: CodeModeTool[] = [];
	for (const provider of providers) {
		if (!component(provider.id) || owners.has(provider.id) || !Array.isArray(provider.tools)) throw new Error("Invalid/duplicate Code Mode provider");
		owners.add(provider.id);
		for (const tool of provider.tools) {
			const name = `${provider.id}__${tool.name}`;
			if (!component(tool.name) || names.has(name) || typeof tool.description !== "string"
				|| !tool.description || tool.description.length > 2000 || tool.parameters?.type !== "object"
				|| !["read", "write", "process"].includes(tool.effect) || typeof tool.invoke !== "function"
				|| (tool.parallel && tool.effect !== "read")
				|| (tool.approval !== undefined && !component(tool.approval))) throw new Error(`Invalid Code Mode tool: ${name}`);
			names.add(name);
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
		if (!component(policy.id) || policyNames.has(policy.id)
			|| (!policy.before && !policy.after && !policy.approval)
			|| (policy.approval !== undefined && !component(policy.approval))
			|| (policy.before !== undefined && typeof policy.before !== "function")
			|| (policy.after !== undefined && typeof policy.after !== "function")) throw new Error("Invalid/duplicate Code Mode policy");
		policyNames.add(policy.id);
	}
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
	return { tools, policies: policies.map((p) => Object.freeze({ ...p })).sort((a, b) => a.id.localeCompare(b.id)),
		approvals: approvals.map((a) => Object.freeze({ ...a })),
		observers: observers.map((o) => Object.freeze({ ...o })).sort((a, b) => a.id.localeCompare(b.id)) };
}
export function toolPrompt(tools: readonly CodeModeTool[]): string {
	const text = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map((tool) =>
		`tools.${tool.name}(args: ${schemaType(tool.parameters)}): Promise<${schemaType(tool.outputSchema)}>;\n${tool.description}`).join("\n");
	if (Buffer.byteLength(text) > LIMITS.catalogBytes) throw new Error("Code Mode tool catalog exceeds prompt budget; authorize fewer tools");
	return text;
}
