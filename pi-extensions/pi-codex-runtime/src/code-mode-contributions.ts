import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCodexBroker } from "./broker.js";
import { codeModeOwner, type DirectBinding } from "./code-mode-owner.js";
import type { PackageToolName } from "./capabilities.js";

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
	direct?: DirectBinding;
	invoke(input: unknown, context: NestedCodeModeContext): Promise<{ value: unknown }>;
}

/** Structural client for the optional v1 bus contract. Neither side installs
 * the other package; all authority still comes from Code Mode's exact grants. */
export function registerCodeModeContribution(pi: ExtensionAPI, id: string,
	tools: (context: ExtensionContext) => readonly OwnedCodeModeTool[]): void {
	let context: ExtensionContext | undefined;
	let disposed = false;
	const changed = () => pi.events.emit("@oai404iao/pi-code-mode:changed/v1", { version: 1 });
	const off = pi.events.on("@oai404iao/pi-code-mode:discover/v1", (value) => {
		const discovery = value as { version?: number; provider?: (provider: unknown) => void } | undefined;
		if (!disposed && context && discovery?.version === 1 && typeof discovery.provider === "function") {
			const broker = getCodexBroker(pi);
			discovery.provider({ id, tools: tools(context).map((tool) => {
				const owned = broker.tools.get(tool.name as PackageToolName);
				return { ...tool, direct: owned ? codeModeOwner(pi, tool.name, owned, broker.codeModeDefinitions?.get(tool.name))?.binding : undefined };
			}) });
		}
	});
	const update = (_event: unknown, ctx: ExtensionContext) => {
		if (disposed) return;
		context = ctx;
		changed();
	};
	pi.on("session_start", update);
	pi.on("model_select", update);
	pi.on("session_shutdown", () => {
		if (disposed) return;
		disposed = true; context = undefined; off(); changed();
	});
}
