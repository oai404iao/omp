import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface DirectBinding {
	readonly version: 1; readonly name: string;
	acquire(): { reconcile(): boolean; release(): void } | undefined;
}
interface Control {
	binding: DirectBinding; readonly activeIntent: boolean | undefined;
	projectActive(active: boolean): boolean | undefined;
	reconcile(): boolean; dispose(): void;
}
interface Factory {
	version: 1; create(pi: ExtensionAPI, options: { name: string; sourcePath: string }): Control;
}
export interface OwnerState {
	identity: string; replaced?: boolean; factory?: Factory; control?: Control;
	transitioning?: boolean; pendingDispose?: () => void; closed?: boolean;
}
export const OWNER_CHANGED = "@oai404iao/pi-code-mode:direct-owner-changed/v1";

function retire(state: OwnerState): void {
	if (state.control && !state.pendingDispose) {
		const old = state.control;
		state.pendingDispose = () => old.dispose();
	}
	state.pendingDispose?.();
	state.pendingDispose = undefined;
	state.control = undefined;
	state.factory = undefined;
}
export function disposeCodeModeOwner(tool: { codeModeOwner?: OwnerState }, close = true): void {
	const state = tool.codeModeOwner;
	if (!state) return;
	if (close) state.closed = true;
	if (state.transitioning) return;
	state.transitioning = true;
	try { retire(state); } finally { state.transitioning = false; }
}

/** Optional v1 bus client. No private-package dependency or global registry. */
export function codeModeOwner(pi: ExtensionAPI, name: string, tool: { registered: boolean; codeModeOwner?: OwnerState },
	expected?: { parameters: unknown; description: string }): Control | undefined {
	if (!["apply_patch", "web_search"].includes(name) || tool.codeModeOwner?.transitioning || tool.codeModeOwner?.closed) return;
	if (!tool.registered) { disposeCodeModeOwner(tool, false); return; }
	const info = pi.getAllTools?.().find((item) => item.name === name);
	if (!info?.sourceInfo || ["builtin", "sdk"].includes(info.sourceInfo.source)
		|| !expected || info.parameters !== expected.parameters || info.description !== expected.description) {
		(tool.codeModeOwner ??= { identity: "" }).replaced = true;
		disposeCodeModeOwner(tool, false);
		return;
	}
	const identity = JSON.stringify([info.sourceInfo, info.description, info.parameters, info.promptGuidelines]);
	const stillOwns = () => {
		const current = pi.getAllTools().find((item) => item.name === name);
		return Boolean(current && current.parameters === expected.parameters
			&& JSON.stringify([current.sourceInfo, current.description, current.parameters, current.promptGuidelines]) === identity);
	};
	const state = tool.codeModeOwner ??= { identity };
	// Never rebind a replaced registration, even if the optional factory reloads.
	if (state.identity !== identity) state.replaced = true;
	if (state.replaced) { disposeCodeModeOwner(tool, false); return; }
	const factories: Factory[] = [];
	pi.events.emit("@oai404iao/pi-code-mode:direct-owner/v1", { version: 1, accept(value: Factory) {
		if (factories.length < 2) factories.push(value);
	} });
	const factory = factories.length === 1 && factories[0]?.version === 1
		&& typeof factories[0].create === "function" ? factories[0] : undefined;
	if (state.closed) return;
	if (!stillOwns()) {
		state.replaced = true;
		disposeCodeModeOwner(tool, false);
		return;
	}
	if (state.pendingDispose || factory !== state.factory || (factory && !state.control)) {
		state.transitioning = true;
		try {
			retire(state);
			if (!stillOwns()) state.replaced = true;
			if (state.closed || state.replaced) return;
			if (factory) {
				const control = factory.create(pi, { name, sourcePath: info.sourceInfo.path });
				if (!control || control.binding?.version !== 1 || control.binding.name !== name
					|| typeof control.binding.acquire !== "function" || typeof control.projectActive !== "function"
					|| typeof control.reconcile !== "function" || typeof control.dispose !== "function") {
					if (typeof control?.dispose === "function") state.pendingDispose = () => control.dispose();
					throw new Error("Invalid Code Mode owner control");
				}
				state.control = control;
				state.factory = factory;
				if (!stillOwns()) state.replaced = true;
				if (state.closed || state.replaced) { retire(state); return; }
			}
		} finally { state.transitioning = false; }
	}
	return state.control;
}
