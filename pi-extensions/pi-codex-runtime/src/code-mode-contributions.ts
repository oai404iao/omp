import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
			discovery.provider({ id, tools: tools(context) });
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
