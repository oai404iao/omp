import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [cwd, version, label] = process.argv.slice(2);
globalThis.fetch = async () => { throw new Error("Network is forbidden in subagent consumer probes"); };
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const sdkRoot = join(cwd, "node_modules/@earendil-works/pi-coding-agent");
assert.ok(realpathSync(sdkRoot).startsWith(`${cwd}/`));
assert.equal(JSON.parse(readFileSync(join(sdkRoot, "package.json"))).version, version);
const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")));
assert.equal(sdk.VERSION, version);
const subagent = join(cwd, "node_modules/@oai404iao/pi-subagent");
const require = createRequire(join(subagent, "index.ts"));
const runtime = "@oai404iao/pi-codex-runtime";
if (label === "subagent-no-optional") {
  assert.equal(existsSync(join(cwd, "node_modules", runtime)), false);
  assert.equal(readdirSync(join(cwd, "node_modules/.pnpm")).some(name => name.startsWith("@oai404iao+pi-codex-runtime@")), false,
    "--no-optional must omit runtime from the physical installation, not just hide a root link");
  assert.throws(() => require.resolve(`${runtime}/subagent-inline`), { code: "MODULE_NOT_FOUND" });
} else {
  assert.ok(realpathSync(require.resolve(`${runtime}/subagent-inline`)).startsWith(`${cwd}/`));
}
const sdkRequire = createRequire(realpathSync(join(sdkRoot, "package.json")));
const { createJiti } = await import(pathToFileURL(sdkRequire.resolve("jiti")));
const integrationEntry = join(subagent, "src/codex-integration.ts");
const jiti = createJiti(integrationEntry, { moduleCache: false, fsCache: false });
const integration = await jiti.import(integrationEntry);
const state = await integration.loadCodexIntegration();
assert.equal(state.status, label === "subagent-no-optional" ? "absent" : "ready", String(state.cause));
const { loadExtensions } = await import(pathToFileURL(join(sdkRoot, "dist/core/extensions/loader.js")));
const result = await loadExtensions([join(subagent, "index.ts")], cwd, sdk.createEventBus());
assert.deepEqual(result.errors, []);
assert.equal(result.extensions.length, 1);
assert.deepEqual([...result.extensions[0].tools.keys()].sort(), [
  "spawn_agent", "send_message", "followup_task", "close_agent", "wait_agent", "interrupt_agent", "list_agents",
].sort());
assert.deepEqual([...result.extensions[0].commands.keys()], ["subagents"]);
assert.equal(result.runtime.pendingProviderRegistrations.length, 0);
assert.equal(result.runtime.pendingNativeProviderRegistrations.length, 0);
try {
  for (const shutdown of result.extensions[0].handlers.get("session_shutdown") ?? []) {
    await shutdown({}, { cwd, hasUI: false });
  }
} finally {
  result.runtime.invalidate();
}
