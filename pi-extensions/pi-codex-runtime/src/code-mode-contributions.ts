import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCodexBroker } from "./broker.js";
import { codeModeOwner, type DirectBinding } from "./code-mode-owner.js";
import type { PackageToolName } from "./capabilities.js";
import { randomUUID } from "node:crypto";

/** Unique public schema reference proves which registration won Pi's registry.
 * If a future Pi clones metadata, cooperation fails closed instead of claiming
 * a name/source belonging to another extension. */
export function registerCodeModeOwnedTool(pi: ExtensionAPI, definition: Record<string, unknown>): void {
	if (typeof definition.name !== "string" || typeof definition.description !== "string"
		|| !definition.parameters || typeof definition.parameters !== "object") throw new Error("Invalid owned Code Mode tool definition");
	const broker = getCodexBroker(pi);
	const owned = { ...definition, name: definition.name, description: definition.description, parameters: { ...definition.parameters } };
	(broker.codeModeDefinitions ??= new Map()).set(owned.name, owned);
	pi.registerTool(owned as never);
}

export interface NestedCodeModeContext {
	readonly cellId: string;
	readonly toolCallId: string;
	readonly cwd: string;
	readonly signal: AbortSignal;
	readonly pi?: ExtensionContext;
}
export interface OwnedCodeModeTool {
	name: string;
	description: string;
	parameters: unknown;
	effect: "read" | "write";
	parallel?: boolean;
	requires?: readonly string[];
	requiredPolicies?: readonly string[];
	approval?: string;
	availability?: { state: "available" | "unavailable" | "not-ready" | "failed"; reason?: string };
	direct?: DirectBinding;
	invoke(input: unknown, context: NestedCodeModeContext): Promise<{ value: unknown }>;
}
const unavailableInvoke = async (): Promise<{ value: unknown }> => { throw new Error("Code Mode tool requirements were not negotiated"); };

/** Structural client for the optional v2/v1 bus contract. Neither side installs
 * the other package; all authority still comes from Code Mode's exact grants. */
export function registerCodeModeContribution(pi: ExtensionAPI, id: string,
	tools: (context: ExtensionContext) => readonly OwnedCodeModeTool[]): void {
	let context: ExtensionContext | undefined;
	let disposed = false;
	let resolved: readonly OwnedCodeModeTool[] | undefined;
	let registration: Readonly<{ owner: string; instanceId: string; revision: number }> = Object.freeze({ owner: id, instanceId: randomUUID(), revision: 1 });
	let accepted = new WeakSet<object>();
	const generations = new Map<string, number>();
	const changed = (phase: "withdrawn" | "ready" | "disposed") => {
		const change = Object.freeze({ protocol: 2, registration, kind: "execution", phase });
		pi.events.emit("@oai404iao/pi-code-mode:changed/v2", change);
		pi.events.emit("@oai404iao/pi-code-mode:changed/v1", { version: 1, change });
	};
	const snapshot = (features: readonly unknown[] = [], legacy = false) => {
		const broker = getCodexBroker(pi);
		const offered = context ? (resolved ??= tools(context).map((tool) => ({ ...tool }))) : [];
		if (offered.length > 64) throw new Error("Code Mode declaration budget exceeded");
		return { id, tools: offered.filter((tool) => !legacy || (!tool.requires?.length && !tool.requiredPolicies?.length
			&& tool.approval === undefined && (!tool.availability || tool.availability.state === "available"))).map((tool) => {
			const requires = [...new Set([...(tool.requires ?? []), ...(tool.approval ? ["approval/1"] : []),
				...(tool.requiredPolicies?.length ? ["required-policies/1"] : [])])];
			if (requires.length > 32 || requires.some((feature) => typeof feature !== "string" || feature.length > 128))
				throw new Error("Invalid Code Mode feature requirements");
			if (requires.some((feature) => !features.includes(feature)) || (tool.availability && tool.availability.state !== "available"))
				return { ...tool, requires, direct: undefined, invoke: unavailableInvoke };
			const owned = broker.tools.get(tool.name as PackageToolName);
			return { ...tool, direct: owned ? codeModeOwner(pi, tool.name, owned, broker.codeModeDefinitions?.get(tool.name))?.binding : undefined };
		}) };
	};
	const offV2 = pi.events.on("@oai404iao/pi-code-mode:discover/v2", (value) => {
		const request = value as { hello?: { protocol?: number; instanceId?: string; generation?: number; features?: unknown[] };
			offer?: (offer: unknown) => { status: string } } | undefined;
		const hello = request?.hello;
		if (disposed || !hello || hello.protocol !== 2 || !hello.instanceId || hello.instanceId.length > 128
			|| !Number.isSafeInteger(hello.generation) || hello.generation! < 1 || !Array.isArray(hello.features)
			|| hello.features.length > 32 || typeof request?.offer !== "function") return;
		const previous = generations.get(hello.instanceId);
		if ((previous !== undefined && hello.generation! < previous) || (previous === undefined && generations.size >= 64)) return;
		generations.set(hello.instanceId, hello.generation!);
		try {
			const provider = snapshot(hello.features);
			const availability = { state: context ? "available" : "not-ready" };
			if (request.offer({ kind: "provider", registration, requires: [], availability, provider }).status === "compatible") accepted.add(hello);
		} catch {
			request.offer({ kind: "provider", registration, requires: [], availability: { state: "failed", reason: "owner-not-ready" }, provider: { id, tools: [] } });
		}
	});
	const off = pi.events.on("@oai404iao/pi-code-mode:discover/v1", (value) => {
		const discovery = value as { version?: number; provider?: (provider: unknown) => void;
			consumer?: object; receipts?: { registration: object; consumer: object }[] } | undefined;
		if (!disposed && context && discovery?.version === 1 && typeof discovery.provider === "function") {
			if (discovery.consumer) {
				const hello = discovery.consumer as { protocol?: number; instanceId?: string; generation?: number };
				if (hello.protocol !== 2 || typeof hello.instanceId !== "string" || !hello.instanceId || hello.instanceId.length > 128
					|| !Number.isSafeInteger(hello.generation) || hello.generation! < 1) return;
				const previous = generations.get(hello.instanceId);
				if ((previous !== undefined && hello.generation! < previous) || (previous === undefined && generations.size >= 64)) return;
				generations.set(hello.instanceId, hello.generation!);
			}
			if (discovery.consumer && accepted.has(discovery.consumer) && Array.isArray(discovery.receipts) && discovery.receipts.length <= 80
				&& discovery.receipts.some((receipt) => receipt.consumer === discovery.consumer && receipt.registration === registration)) return;
			discovery.provider(snapshot([], true));
		}
	});
	const update = (_event: unknown, ctx: ExtensionContext) => {
		if (disposed) return;
		context = undefined;
		resolved = undefined;
		changed("withdrawn");
		context = ctx;
		registration = Object.freeze({ ...registration, revision: registration.revision + 1 });
		accepted = new WeakSet();
		changed("ready");
	};
	pi.on("session_start", update);
	pi.on("model_select", update);
	pi.on("session_tree", update);
	pi.on("session_shutdown", () => {
		if (disposed) return;
		disposed = true; context = undefined; off(); offV2(); changed("disposed");
	});
}
