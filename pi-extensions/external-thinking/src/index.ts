/**
 * external-thinking — a port of oh-my-pi's `externalThinking` feature for pi.
 *
 * What it does (mirrors https://github.com/can1357/oh-my-pi):
 *   1. Registers a visible `think` scratchpad tool (omitted from the system
 *      prompt's tool list and rendered in the TUI as dim italic thoughts).
 *   2. Forces native model reasoning OFF (`thinking level = off`).
 *   3. In hard mode (default) the model is forced to call `think` first on
 *      every user prompt (`tool_choice` pinned to the think tool for the
 *      first request). In soft mode (`/external-thinking mode soft`) the
 *      think tool is available but `tool_choice` is left unset — the model
 *      may call it voluntarily.
 *
 * Requests are always sent to the provider as-is: the plugin rewrites the
 * first request of each turn (tool_choice → think, hard mode only) and never
 * intercepts, blocks, or degrades. Whether the upstream accepts the forced
 * tool call is the upstream's problem — errors surface from the provider,
 * not from us.
 *
 * Net effect: all reasoning happens through the visible `think` tool instead
 * of opaque native reasoning — useful for models whose native reasoning is
 * noisy, expensive, or unsupported, and it gives the user full visibility.
 *
 * Usage:
 *   /external-thinking                toggle
 *   /external-thinking on|off         enable / disable
 *   /external-thinking on hard|soft   enable in a specific mode
 *   /external-thinking mode hard|soft switch mode (persisted; applies immediately if ON)
 *   /external-thinking status         show state
 *   pi --external-thinking            enable at startup via CLI flag
 *
 * State is persisted in `<agentDir>/external-thinking.json`. The original
 * thinking level is remembered and restored when the feature is disabled.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOOL_NAME = "external_think";
const THINK_DESCRIPTION = "Visible reasoning scratchpad shown to the user.";
const FLAG_NAME = "external-thinking";
const COMMAND_NAME = "external-thinking";
const STATUS_KEY = "external-thinking";

/** Provider APIs whose request payloads we can rewrite (tool_choice pinning). */
const OPENAI_RESPONSES_APIS = ["openai-responses", "azure-openai-responses"];
const GOOGLE_APIS = ["google-generative-ai", "google-vertex"];
const SUPPORTED_APIS = [...OPENAI_RESPONSES_APIS, "openai-completions", "anthropic-messages", ...GOOGLE_APIS];

type ExtensionThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

interface PersistedState {
	enabled: boolean;
	/** Thinking level to restore when the feature is turned off. */
	previousThinkingLevel?: ExtensionThinkingLevel;
	/**
	 * Pin `tool_choice` to the think tool (true, "hard" mode) or leave it
	 * unset and let the model call think voluntarily (false, "soft" mode).
	 * Defaults to true.
	 */
	forceToolChoice?: boolean;
}

function stateFile(): string {
	return join(getAgentDir(), "external-thinking.json");
}

function loadState(): PersistedState {
	try {
		const path = stateFile();
		if (existsSync(path)) {
			const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedState>;
			return {
				enabled: raw.enabled === true,
				previousThinkingLevel:
					typeof raw.previousThinkingLevel === "string"
						? raw.previousThinkingLevel as ExtensionThinkingLevel
						: undefined,
				forceToolChoice: raw.forceToolChoice !== false,
			};
		}
	} catch (err) {
		console.warn("[external-thinking] failed to load state:", err);
	}
	return { enabled: false, forceToolChoice: true };
}

function saveState(state: PersistedState): void {
	try {
		writeFileSync(stateFile(), JSON.stringify(state, null, 2));
	} catch (err) {
		console.warn("[external-thinking] failed to save state:", err);
	}
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/**
 * Whether the plugin can rewrite this API's request payload to force the
 * think tool. Requests are always sent to the provider unchanged otherwise —
 * whether the upstream accepts them is the upstream's business.
 */
function canRewritePayload(api: string | undefined): boolean {
	return api !== undefined && SUPPORTED_APIS.includes(api);
}

function externalThinkingCompatibilityIssue(model: Model<Api> | null | undefined): string | undefined {
	if (!model) return "no active model";
	if (!canRewritePayload(model.api)) {
		return `API "${model.api}" cannot be rewritten (needs openai-responses, azure-openai-responses, openai-completions, anthropic-messages, or google)`;
	}
	if (!getSupportedThinkingLevels(model).includes("off")) {
		return "the selected model cannot disable native reasoning";
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Provider payload rewriting — force the model to call `think` first
// ---------------------------------------------------------------------------

/**
 * Pin `tool_choice` to the think tool on the first request of a turn.
 * Returns true when the payload was rewritten.
 */
function forceThinkToolChoice(payload: unknown, api: string): boolean {
	const p = payload as Record<string, unknown> | null | undefined;
	if (!p || typeof p !== "object") return false;
	try {
		if (OPENAI_RESPONSES_APIS.includes(api)) {
			const tools = p.tools;
			if (!Array.isArray(tools) || !tools.some((t) => (t as { name?: string })?.name === TOOL_NAME)) return false;
			p.tool_choice = { type: "function", name: TOOL_NAME };
			return true;
		}
		if (api === "openai-completions") {
			const tools = p.tools;
			if (
				!Array.isArray(tools) ||
				!tools.some((t) => (t as { function?: { name?: string } })?.function?.name === TOOL_NAME)
			) {
				return false;
			}
			p.tool_choice = { type: "function", function: { name: TOOL_NAME } };
			return true;
		}
		if (api === "anthropic-messages") {
			const tools = p.tools;
			if (!Array.isArray(tools) || !tools.some((t) => (t as { name?: string })?.name === TOOL_NAME)) return false;
			p.tool_choice = { type: "tool", name: TOOL_NAME };
			return true;
		}
		if (GOOGLE_APIS.includes(api)) {
			const config = p.config as Record<string, unknown> | undefined;
			const tools = config?.tools;
			if (
				!Array.isArray(tools) ||
				!tools.some((t) =>
					((t as { functionDeclarations?: Array<{ name?: string }> })?.functionDeclarations ?? []).some(
						(f) => f.name === TOOL_NAME,
					),
				)
			) {
				return false;
			}
			config!.toolConfig = {
				functionCallingConfig: { mode: "ANY", allowedFunctionNames: [TOOL_NAME] },
			};
			return true;
		}
	} catch {
		return false;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function externalThinking(pi: ExtensionAPI): void {
	const persisted = loadState();

	// ---- runtime state (not persisted) -------------------------------------
	let runtimeEnabled = false;
	let previousThinkingLevel: ExtensionThinkingLevel | undefined;
	let pendingThinkForce = false;
	let forceToolChoice = persisted.forceToolChoice !== false;
	let thinkToolDisabledByExtension = false;

	// ---- helpers ------------------------------------------------------------

	function modelLabel(model: Model<Api> | null | undefined): string {
		return model ? `${model.provider}/${model.id}` : "no model";
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!runtimeEnabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const model = ctx.model;
		ctx.ui.setStatus(
			STATUS_KEY,
			`⚡ ext-think on${forceToolChoice ? "" : " (soft)"}${model ? ` (${model.id})` : ""}`,
		);
	}

	function restorePreviousThinkingLevel(): void {
		if (previousThinkingLevel !== undefined) {
			try {
				pi.setThinkingLevel(previousThinkingLevel);
			} catch {
				// Model may not support the level; pi clamps internally.
			}
		}
	}

	/** Remove the think tool from the active tool set (used when disabled). */
	function ensureToolInactive(ctx: ExtensionContext): void {
		const active = pi.getActiveTools();
		if (active.includes(TOOL_NAME)) {
			pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
			thinkToolDisabledByExtension = !pi.getActiveTools().includes(TOOL_NAME);
		}
		updateStatus(ctx);
	}

	function isThinkToolAvailableToSession(): boolean {
		return pi.getAllTools().some((tool) => tool.name === TOOL_NAME);
	}

	/**
	 * Return the reason the extension must not take ownership of the current
	 * session. Explicit user tool restrictions are never widened.
	 */
	function activationIssue(ctx: ExtensionContext): string | undefined {
		const compatibilityIssue = externalThinkingCompatibilityIssue(ctx.model);
		if (compatibilityIssue) return compatibilityIssue;
		if (!pi.getActiveTools().includes(TOOL_NAME)) {
			if (!isThinkToolAvailableToSession()) {
				return "the think tool is excluded by --tools or user tool settings";
			}
			if (thinkToolDisabledByExtension) return undefined;
			return "the think tool is not active (it may be excluded by --tools or user tool settings)";
		}
		return undefined;
	}

	/** Force native reasoning off only after compatibility and tool access are verified. */
	function applyEnabled(ctx: ExtensionContext): boolean {
		if (activationIssue(ctx)) return false;
		if (!pi.getActiveTools().includes(TOOL_NAME)) {
			pi.setActiveTools([...pi.getActiveTools(), TOOL_NAME]);
			if (!pi.getActiveTools().includes(TOOL_NAME)) return false;
		}
		thinkToolDisabledByExtension = false;
		pi.setThinkingLevel("off");
		if (pi.getThinkingLevel() !== "off") return false;
		updateStatus(ctx);
		return true;
	}

	function pauseForIncompatibility(ctx: ExtensionContext, issue: string): void {
		const wasEnabled = runtimeEnabled;
		runtimeEnabled = false;
		pendingThinkForce = false;
		restorePreviousThinkingLevel();
		updateStatus(ctx);
		ctx.ui.notify(
			`external thinking: ${wasEnabled ? "paused" : "not enabled"} for ${modelLabel(ctx.model)} — ${issue}`,
			"warning",
		);
	}

	/**
	 * Resume an explicitly persisted/flag-enabled extension only when the
	 * selected model and current tool restrictions make its promise truthful.
	 */
	function resumePersistedState(ctx: ExtensionContext): boolean {
		const issue = activationIssue(ctx);
		if (issue) {
			pauseForIncompatibility(ctx, issue);
			return false;
		}
		if (!runtimeEnabled) {
			previousThinkingLevel = persisted.previousThinkingLevel ?? pi.getThinkingLevel();
			runtimeEnabled = true;
		}
		if (!applyEnabled(ctx)) {
			pauseForIncompatibility(ctx, activationIssue(ctx) ?? "the extension could not be activated");
			return false;
		}
		return true;
	}

	async function enable(ctx: ExtensionContext, force?: boolean): Promise<void> {
		if (runtimeEnabled) {
			ctx.ui.notify("external thinking is already ON", "info");
			return;
		}
		const issue = activationIssue(ctx);
		if (issue) {
			ctx.ui.notify(
				`external thinking: cannot enable — ${modelLabel(ctx.model)}: ${issue}`,
				"error",
			);
			return;
		}
		// Undefined keeps the persisted/default mode; hard|soft picks explicitly.
		const mode = force ?? persisted.forceToolChoice !== false;
		previousThinkingLevel = pi.getThinkingLevel();
		runtimeEnabled = true;
		forceToolChoice = mode;
		persisted.enabled = true;
		persisted.previousThinkingLevel = previousThinkingLevel;
		persisted.forceToolChoice = mode;
		saveState(persisted);
		if (!applyEnabled(ctx)) {
			// A tool or model may have changed while the command was being
			// handled. Fail closed rather than widening restrictions.
			runtimeEnabled = false;
			persisted.enabled = false;
			saveState(persisted);
			restorePreviousThinkingLevel();
			ensureToolInactive(ctx);
			ctx.ui.notify(
				`external thinking: cannot enable — ${activationIssue(ctx) ?? "the extension could not be activated"}`,
				"error",
			);
			return;
		}
		updateStatus(ctx);
		ctx.ui.notify(
			mode
				? "external thinking: ON (hard) — native reasoning off, model must think via the think tool"
				: "external thinking: ON (soft) — native reasoning off, think tool available but not forced",
			"info",
		);
	}

	/** Switch between hard (tool_choice pinned) and soft (unset) mode. */
	function setMode(ctx: ExtensionContext, force: boolean): void {
		forceToolChoice = force;
		persisted.forceToolChoice = force;
		saveState(persisted);
		ctx.ui.notify(
			`external thinking: mode ${force ? "hard" : "soft"}${runtimeEnabled ? " (active)" : " (next enable)"} — ${force ? "tool_choice pinned to think" : "tool_choice not set; model may call think voluntarily"}`,
			"info",
		);
	}

	async function disable(ctx: ExtensionContext): Promise<void> {
		const wasEnabled = runtimeEnabled;
		runtimeEnabled = false;
		pendingThinkForce = false;
		persisted.enabled = false;
		saveState(persisted);
		restorePreviousThinkingLevel();
		ensureToolInactive(ctx);
		ctx.ui.notify(
			wasEnabled ? "external thinking: OFF" : "external thinking: OFF (cleared paused state)",
			"info",
		);
	}

	function showStatus(ctx: ExtensionContext): void {
		const model = ctx.model;
		ctx.ui.notify(
			[
				`external thinking: ${runtimeEnabled ? "ON" : "OFF"}`,
				`model: ${modelLabel(model)}`,
				`mode: ${forceToolChoice ? "hard" : "soft"}`,
				`compatible: ${externalThinkingCompatibilityIssue(model) ?? "yes"}`,
				`thinking level: ${pi.getThinkingLevel()}`,
				`think tool active: ${pi.getActiveTools().includes(TOOL_NAME) ? "yes" : "no"}`,
			].join(" · "),
			"info",
		);
	}

	// ---- the think tool ------------------------------------------------------

	pi.registerTool({
		name: TOOL_NAME,
		label: "Think",
		description: THINK_DESCRIPTION,
		// No promptSnippet: the tool stays out of the system prompt's tool list.
		// It is still sent to the provider, so the model can call it.
		parameters: Type.Object(
			{
				thoughts: Type.String({ description: "Visible reasoning scratchpad shown to the user." }),
			},
			{ additionalProperties: false },
		),
		renderShell: "self",
		async execute() {
			return {
				content: [{ type: "text", text: "------" }],
				details: {},
			};
		},
		renderCall(args, theme) {
			const thoughts = typeof args?.thoughts === "string" ? args.thoughts : "";
			if (!thoughts.trim()) {
				return new Text(theme.fg("thinkingText", theme.italic("Thinking…")), 0, 0);
			}
			return new Markdown(thoughts, 0, 0, getMarkdownTheme(), {
				color: (text) => theme.fg("thinkingText", text),
				italic: true,
			});
		},
		renderResult() {
			// The thoughts stay visible from renderCall; hide the "------" result.
			return new Text("", 0, 0);
		},
	});

	// ---- events --------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// CLI flag: `pi --external-thinking` enables for this run (and persists).
		if (pi.getFlag(FLAG_NAME) === true && !persisted.enabled) {
			persisted.enabled = true;
			persisted.previousThinkingLevel = pi.getThinkingLevel();
			saveState(persisted);
		}
		if (persisted.enabled) {
			resumePersistedState(ctx);
		} else {
			ensureToolInactive(ctx);
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!persisted.enabled) return;
		resumePersistedState(ctx);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		if (!runtimeEnabled) return;
		if (event.level !== "off") {
			// External thinking owns the reasoning channel: native reasoning
			// stays off no matter what the level UI says.
			pi.setThinkingLevel("off");
			ctx.ui.notify("external thinking: native reasoning forced off — use the think tool instead", "info");
		}
	});

	// Arm the forced think call on every user prompt (incl. follow-ups).
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!runtimeEnabled) return;
		const issue = activationIssue(ctx);
		if (issue) {
			pauseForIncompatibility(ctx, issue);
			return;
		}
		// Hard mode only: soft mode leaves tool_choice unset.
		if (forceToolChoice) pendingThinkForce = true;
	});

	// Consume the arming flag on the first provider request of the turn by
	// pinning tool_choice to the think tool. The request is always sent to
	// the provider as-is otherwise — whether the upstream accepts it is the
	// upstream's problem.
	pi.on("before_provider_request", async (event, ctx) => {
		if (!runtimeEnabled || !pendingThinkForce) return undefined;
		pendingThinkForce = false;
		if (!forceToolChoice) {
			// Soft mode: send the request through untouched — no tool_choice pinning.
			return event.payload;
		}
		const api = ctx.model?.api;
		if (!api || !forceThinkToolChoice(event.payload, api)) {
			pauseForIncompatibility(
				ctx,
				"the first provider request did not contain a writable think tool definition",
			);
			return event.payload;
		}
		// Send the rewritten request through unchanged.
		return event.payload;
	});

	// ---- command -------------------------------------------------------------

	pi.registerCommand(COMMAND_NAME, {
		description: "Toggle external thinking (think tool replaces native reasoning). Usage: /external-thinking [on [hard|soft]|off|mode [hard|soft]|status]",
		getArgumentCompletions(prefix: string) {
			return ["on", "off", "status", "mode", "hard", "soft"]
				.filter((arg) => arg.startsWith(prefix))
				.map((arg) => ({ value: arg, label: arg }));
		},
		handler: async (args, ctx) => {
			const parts = args.trim().toLowerCase().split(/\s+/);
			const cmd = parts[0] ?? "";
			const modeArg = parts[1];
			if (cmd === "" || cmd === "toggle") {
				if (runtimeEnabled) await disable(ctx);
				else await enable(ctx);
			} else if (cmd === "on") {
				if (modeArg === undefined) {
					await enable(ctx);
				} else if (modeArg === "hard") {
					await enable(ctx, true);
				} else if (modeArg === "soft") {
					await enable(ctx, false);
				} else {
					ctx.ui.notify("Usage: /external-thinking on [hard|soft]", "warning");
				}
			} else if (cmd === "off") {
				await disable(ctx);
			} else if (cmd === "status") {
				showStatus(ctx);
			} else if (cmd === "mode") {
				if (modeArg === "hard") {
					setMode(ctx, true);
				} else if (modeArg === "soft") {
					setMode(ctx, false);
				} else {
					ctx.ui.notify(
						`external thinking: mode is ${forceToolChoice ? "hard" : "soft"} — usage: /external-thinking mode [hard|soft]`,
						"warning",
					);
				}
			} else {
				ctx.ui.notify("Usage: /external-thinking [on [hard|soft]|off|mode [hard|soft]|status]", "warning");
			}
		},
	});

	// ---- CLI flag -------------------------------------------------------------

	pi.registerFlag(FLAG_NAME, {
		description: "Enable external thinking: model reasons through the visible think tool instead of native reasoning",
		type: "boolean",
		default: false,
	});
}
