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
	let schema: unknown;
	let held = false;
	let restore = false;
	let restoredByLease = false;
	let restoreAfterTree = false;
	let index = 0;
	const fingerprint = (tool: ToolInfo) => JSON.stringify([tool.sourceInfo, tool.description, tool.parameters, tool.promptGuidelines]);
	const owns = () => {
		if (disposed) return false;
		const tool = pi.getAllTools().find((item) => item.name === name);
		if (!tool || tool.sourceInfo.path !== sourcePath || ["builtin", "sdk"].includes(tool.sourceInfo.source)) return false;
		const current = fingerprint(tool);
		if (identity === undefined) { identity = current; schema = tool.parameters; }
		return current === identity && schema === tool.parameters;
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
		restoredByLease = restore && owns();
		if (restoredByLease) change(true);
		held = false;
	};
	const beforeTree = pi.on("session_before_tree", () => {
		restoreAfterTree = restoredByLease && !held && owns() && pi.getActiveTools().includes(name);
	});
	const afterTree = pi.on("session_tree", () => {
		// Pi restores historical tool loadouts before this event. A past leased
		// omission must not undo this owner's already-released restoration.
		if (restoreAfterTree && restoredByLease && !held && owns()) {
			change(true);
			pi.events.emit(VISIBILITY_CHANGED, { version: 1 });
		}
		restoreAfterTree = false;
	});
	return {
		binding: Object.freeze({
			version: 1 as const, name,
			acquire(): DirectToolLease | undefined {
				if (held || !owns()) return undefined;
				restoredByLease = false;
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
		get activeIntent(): boolean | undefined { return owns() ? held ? restore : pi.getActiveTools().includes(name) : undefined; },
		/** Batch activation: update logical intent without writing the registry.
		 * undefined means ownership was lost; preserve the replacement's state. */
		projectActive(active: boolean): boolean | undefined {
			if (!owns()) return undefined;
			if (held) { restore = active; return false; }
			restoredByLease = false;
			return active;
		},
		setActive(active: boolean): boolean {
			if (!owns()) return false;
			if (held) { restore = active; change(false); }
			else { restoredByLease = false; index = pi.getActiveTools().length; change(active); }
			pi.events.emit(VISIBILITY_CHANGED, { version: 1 });
			return true;
		},
		reconcile() {
			const current = reconcile();
			if (!disposed) pi.events.emit(VISIBILITY_CHANGED, { version: 1 });
			return current;
		},
		dispose() {
			if (!disposed) { beforeTree(); afterTree(); release(); disposed = true; pi.events.emit(VISIBILITY_CHANGED, { version: 1 }); }
		},
	};
}
