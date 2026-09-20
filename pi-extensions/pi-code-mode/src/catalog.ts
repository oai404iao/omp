import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DISCOVER, type CodeModeProvider, type CodeModePolicy, type CodeModeTool, type Discovery } from "./contributions.ts";
import { LIMITS } from "./limits.ts";

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
export interface Catalog { tools: CodeModeTool[]; policies: CodeModePolicy[] }
export function collect(pi: ExtensionAPI): Catalog {
	const providers: CodeModeProvider[] = [];
	const policies: CodeModePolicy[] = [];
	let overflow = false;
	pi.events.emit(DISCOVER, { version: 1,
		provider: (value) => { if (providers.length >= 32) overflow = true; else providers.push(value); },
		policy: (value) => { if (policies.length >= 16) overflow = true; else policies.push(value); },
	} satisfies Discovery);
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
				|| (tool.parallel && tool.effect !== "read")) throw new Error(`Invalid Code Mode tool: ${name}`);
			names.add(name);
			const parameters = frozen(structuredClone(tool.parameters));
			if (Buffer.byteLength(JSON.stringify(parameters)) > 8000) throw new Error("Contribution schema budget exceeded");
			tools.push(Object.freeze({ ...tool, name, parameters }));
			if (tools.length > 64) throw new Error("Contribution tool budget exceeded");
		}
	}
	const policyNames = new Set<string>();
	for (const policy of policies) {
		if (!component(policy.id) || policyNames.has(policy.id)
			|| (!policy.before && !policy.after)
			|| (policy.before !== undefined && typeof policy.before !== "function")
			|| (policy.after !== undefined && typeof policy.after !== "function")) throw new Error("Invalid/duplicate Code Mode policy");
		policyNames.add(policy.id);
	}
	return { tools, policies: policies.map((p) => Object.freeze({ ...p })).sort((a, b) => a.id.localeCompare(b.id)) };
}
export function toolPrompt(tools: readonly CodeModeTool[]): string {
	const text = tools.map((tool) => `tools.${tool.name}: ${tool.description}\nArguments: ${JSON.stringify(tool.parameters)}`).join("\n");
	if (Buffer.byteLength(text) > LIMITS.catalogBytes) throw new Error("Code Mode tool catalog exceeds prompt budget; authorize fewer tools");
	return text;
}
