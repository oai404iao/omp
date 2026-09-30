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

function ownsRegisteredTool(pi: ExtensionAPI, broker: CodexBroker, name: "apply_patch" | "web_search" | "image_generation"): boolean {
	if (!broker.tools.get(name)?.registered) return false;
	const expected = broker.ownedTools.get(name);
	if (!expected || expected.replaced) return false;
	const info = pi.getAllTools?.().find((item) => item.name === name);
	if (!info?.sourceInfo || ["builtin", "sdk"].includes(info.sourceInfo.source)
		|| info.parameters !== expected.parameters || info.description !== expected.description) {
		expected.replaced = true;
		return false;
	}
	const identity = JSON.stringify([info.sourceInfo, info.description, info.parameters, info.promptGuidelines]);
	expected.identity ??= identity;
	if (expected.identity !== identity) expected.replaced = true;
	return !expected.replaced;
}

function enableDefinitions(broker: CodexBroker) {
	for (const tool of broker.tools.values()) {
		if (tool.registered) continue;
		tool.register(tool.exposure);
		tool.registered = true;
	}
	broker.presentation.registerRenderers();
}

export function addPackageTool(
	broker: CodexBroker,
	name: PackageToolName,
	register: (exposure: "direct" | "model-only") => void,
): void {
	if (broker.tools.has(name)) throw new Error(`Duplicate Codex tool owner: ${name}`);
	broker.tools.set(name, { register, registered: false, exposure: name === "apply_patch" ? "direct" : "model-only" });
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
		return active;
	};
	let syncing = false;
	const sync = (ctx: ExtensionContext) => {
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
		const ownsPatch = broker.tools.has("apply_patch") && ownsRegisteredTool(pi, broker, "apply_patch");
		for (const name of PACKAGE_TOOL_NAMES) {
			const owned = broker.tools.get(name);
			if (!owned) continue; // Other extensions retain ownership of uninstalled names.
			if (name === "apply_patch" && !ownsPatch) continue;
			if (name === "web_search" && !ownsRegisteredTool(pi, broker, "web_search")) continue;
			if (name === "image_generation" && !ownsRegisteredTool(pi, broker, "image_generation")) continue;
			if (owned.registered && (name === "web_search" || name === "image_generation")) {
				const implementation = name === "web_search" ? model.webSearchImplementation : model.imageGenerationImplementation;
				const exposure = implementation === "standalone" ? "direct" : "model-only";
				if (owned.exposure !== exposure) {
					owned.register(exposure);
					owned.exposure = exposure;
				}
			}
			const hostedWithoutCore = !broker.coreEnabled && (
				(name === "web_search" && model.webSearchImplementation === "hosted")
				|| (name === "image_generation" && model.imageGenerationImplementation === "hosted" && !settings.directImageApiFallback)
			);
			const desired = available && owned.registered && capabilities[name].enabled && !hostedWithoutCore;
			if (!desired) active.delete(name);
			else if (settings.autoEnable) active.add(name);
		}
		if (ownsPatch && active.has("apply_patch")) {
			for (const name of NATIVE_MUTATION_TOOL_NAMES) {
				if (active.delete(name) && !suppressed.has(name)) suppressed.set(name, current.indexOf(name));
			}
		}
		const next = current.filter(name => active.has(name));
		for (const name of active) if (!next.includes(name)) next.push(name);
		if (!ownsPatch || !active.has("apply_patch")) restore(next);
		// Re-registration can auto-activate a tool; keep the existing activation policy authoritative.
		if (next.join("\0") !== (pi.getActiveTools?.() ?? []).join("\0")) pi.setActiveTools(next);
		if (!ownsPatch || !active.has("apply_patch")) suppressed.clear();
		} finally { syncing = false; }
	};
	pi.on("session_start", (_event, ctx) => {
		broker.presentation.clear();
		suppressed.clear();
		sync(ctx);
	});
	pi.on("model_select", (_event, ctx) => sync(ctx));
	pi.on("thinking_level_select", (_event, ctx) => sync(ctx));
	pi.on("session_tree", (_event, ctx) => {
		// Restoration receipts belong to the previous physical loadout, not
		// to tools absent from the newly selected branch.
		suppressed.clear();
		sync(ctx);
	});
	pi.on("agent_end", () => broker.presentation.scheduleFlush());
	pi.on("session_shutdown", () => {
		const errors: unknown[] = [];
		try { broker.presentation.flush(); } catch (error) { errors.push(error); }
		try { broker.presentation.clear(); } catch (error) { errors.push(error); }
		try {
			const current = pi.getActiveTools?.() ?? [];
			const next = restore([...current]);
			if (next.join("\0") !== current.join("\0")) pi.setActiveTools(next);
			suppressed.clear();
		} catch (error) { errors.push(error); }
		if (errors.length) throw new AggregateError(errors, "Codex shutdown failed");
	});
	return broker;
}
