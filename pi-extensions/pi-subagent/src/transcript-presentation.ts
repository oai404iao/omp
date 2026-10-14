import type { AgentSession, MessageRenderer, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { TranscriptPresentation } from "./dashboard-types.ts";
import { renderAgentMessage } from "./render.ts";
import { MESSAGE_CUSTOM_TYPE } from "./store.ts";

const revisions = new WeakMap<AgentSession, number>();
let nextRevision = 0;

function agentMessageRenderer(): MessageRenderer {
	return (message, options, theme) => renderAgentMessage(
		typeof message.content === "string" ? message.content :
			message.content.filter(block => block.type === "text").map(block => block.text).join(""),
		options.expanded, theme,
	);
}

/**
 * Read-only bridge to the same renderer resolver chain used by InteractiveMode.
 * Only weak session references escape: a viewer must not keep idle runtimes alive.
 */
export function createTranscriptPresentation(cwd: string, session?: AgentSession): TranscriptPresentation {
	const weak = session ? new WeakRef(session) : undefined;
	if (session && !revisions.has(session)) revisions.set(session, ++nextRevision);
	const revision = session ? `live:${revisions.get(session)}` : "cold";
	const outputPad = session?.settingsManager.getOutputPad() ?? 1;
	const transformerCount = session?.extensionRunner.getMarkdownTransformers().length ?? 0;
	session = undefined; // No strong parameter binding escapes in any resolver closure.
	const resolve = (name: string, fallback?: ToolRenderers): ToolRenderers | undefined => {
		const current = weak?.deref();
		if (!current) return fallback;
		return current.extensionRunner.resolveToolRenderers(name, () => {
			const definition = current.getToolDefinition(name);
			if (!definition) return fallback;
			return {
				renderShell: definition.renderShell,
				renderCall: definition.renderCall ?? fallback?.renderCall,
				renderResult: definition.renderResult ?? fallback?.renderResult,
			};
		});
	};
	return {
		cwd,
		revision,
		outputPad,
		resolveTool(name, fallback) {
			let renderers = resolve(name, fallback);
			if (!renderers) return undefined;
			const { renderShell } = renderers;
			const hasCall = !!renderers.renderCall;
			const hasResult = !!renderers.renderResult;
			renderers = undefined;
			// Do not capture the resolved callbacks: extension closures may own a session.
			return {
				renderShell,
				...(hasCall ? { renderCall: (args, theme, context) => {
					const renderer = resolve(name, fallback)?.renderCall;
					if (!renderer) throw new Error("Tool call renderer is no longer available");
					return renderer(args, theme, context);
				} } : {}),
				...(hasResult ? { renderResult: (result, options, theme, context) => {
					const renderer = resolve(name, fallback)?.renderResult;
					if (!renderer) throw new Error("Tool result renderer is no longer available");
					return renderer(result, options, theme, context);
				} } : {}),
			};
		},
		resolveMessage(customType) {
			const fallback = customType === MESSAGE_CUSTOM_TYPE ? agentMessageRenderer() : undefined;
			if (!weak?.deref()?.extensionRunner.getMessageRenderer(customType)) return fallback;
			return (message, options, theme) =>
				(weak?.deref()?.extensionRunner.getMessageRenderer(customType) ?? fallback)?.(message, options, theme);
		},
		markdownTransformers: Array.from({ length: transformerCount }, (_, index) =>
			(markdown, context) => weak?.deref()?.extensionRunner.getMarkdownTransformers()[index]?.(markdown, context) ?? markdown),
	};
}
