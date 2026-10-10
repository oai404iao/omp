import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasConfiguredModelsLoaded } from "./activation.js";
import { getCodexBroker, type CodexBroker } from "./broker.js";
import {
	computeToolCapabilities, PACKAGE_TOOL_NAMES,
	type PackageToolName,
} from "./capabilities.js";
import { installCodexIdentityLifecycle } from "./codex-identity-extension.js";
import { loadModelSettings } from "./model-catalog/runtime.js";
import { loadSettings, settingsDiagnostics } from "./settings.js";
import { clearEndpointFailures, knownEndpointModel, watchEndpointFailures } from "./endpoint-state.js";
import { installFastModeLifecycle } from "./fast-mode-state.js";

export function ownsRegisteredTool(pi: ExtensionAPI, broker: CodexBroker, name: "apply_patch" | "web_search" | "image_generation"): boolean {
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
	installFastModeLifecycle(pi);
	installCodexIdentityLifecycle(pi);
	const warned = new Set<string>();
	let watchedSession: string | undefined;
	let stopWatching: (() => void) | undefined;
	let syncing = false;
	const sync = (ctx: ExtensionContext, quiet = false) => {
		if (syncing) return;
		syncing = true;
		try {
		const settings = loadSettings(ctx.cwd);
		const available = settings.enabled && hasConfiguredModelsLoaded(ctx, settings);
		if (available) enableDefinitions(broker);
		const current = pi.getActiveTools?.() ?? [];
		const active = new Set(current);
		const sessionId = ctx.sessionManager?.getSessionId?.();
		const requestModel = knownEndpointModel(ctx.model ?? {}, sessionId);
		const capabilities = computeToolCapabilities(requestModel, settings);
		const model = loadModelSettings(requestModel, ctx.cwd, settings, sessionId);
		if (settings.enabled && ctx.ui?.notify) {
			for (const diagnostic of [...settingsDiagnostics(), ...model.requestDiagnostics]) {
				if (warned.has(diagnostic)) continue;
				warned.add(diagnostic);
				if (!quiet) ctx.ui.notify(diagnostic, "warning");
			}
		}
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
			const hostedWithoutCore = !broker.coreEnabled && name === "web_search" && model.webSearchImplementation === "hosted";
			const endpointEnabled = name === "web_search" ? model.webSearchEnabled : name === "image_generation" ? model.imageGeneration : true;
			const desired = available && owned.registered && capabilities[name].enabled && !hostedWithoutCore && endpointEnabled;
			if (!desired) active.delete(name);
			else if (settings.autoEnable) active.add(name);
		}
		const next = current.filter(name => active.has(name));
		for (const name of active) if (!next.includes(name)) next.push(name);
		// Re-registration can auto-activate a tool; keep the existing activation policy authoritative.
		if (next.join("\0") !== (pi.getActiveTools?.() ?? []).join("\0")) pi.setActiveTools(next);
		} finally { syncing = false; }
	};
	pi.on("session_start", (_event, ctx) => {
		stopWatching?.();
		if (watchedSession) clearEndpointFailures(watchedSession);
		watchedSession = ctx.sessionManager?.getSessionId?.();
		if (watchedSession) {
			clearEndpointFailures(watchedSession);
			stopWatching = watchEndpointFailures(watchedSession, message => {
				if (message) ctx.ui?.notify?.(message, "warning");
				sync(ctx, Boolean(message));
			});
		}
		broker.presentation.clear();
		warned.clear();
		sync(ctx);
	});
	pi.on("session_shutdown", () => {
		stopWatching?.();
		if (watchedSession) clearEndpointFailures(watchedSession);
		watchedSession = undefined;
	});
	pi.on("model_select", (_event, ctx) => sync(ctx));
	pi.on("thinking_level_select", (_event, ctx) => sync(ctx));
	pi.on("session_tree", (_event, ctx) => sync(ctx));
	pi.on("agent_end", () => broker.presentation.scheduleFlush());
	pi.on("session_shutdown", () => {
		const errors: unknown[] = [];
		try { broker.presentation.flush(); } catch (error) { errors.push(error); }
		try { broker.presentation.clear(); } catch (error) { errors.push(error); }
		if (errors.length) throw new AggregateError(errors, "Codex shutdown failed");
	});
	return broker;
}
