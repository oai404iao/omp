import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasConfiguredModelsLoaded } from "./activation.js";
import { getCodexBroker, type CodexBroker } from "./broker.js";
import {
	computeToolCapabilities, NATIVE_MUTATION_TOOL_NAMES, PACKAGE_TOOL_NAMES,
	type ModelLike, type NativeMutationToolName, type PackageToolName,
} from "./capabilities.js";
import { installCodexIdentityLifecycle } from "./codex-identity-extension.js";
import { loadModelSettings } from "./model-catalog/runtime.js";
import { loadSettings } from "./settings.js";
import { codeModeOwner, OWNER_CHANGED } from "./code-mode-owner.js";

function enableDefinitions(broker: CodexBroker) {
	for (const tool of broker.tools.values()) {
		if (tool.registered) continue;
		tool.register();
		tool.registered = true;
	}
	broker.presentation.registerRenderers();
}

export function addPackageTool(
	broker: CodexBroker,
	name: PackageToolName,
	register: () => void,
): void {
	if (broker.tools.has(name)) throw new Error(`Duplicate Codex tool owner: ${name}`);
	broker.tools.set(name, { register, registered: false });
	if (loadSettings().enabled) enableDefinitions(broker);
}

export function ensureCodexServices(pi: ExtensionAPI): CodexBroker {
	const broker = getCodexBroker(pi);
	if (!broker.claim("activation")) return broker;
	installCodexIdentityLifecycle(pi);
	const suppressed = new Map<NativeMutationToolName, number>();
	const restore = (active: string[]) => {
		for (const [name, index] of [...suppressed].sort(([, a], [, b]) => a - b)) {
			if (!active.includes(name)) active.splice(Math.min(index, active.length), 0, name);
		}
		suppressed.clear();
		return active;
	};
	let latest: ExtensionContext | undefined;
	let syncing = false;
	const sync = (ctx: ExtensionContext) => {
		latest = ctx;
		if (syncing) return;
		syncing = true;
		try {
		const settings = loadSettings(ctx.cwd);
		const available = settings.enabled && hasConfiguredModelsLoaded(ctx, settings);
		if (available) enableDefinitions(broker);
		const current = pi.getActiveTools?.() ?? [];
		const active = new Set(current);
		const capabilities = computeToolCapabilities(ctx.model as ModelLike | undefined, settings);
		const model = loadModelSettings(ctx.model as ModelLike | undefined, ctx.cwd, settings);
		const controls = new Map<string, NonNullable<ReturnType<typeof codeModeOwner>>>();
		for (const name of PACKAGE_TOOL_NAMES) {
			const owned = broker.tools.get(name);
			if (!owned) continue; // Other extensions retain ownership of uninstalled names.
			const control = codeModeOwner(pi, name, owned, broker.codeModeDefinitions?.get(name));
			if (owned.codeModeOwner?.replaced) continue;
			if (control) {
				controls.set(name, control);
				if (control.activeIntent === undefined) continue; // foreign replacement
				if (control.activeIntent) active.add(name); else active.delete(name);
			}
			const hostedWithoutCore = !broker.coreEnabled && (
				(name === "web_search" && model.webSearchImplementation === "hosted")
				|| (name === "image_generation" && model.imageGenerationImplementation === "hosted" && !settings.directImageApiFallback)
			);
			const desired = available && owned.registered && capabilities[name].enabled && !hostedWithoutCore;
			if (!desired) active.delete(name);
			else if (settings.autoEnable) active.add(name);
		}
		const ownsPatch = broker.tools.has("apply_patch") && !broker.tools.get("apply_patch")?.codeModeOwner?.replaced;
		if (ownsPatch && active.has("apply_patch")) {
			for (const name of NATIVE_MUTATION_TOOL_NAMES) {
				if (active.delete(name) && !suppressed.has(name)) suppressed.set(name, current.indexOf(name));
			}
		}
		const physical = new Set(active);
		for (const [name, control] of controls) {
			const projected = control.projectActive(active.has(name));
			if (projected === undefined) { if (current.includes(name)) physical.add(name); else physical.delete(name); }
			else if (projected) physical.add(name); else physical.delete(name);
		}
		const next = current.filter(name => physical.has(name));
		for (const name of physical) if (!next.includes(name)) next.push(name);
		if (!ownsPatch || !active.has("apply_patch")) restore(next);
		if (next.join("\0") !== current.join("\0")) pi.setActiveTools(next);
		for (const control of controls.values()) control.reconcile();
		} finally { syncing = false; }
	};
	const offOwner = pi.events.on(OWNER_CHANGED, (message) => {
		if ((message as { version?: number })?.version === 1 && latest && !broker.closed) sync(latest);
	});
	pi.on("session_start", (_event, ctx) => {
		broker.presentation.clear();
		sync(ctx);
	});
	pi.on("model_select", (_event, ctx) => sync(ctx));
	pi.on("thinking_level_select", (_event, ctx) => sync(ctx));
	pi.on("agent_end", () => broker.presentation.scheduleFlush());
	pi.on("session_shutdown", () => {
		offOwner();
		for (const tool of broker.tools.values()) tool.codeModeOwner?.control?.dispose();
		try { broker.presentation.flush(); }
		finally {
			broker.presentation.clear();
			const current = pi.getActiveTools?.() ?? [];
			const next = restore([...current]);
			if (next.join("\0") !== current.join("\0")) pi.setActiveTools(next);
		}
	});
	return broker;
}
