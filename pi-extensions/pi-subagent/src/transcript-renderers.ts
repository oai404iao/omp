import {
	createReadToolDefinition, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition,
	createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, createPowerShellToolDefinition,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

const disposed = new WeakSet<Component>();
export function disposeTranscriptComponent(component: Component, protectedComponents: ReadonlySet<Component> = new Set()): void {
	if (protectedComponents.has(component) || disposed.has(component)) return;
	disposed.add(component);
	const owned = component as Component & { children?: Component[]; dispose?: () => void };
	for (const child of owned.children ?? []) disposeTranscriptComponent(child, protectedComponents);
	try { owned.dispose?.(); } catch { /* A presentation observer cannot affect agent work. */ }
}

/** Take presentation hooks only. Definitions are never registered, retained or executed. */
export function builtinToolRenderers(name: string, cwd: string): ToolRenderers | undefined {
	const factories = {
		read: createReadToolDefinition, bash: createBashToolDefinition, edit: createEditToolDefinition,
		write: createWriteToolDefinition, grep: createGrepToolDefinition, find: createFindToolDefinition,
		ls: createLsToolDefinition, powershell: createPowerShellToolDefinition,
	};
	if (!Object.hasOwn(factories, name)) return undefined;
	const factory = factories[name as keyof typeof factories];
	if (!factory) return undefined;
	const definition = factory(cwd) as unknown as ToolRenderers;
	return { renderShell: definition.renderShell, renderCall: definition.renderCall, renderResult: definition.renderResult };
}

/** Pi patch's not-started state previews files; other tools' started state starts clocks. */
export function readOnlyToolRenderers(name: string, renderers?: ToolRenderers): (ToolRenderers & { dispose(): void }) | undefined {
	if (!renderers) return undefined;
	const slots: { call?: Component; result?: Component } = {};
	const retain = (slot: keyof typeof slots, component: Component) => {
		const old = slots[slot];
		slots[slot] = component;
		if (old && old !== component) {
			const protectedComponents = new Set<Component>();
			const protect = (current: Component) => {
				if (protectedComponents.has(current)) return;
				protectedComponents.add(current);
				for (const child of (current as Component & { children?: Component[] }).children ?? []) protect(child);
			};
			for (const current of Object.values(slots)) if (current) protect(current);
			disposeTranscriptComponent(old, protectedComponents);
		}
		return component;
	};
	return {
		renderShell: renderers.renderShell,
		renderCall: renderers.renderCall ? (args, theme, context) => retain("call", renderers.renderCall!(args, theme, {
			...context, executionStarted: name === "apply_patch", ...(name === "edit" ? { argsComplete: false } : {}),
		})) : undefined,
		renderResult: renderers.renderResult ? (result, options, theme, context) => retain("result", renderers.renderResult!(result, options, theme, {
			...context, executionStarted: name === "apply_patch", ...(name === "edit" ? { argsComplete: false } : {}),
		})) : undefined,
		dispose() {
			if (slots.call) disposeTranscriptComponent(slots.call);
			if (slots.result) disposeTranscriptComponent(slots.result);
			slots.call = slots.result = undefined;
		},
	};
}
