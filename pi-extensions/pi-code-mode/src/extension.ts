import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { CodeSession } from "./session.ts";
import { HOST, errorText } from "./limits.ts";
import { CHANGED, registerCodeModeApproval } from "./contributions.ts";
import { collect, toolPrompt, isContributionName } from "./catalog.ts";
import { EXEC_DESCRIPTION, WAIT_DESCRIPTION, execParameters, waitParameters, renderObservation } from "./public-tools.ts";
import type { Grants } from "./builtin-tools.ts";
import { Visibility, visibilityMode, type VisibilityMode } from "./visibility.ts";
import { VISIBILITY_CHANGED } from "./direct-binding.ts";
import { decodeExec, EXEC_SAMPLING, projectExecHistory, protocolMode, resolveProtocol, type ProtocolMode } from "./protocol.ts";
import { configuration } from "./config.ts";
import { doctor } from "./doctor.ts";
import { UnconfirmedRuntimeStop } from "./errors.ts";
import { installOwnerFactory } from "./owner-factory.ts";

export default function codeMode(pi: ExtensionAPI): void {
	const session = new CodeSession();
	const disposeOwners = installOwnerFactory(pi);
	const disposeApproval = registerCodeModeApproval(pi, { id: "user", async approve(call) {
		const ctx = call.context.pi;
		if (!ctx?.hasUI) throw new Error("Code Mode user approval requires an interactive UI; no headless fallback");
		call.context.signal.throwIfAborted();
		const json = JSON.stringify(call.input);
		return ctx.ui.confirm(`Approve Code Mode: ${call.name}?`,
			`Effect: ${call.effect}; cell: ${call.context.cellId}\nFinal arguments (${Buffer.byteLength(json)} bytes; SHA256 ${createHash("sha256").update(json).digest("hex")}):\n${json.slice(0, 12000)}${json.length > 12000 ? "\n[Preview truncated. Approval authorizes the ENTIRE hashed arguments, not just this preview. Decline if insufficient.]" : ""}`,
			{ signal: call.context.signal });
	} });
	const visibility = new Visibility();
	let mode: VisibilityMode = "mixed";
	let protocol: ProtocolMode = "json";
	let protocolState = { grammar: false, reason: "explicit JSON" };
	let protocolAvailable = true;
	let visibilityIssue: string | undefined;
	let contributionChange: Promise<void> = Promise.resolve();
	let registered = false, stopped = false, authorizationGeneration = 0;
	let latest: ExtensionContext | undefined;
	let configuredHost = "";
	let configIssue: string | undefined;
	let probeController: AbortController | undefined;
	let probeTask: Promise<string> | undefined;
	const cancelProbe = () => probeController?.abort(new Error("Code Mode doctor cancelled"));
	let unbindAgent = () => {};
	let execDefinition: ToolDefinition<typeof execParameters> | undefined;
	let execDescription = EXEC_DESCRIPTION;
	const execSchema = structuredClone(execParameters);
	const waitSchema = structuredClone(waitParameters);
	const registrations = new Map<string, { parameters: unknown; fingerprint: string }>();
	const fingerprint = (tool: ToolInfo) => JSON.stringify([tool.sourceInfo, tool.description, tool.parameters, tool.promptGuidelines]);
	const ownsTool = (name: string) => {
		const registration = registrations.get(name);
		const tool = pi.getAllTools().find((item) => item.name === name);
		return Boolean(registration && tool && tool.parameters === registration.parameters && fingerprint(tool) === registration.fingerprint);
	};
	const rememberTool = (name: string, parameters: unknown) => {
		const tool = pi.getAllTools().find((item) => item.name === name);
		if (!tool || tool.parameters !== parameters || ["builtin", "sdk"].includes(tool.sourceInfo.source)) {
			throw new Error(`Code Mode ${name} registration ownership unavailable`);
		}
		registrations.set(name, { parameters, fingerprint: fingerprint(tool) });
	};
	const host = () => {
		if (configIssue) throw new Error(configIssue);
		return configuredHost;
	};
	const grants = (): Grants => {
		const names = String(pi.getFlag("code-mode-tools") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
		if (names.some((name) => !isContributionName(name))) throw new Error("Use exact owner__tool names; components cannot contain double/trailing underscores, and wildcards are forbidden");
		return { write: pi.getFlag("code-mode-write") === true, process: pi.getFlag("code-mode-process") === true, tools: [...new Set(names)] };
	};
	const reflect = (ctx: ExtensionContext) => {
		const owned = ["exec", "wait"].filter(ownsTool);
		if (registered) {
			if (owned.length !== 2) session.cancel("Code Mode exec/wait ownership lost");
			const active = pi.getActiveTools();
			const next = session.enabled ? [...new Set([...active, ...owned])] : active.filter((name) => !owned.includes(name));
			if (next.join("\0") !== active.join("\0")) pi.setActiveTools(next);
		}
		try {
			const eligible = session.enabled && !session.blocked && protocolAvailable && !stopped && owned.length === 2;
			visibility.sync(eligible ? mode : "mixed",
				eligible && mode === "hide-bridged" ? session.catalog(collect(pi)).tools : []);
			visibilityIssue = undefined;
		} catch (error) {
			const message = `Code Mode visibility unavailable; direct tools retained where possible: ${errorText(error)}`;
			if (visibilityIssue !== message) {
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else process.stderr.write(`${message}\n`);
			}
			visibilityIssue = message;
		}
		if (ctx.hasUI) ctx.ui.setStatus("pi-code-mode", session.enabled
			? `Code mode: ${session.blocked || !protocolAvailable ? "blocked" : session.activeCell?.state ?? (session.busy ? "busy" : "ready")}; ${session.cellList.length}/${session.maxCells} cells; ${protocolState.grammar ? "grammar" : "json"}; ${mode}; ${visibility.names.length} cooperative bindings${visibilityIssue ? " (visibility error)" : ""}`
			: undefined);
	};
	const bind = (ctx: ExtensionContext) => { latest = ctx; session.setContext(ctx); };
	const refreshTools = () => {
		if (!execDefinition || !session.enabled) return;
		if (!ownsTool("exec") || !ownsTool("wait")) return;
		if (latest) protocolState = resolveProtocol(pi, latest, protocol);
		protocolAvailable = protocol !== "grammar" || protocolState.grammar;
		const description = `${EXEC_DESCRIPTION}\nProtocol: ${protocolState.grammar ? "raw JavaScript grammar; send raw JavaScript, NOT a JSON wrapper or Markdown fence" : "JSON"} (${protocolState.reason}).${protocolAvailable ? "" : " Explicit grammar mode is unavailable; exec will fail until the protocol/model is changed."}\nRaw code may start with // @exec: {\"yield_time_ms\":0,\"timeout_ms\":30000,\"max_tokens\":8192} followed by a newline and JavaScript. Conflicting JSON/pragma options are rejected.\nExact authorized nested tools for the next cell:\n${toolPrompt(session.catalog(collect(pi)).tools)}`;
		if (description === execDescription) return;
		execDescription = description;
		execDefinition = { ...execDefinition, description, constrainedSampling: protocolState.grammar ? EXEC_SAMPLING : false };
		pi.registerTool(execDefinition); // supported Pi dynamic definition refresh; no provider shim
		rememberTool("exec", execSchema);
	};
	pi.registerFlag("code-mode-host", { description: `Path to verified ${HOST.release} Linux x64 Host (no download)`, type: "string" });
	pi.registerFlag("code-mode-read-root", { description: "EXPLICIT local read grant for cwd, including hidden files; enables Code Mode. Does not inherit Pi guards.", type: "string" });
	pi.registerFlag("code-mode-write", { description: "EXPLICITLY grant atomic file create/replace inside the Code Mode root; separate from read permission.", type: "boolean", default: false });
	pi.registerFlag("code-mode-process", { description: "EXPLICITLY grant full current-user local command execution. NOT a filesystem/network sandbox; commands can write outside cwd.", type: "boolean", default: false });
	pi.registerFlag("code-mode-tools", { description: "EXPLICIT grants for comma-separated owner__tool contributions. Registered extension code is trusted; these are not confined by local root.", type: "string" });
	pi.registerFlag("code-mode-visibility", { description: "mixed (default) or hide-bridged: suppress only explicitly cooperating direct owners. Not a permission boundary or strict only mode.", type: "string" });
	pi.registerFlag("code-mode-protocol", { description: "json (default), auto (capability-aware grammar/JSON), or grammar (requires a supported model/transport).", type: "string" });
	pi.registerFlag("code-mode-max-cells", { description: "Shared Host cell slots: 1 (default) to 4. Uncollected terminal results still occupy slots; not a permission grant.", type: "string" });
	session.onDiscard = (value) => {
		// Audit-only receipt, not a forged Pi tool result. Pending usage cannot be
		// retroactively attached to an already-returned exec during shutdown.
		const receipt = { cellId: value.cellId, state: value.state, usage: value.usage };
		try { pi.appendEntry("pi-code-mode:uncollected-usage/v1", receipt); }
		catch {
			// A late, noncooperative invocation may outlive Pi's runtime generation.
			// Never use a stale context to inject a message into the replacement session.
			process.stderr.write(`[pi-code-mode:uncollected-usage/v1] ${JSON.stringify(receipt)}\n`);
		}
		if (latest?.hasUI && !stopped) latest.ui.notify("Uncollected cell usage retained in an audit entry, not added to Pi tool totals. Collect wait results before off/reload.", "warning");
	};

	const ensureTools = () => {
		if (registered) {
			if (!ownsTool("exec") || !ownsTool("wait")) throw new Error("Code Mode exec/wait ownership lost");
			return;
		}
		if (pi.getAllTools().some((tool) => ["exec", "wait"].includes(tool.name))) throw new Error("Existing exec/wait owner; Code Mode will not override it");
		const active = pi.getActiveTools();
		execDefinition = {
			name: "exec", label: "Code Mode", description: EXEC_DESCRIPTION, parameters: execSchema, constrainedSampling: false, executionMode: "sequential",
			promptSnippet: "Orchestrate explicitly authorized tools using JavaScript; use wait for running cells.",
			async execute(_id, { code, ...options }, signal, _update, ctx) {
				bind(ctx);
				if (!ownsTool("exec") || !ownsTool("wait")) throw new Error("Code Mode exec/wait ownership lost");
				if (stopped || await realpath(ctx.cwd) !== session.rootPath) throw new Error("Code Mode has no grant for current cwd");
				const current = resolveProtocol(pi, ctx, protocol);
				if (protocol === "grammar" && !current.grammar) throw new Error(`Code Mode grammar unavailable: ${current.reason}`);
				const decoded = decodeExec({ code, ...options });
				const { code: source, ...controls } = decoded;
				const result = await session.execute(source, signal, controls, collect(pi), _id);
				reflect(ctx);
				return renderObservation(result);
			},
		};
		pi.registerTool(execDefinition);
		rememberTool("exec", execSchema);
		pi.registerTool({
			name: "wait", label: "Wait for Code Mode", description: WAIT_DESCRIPTION, parameters: waitSchema, executionMode: "sequential",
			async execute(_id, { cell_id, ...options }, signal, _update, ctx) {
				bind(ctx);
				const result = await session.wait(cell_id, options, signal);
				reflect(ctx);
				return renderObservation(result);
			},
		});
		rememberTool("wait", waitSchema);
		registered = true;
		pi.setActiveTools(active);
	};
	// Returning structured failure retains partial output, trace and nested usage.
	// Pi's supported result hook sets the real model-visible error flag.
	pi.on("tool_result", (event) => {
		const details = event.details as { brand?: string; failed?: boolean } | undefined;
		if (ownsTool(event.toolName) && details?.brand === "pi-code-mode/v2" && details.failed) return { isError: true };
	});
	pi.on("session_start", async (_event, ctx) => {
		cancelProbe();
		bind(ctx);
		const root = pi.getFlag("code-mode-read-root");
		try {
			if (session.enabled) { await session.revoke(); reflect(ctx); }
			configuredHost = "";
			const configured = configuration(pi);
			mode = configured.value.visibility;
			protocol = configured.value.protocol;
			session.setMaxCells(configured.value.maxCells);
			configuredHost = configured.value.hostPath;
			configIssue = undefined;
			if (typeof root !== "string" || !root) return;
			if (await realpath(root) !== await realpath(ctx.cwd)) throw new Error("--code-mode-read-root must equal cwd");
			ensureTools();
			await session.authorize(root, host(), grants());
			refreshTools();
			reflect(ctx);
		} catch (error) { configIssue = errorText(error); if (ctx.hasUI) ctx.ui.notify(configIssue, "error"); else throw error; }
	});
	pi.registerCommand("code-mode", {
		description: "Code Mode on|off|status|cells|terminate [id|all]|doctor [host]|visibility mixed|hide-bridged|protocol json|auto|grammar. Permissions require explicit CLI flags.",
		handler: async (args, ctx) => {
			bind(ctx);
			const action = args.trim() || "status";
			if (action === "cells") {
				const report = `Code Mode cells ${session.cellList.length}/${session.maxCells}: ${JSON.stringify(session.cellList)}. Terminal unread results still occupy slots.`;
				if (ctx.hasUI) ctx.ui.notify(report, "info"); else process.stderr.write(`${report}\n`);
				return;
			}
			if (action === "doctor" || action === "doctor host") {
				if (probeTask || session.blocked) throw new Error("Code Mode doctor is running or session is blocked; cancel or restart first");
				const controller = new AbortController();
				probeController = controller;
				let report: string;
				try {
					probeTask = doctor(pi, ctx, action === "doctor host", controller.signal);
					report = await probeTask;
				} catch (error) {
					if (error instanceof UnconfirmedRuntimeStop) { session.block(error); visibility.release(); }
					throw error;
				} finally { probeController = undefined; probeTask = undefined; }
				if (ctx.hasUI) ctx.ui.notify(report, "info");
				else process.stderr.write(`${report}\n`);
				return;
			}
			if (action.startsWith("protocol ")) {
				protocol = protocolMode(action.slice("protocol ".length).trim());
				await contributionChange;
				refreshTools(); reflect(ctx);
				return;
			}
			if (action.startsWith("visibility ")) {
				mode = visibilityMode(action.slice("visibility ".length).trim());
				await contributionChange;
				reflect(ctx);
				return;
			}
			if (action === "status") {
				const active = pi.getActiveTools();
				ctx.ui.notify(`Code Mode ${session.enabled ? "enabled" : "disabled"}; ${session.blocked || !protocolAvailable ? "blocked" : session.busy ? "busy" : "idle"}.\nRoot: ${session.rootPath ?? "(none)"}\nCells (${session.maxCells} slots): ${JSON.stringify(session.cellList)}\nGrants: ${JSON.stringify(grants())}\nProtocol: ${protocol} → ${protocolState.grammar ? "grammar" : "json"}; ${protocolState.reason}.\nVisibility: ${mode}; hidden: ${visibility.names.filter((name) => !active.includes(name)).join(", ") || "(none)"}; externally reactivated: ${visibility.names.filter((name) => active.includes(name)).join(", ") || "(none)"}.\n${visibilityIssue ?? "Visibility is cooperative, not strict only or an authorization boundary."}\nPi tool permission/redaction hooks are not inherited.`, "info");
				return;
			}
			if (action === "off") { cancelProbe(); authorizationGeneration++; try { await session.revoke(); } finally { reflect(ctx); } return; }
			if (action === "terminate" || action.startsWith("terminate ")) {
				if (action === "terminate" && probeTask) { cancelProbe(); await probeTask; return; }
				const target = action.slice("terminate".length).trim();
				const ids = target === "all" ? session.cellList.map((cell) => cell.id)
					: target ? [target] : session.activeCell ? [session.activeCell.id] : [];
				if (!ids.length) throw new Error("No unique Code Mode cell; specify an ID or terminate all (see /code-mode cells)");
				if (target === "all") session.terminateAll(); else session.terminate(ids[0]);
				const report = `Termination requested for ${ids.join(", ")}. Effects are not yet confirmed stopped; collect terminal results/output/usage with wait.`;
				if (ctx.hasUI) ctx.ui.notify(report, "info"); else process.stderr.write(`${report}\n`);
				return;
			}
			if (action !== "on") throw new Error("Usage: /code-mode on|off|status|cells|terminate [id|all]|doctor [host]|visibility mixed|hide-bridged|protocol json|auto|grammar");
			if (stopped || session.busy) throw new Error("Code Mode session busy/closed");
			if (!ctx.hasUI) throw new Error("Headless grants require explicit Code Mode CLI flags");
			const generation = ++authorizationGeneration;
			const root = await realpath(ctx.cwd);
			const selected = grants();
			const warning = `Read ALL regular files (including hidden/secret files) under ${root}.\nWrite in root: ${selected.write}.\nFULL CURRENT-USER PROCESS EXECUTION (can write anywhere): ${selected.process}.\nExternal tools, not confined to root: ${selected.tools.join(", ") || "(none)"}.\nExisting Pi guards/redaction and SSH/container overrides are NOT inherited. Authorize for this session?`;
			if (!await ctx.ui.confirm("Authorize Code Mode capabilities?", warning)) return;
			if (stopped || generation !== authorizationGeneration) throw new Error("Code Mode authorization prompt superseded");
			ensureTools();
			await session.authorize(root, host(), selected);
			refreshTools();
			reflect(ctx);
		},
	});
	pi.on("before_agent_start", async (event, ctx) => {
		bind(ctx);
		await contributionChange;
		if (!session.enabled) return;
		if (await realpath(ctx.cwd) !== session.rootPath) { await session.revoke(); reflect(ctx); return; }
		try { refreshTools(); } catch (error) { visibility.release(); throw error; }
		reflect(ctx);
		return { systemPrompt: `${event.systemPrompt}\n\nCode Mode local root: ${JSON.stringify(session.rootPath)}. The exec tool description lists the exact authorized nested tools. Shared Host capacity: ${session.maxCells}; cells: ${JSON.stringify(session.cellList)}. Collect terminal results and all output/traces/usage to release slots. Visibility is ${mode}: only explicitly cooperating, authorized contributions may hide their direct counterpart; all other tools stay direct. This is not strict only or a permission boundary. External contributions have their own authority, not local-root confinement. Writes/processes are not rolled back.` };
	});
	pi.on("turn_start", (_event, ctx) => {
		bind(ctx); unbindAgent();
		const signal = ctx.signal;
		const abort = () => session.cancel("Agent interrupted; side effects are not rolled back");
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		unbindAgent = () => signal?.removeEventListener("abort", abort);
	});
	pi.on("agent_end", (_event, ctx) => { if (ctx.signal?.aborted) session.cancel(); unbindAgent(); });
	const changed = pi.events.on(CHANGED, (message) => {
		if (stopped || (message as { version?: number })?.version !== 1) return;
		authorizationGeneration++;
		if (!session.enabled && !session.busy) return;
		contributionChange = session.invalidate().then(() => {
			if (!stopped) { refreshTools(); if (latest) reflect(latest); }
		}).catch((error) => {
			if (!stopped) {
				visibility.release();
				if (latest?.hasUI) latest.ui.notify(errorText(error), "error");
				else process.stderr.write(`Code Mode contribution refresh failed: ${errorText(error)}\n`);
			}
		});
		void contributionChange.catch(() => {});
	});
	const visibilityChanged = pi.events.on(VISIBILITY_CHANGED, (message) => {
		if (!stopped && latest && (message as { version?: number })?.version === 1) reflect(latest);
	});
	pi.on("model_select", async (_event, ctx) => { cancelProbe(); bind(ctx); authorizationGeneration++; try { await session.invalidate(); } finally { refreshTools(); reflect(ctx); } });
	pi.on("session_before_tree", async () => { cancelProbe(); authorizationGeneration++; await session.invalidate(); });
	pi.on("session_tree", async (_event, ctx) => { cancelProbe(); bind(ctx); authorizationGeneration++; try { await session.invalidate(); } finally { reflect(ctx); } });
	// turn_start/context run after Pi's tools snapshot. Reconcile before the
	// next snapshot, not by rewriting provider payloads or old tool history.
	pi.on("turn_end", (_event, ctx) => { if (!stopped) { bind(ctx); refreshTools(); reflect(ctx); } });
	pi.on("context", (event) => session.enabled && ownsTool("exec") && protocolState.grammar ? { messages: projectExecHistory(event.messages) } : undefined);
	pi.on("thinking_level_select", (_event, ctx) => { if (!stopped) reflect(ctx); });
	pi.on("session_shutdown", async () => {
		cancelProbe();
		await probeTask?.catch(() => {});
		stopped = true; changed(); visibilityChanged(); disposeApproval(); unbindAgent(); authorizationGeneration++;
		try { await session.revoke(true); } finally { visibility.release(); disposeOwners(); }
	});
}
