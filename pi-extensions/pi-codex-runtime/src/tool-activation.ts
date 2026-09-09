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
	const sync = (ctx: ExtensionContext) => {
		const settings = loadSettings(ctx.cwd);
		const available = settings.enabled && hasConfiguredModelsLoaded(ctx, settings);
		if (available) enableDefinitions(broker);
		const current = pi.getActiveTools?.() ?? [];
		const active = new Set(current);
		const capabilities = computeToolCapabilities(ctx.model as ModelLike | undefined, settings);
		const model = loadModelSettings(ctx.model as ModelLike | undefined, ctx.cwd, settings);
		for (const name of PACKAGE_TOOL_NAMES) {
			const owned = broker.tools.get(name);
			if (!owned) continue; // Other extensions retain ownership of uninstalled names.
			const hostedWithoutCore = !broker.coreEnabled && (
				(name === "web_search" && model.webSearchImplementation === "hosted")
				|| (name === "image_generation" && model.imageGenerationImplementation === "hosted" && !settings.directImageApiFallback)
			);
			const desired = available && owned.registered && capabilities[name].enabled && !hostedWithoutCore;
			if (!desired) active.delete(name);
			else if (settings.autoEnable) active.add(name);
		}
		if (broker.tools.has("apply_patch") && active.has("apply_patch")) {
			for (const name of NATIVE_MUTATION_TOOL_NAMES) {
				if (active.delete(name) && !suppressed.has(name)) suppressed.set(name, current.indexOf(name));
			}
		}
		const next = current.filter(name => active.has(name));
		for (const name of active) if (!next.includes(name)) next.push(name);
		if (!broker.tools.has("apply_patch") || !active.has("apply_patch")) restore(next);
		if (next.join("\0") !== current.join("\0")) pi.setActiveTools(next);
	};
	pi.on("session_start", (_event, ctx) => {
		broker.presentation.clear();
		sync(ctx);
	});
	pi.on("model_select", (_event, ctx) => sync(ctx));
	pi.on("thinking_level_select", (_event, ctx) => sync(ctx));
	pi.on("agent_end", () => broker.presentation.scheduleFlush());
	pi.on("session_shutdown", () => {
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
