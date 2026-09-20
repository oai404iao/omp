import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

export const VISIBILITY_CHANGED = "@oai404iao/pi-code-mode:visibility/v1";
export interface DirectToolLease {
	/** Synchronous; false means this registration no longer owns the definition. */
	reconcile(): boolean;
	release(): void;
}
export interface CodeModeDirectBinding {
	readonly version: 1;
	readonly name: string;
	acquire(): DirectToolLease | undefined;
}
export function isDirectName(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value) && !["exec", "wait"].includes(value);
}

/**
 * Owner-side cooperation, not a global active-tools interceptor. sourcePath is
 * the owner's exact Pi sourceInfo.path (normally fileURLToPath(import.meta.url)).
 * Route every owner activation through setActive(), and call reconcile() after
 * registering tools. Dispose before replacing a definition/adapter's semantics.
 */
export function createCodeModeDirectBinding(pi: ExtensionAPI, options: { name: string; sourcePath: string }) {
	const { name, sourcePath } = options;
	if (!isDirectName(name) || !sourcePath || sourcePath.startsWith("<builtin:")) throw new Error("Invalid Code Mode direct binding");
	let disposed = false;
	let identity: string | undefined;
	let held = false;
	let restore = false;
	let index = 0;
	const fingerprint = (tool: ToolInfo) => JSON.stringify([tool.sourceInfo, tool.description, tool.parameters, tool.promptGuidelines]);
	const owns = () => {
		if (disposed) return false;
		const tool = pi.getAllTools().find((item) => item.name === name);
		if (!tool || tool.sourceInfo.path !== sourcePath || ["builtin", "sdk"].includes(tool.sourceInfo.source)) return false;
		const current = fingerprint(tool);
		identity ??= current;
		return current === identity;
	};
	const change = (active: boolean) => {
		const current = pi.getActiveTools();
		if (current.includes(name) === active) return;
		const next = current.filter((item) => item !== name);
		if (active) next.splice(Math.min(index, next.length), 0, name);
		pi.setActiveTools(next);
	};
	const reconcile = () => {
		if (!owns()) return false;
		if (held) change(false);
		return true;
	};
	const release = () => {
		if (!held) return;
		// Only restore a removal/activation intent owned by this lease. Do not
		// turn off a foreign reactivation, or touch a replaced definition.
		if (restore && owns()) change(true);
		held = false;
	};
	return {
		binding: Object.freeze({
			version: 1 as const, name,
			acquire(): DirectToolLease | undefined {
				if (held || !owns()) return undefined;
				const current = pi.getActiveTools();
				index = current.indexOf(name);
				restore = index >= 0;
				if (index < 0) index = current.length;
				held = true;
				try { reconcile(); } catch (error) { release(); throw error; }
				let live = true;
				return {
					reconcile: () => live && reconcile(),
					release: () => { if (live) { release(); live = false; } },
				};
			},
		}) satisfies CodeModeDirectBinding,
		setActive(active: boolean): boolean {
			if (!owns()) return false;
			if (held) { restore = active; change(false); }
			else { index = pi.getActiveTools().length; change(active); }
			pi.events.emit(VISIBILITY_CHANGED, { version: 1 });
			return true;
		},
		reconcile() {
			const current = reconcile();
			if (!disposed) pi.events.emit(VISIBILITY_CHANGED, { version: 1 });
			return current;
		},
		dispose() {
			if (!disposed) { release(); disposed = true; pi.events.emit(VISIBILITY_CHANGED, { version: 1 }); }
		},
	};
}
