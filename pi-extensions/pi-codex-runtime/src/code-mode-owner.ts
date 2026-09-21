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
	transitioning?: boolean; pendingDispose?: () => void;
}
export const OWNER_CHANGED = "@oai404iao/pi-code-mode:direct-owner-changed/v1";
/** Optional v1 bus client. No private-package dependency or global registry. */
export function codeModeOwner(pi: ExtensionAPI, name: string, tool: { registered: boolean; codeModeOwner?: OwnerState },
	expected?: { parameters: unknown; description: string }): Control | undefined {
	if (!["apply_patch", "web_search"].includes(name) || !tool.registered) return;
	const info = pi.getAllTools?.().find((item) => item.name === name);
	if (!info?.sourceInfo || ["builtin", "sdk"].includes(info.sourceInfo.source)) return tool.codeModeOwner?.control;
	if (!expected || info.parameters !== expected.parameters || info.description !== expected.description) {
		if (expected) (tool.codeModeOwner ??= { identity: "" }).replaced = true;
		return;
	}
	const identity = JSON.stringify([info.sourceInfo, info.description, info.parameters, info.promptGuidelines]);
	const state = tool.codeModeOwner ??= { identity };
	if (state.transitioning) return;
	// Never rebind a replaced registration, even if the optional factory reloads.
	if (state.identity !== identity) { state.replaced = true; return state.control; }
	if (state.replaced) return state.control;
	const factories: Factory[] = [];
	pi.events.emit("@oai404iao/pi-code-mode:direct-owner/v1", { version: 1, accept(value: Factory) {
		if (factories.length < 2) factories.push(value);
	} });
	const factory = factories.length === 1 && factories[0]?.version === 1
		&& typeof factories[0].create === "function" ? factories[0] : undefined;
	if (state.pendingDispose || factory !== state.factory || (factory && !state.control)) {
		state.transitioning = true;
		try {
			if (state.control && !state.pendingDispose) {
				const old = state.control;
				state.pendingDispose = () => old.dispose();
			}
			state.pendingDispose?.();
			state.pendingDispose = undefined;
			state.control = undefined;
			state.factory = undefined;
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
			}
		} finally { state.transitioning = false; }
	}
	return state.control;
}
