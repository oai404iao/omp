import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configuration } from "./config.ts";
import { inspectHost } from "./asset.ts";
import { control } from "./supervisor.ts";
import { collect } from "./catalog.ts";
import { resolveProtocol } from "./protocol.ts";
import { Runtime } from "./runtime.ts";
import { ToolBridge } from "./bridge.ts";
import { HOST, errorText } from "./limits.ts";
import { UnconfirmedRuntimeStop } from "./errors.ts";
import type { DiscoveryState } from "./discovery-state.ts";

export async function doctor(pi: ExtensionAPI, ctx: ExtensionContext, probe: boolean, cancellation?: AbortSignal, discovery?: DiscoveryState): Promise<string> {
	const cwd = ctx.cwd;
	const contextSignal = ctx.signal;
	const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(contextSignal ? [contextSignal] : []), ...(cancellation ? [cancellation] : [])]);
	const config = configuration(pi);
	const protocol = resolveProtocol(pi, ctx, config.value.protocol);
	const lines = [`Code Mode configuration: ${config.path}`, `Sources: ${JSON.stringify(config.sources)}`,
		`Configured shared Host capacity: ${config.value.maxCells} cells (not an authority grant)`,
		`Expected Host: ${HOST.release} (${HOST.target}; official static musl build)`];
	let ready = true;
	const check = async (label: string, action: () => Promise<unknown>) => {
		try { const result = await action(); lines.push(`${label}: OK${result ? ` ${result}` : ""}`); }
		catch (error) {
			if (error instanceof UnconfirmedRuntimeStop) throw error;
			ready = false; lines.push(`${label}: FAILED ${errorText(error)}`);
		}
	};
	await check("Host file/hash/platform", () => inspectHost(config.value.hostPath));
	await check("user systemd manager", () => control("/usr/bin/systemctl", ["--user", "show", "--property=Version", "--value"], signal));
	await check("available cgroup controllers (not an enforcement proof)", async () => {
		const controllers = (await readFile("/sys/fs/cgroup/cgroup.controllers", "utf8")).split(/\s+/);
		if (!["memory", "pids", "cpu"].every((name) => controllers.includes(name))) throw new Error("memory/pids/cpu controllers missing");
	});
	lines.push(`Configured protocol: ${config.value.protocol} → ${protocol.grammar ? "grammar" : "json"}; ${protocol.reason}`);
	await check("contribution discovery", async () => {
		lines.push(`Required policies: ${config.value.requiredPolicies.join(", ") || "(none)"}`);
		const catalog = collect(pi, config.value.requiredPolicies, discovery);
		const tools = catalog.tools.map((tool) => tool.name);
		const grants = String(pi.getFlag("code-mode-tools") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
		lines.push(`Available: ${tools.join(", ") || "(none)"}`, `Granted: ${grants.join(", ") || "(none)"}`,
			`Granted but unavailable: ${grants.filter((name) => !tools.includes(name)).join(", ") || "(none)"}`);
		for (const item of catalog.diagnostics ?? []) lines.push(`Declaration ${item.name}: ${item.state}${item.reason ? ` (${item.reason})` : ""}`);
	});
	if (probe && ready) await check("supervised pure-computation Host probe", async () => {
		const bridge = new ToolBridge([], [], "doctor", cwd, signal, () => undefined, () => {}, () => {});
		const runtime = await Runtime.create(config.value.hostPath, signal);
		try {
			let result = "";
			await runtime.run("text(1+1)", bridge, signal, 1000, (text) => { result += text; }, () => {});
			if (result !== "2") throw new Error("Unexpected computation result");
		} finally { bridge.stop(); await runtime.close(); await bridge.settled(); }
	});
	else lines.push(probe ? "Host probe skipped because prerequisites failed." : "Static checks only; no Host started and no authority granted.");
	return lines.join("\n");
}
