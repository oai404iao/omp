import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
globalThis.fetch = async () => { throw new Error("Network is forbidden in release loader probes"); };
const sdkRoot = join(job.cwd, "node_modules/@earendil-works/pi-coding-agent");
assert.ok(realpathSync(sdkRoot).startsWith(`${job.cwd}/`));
assert.equal(JSON.parse(readFileSync(join(sdkRoot, "package.json"))).version, job.version);
const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")));
assert.equal(sdk.VERSION, job.version);
const { loadExtensions } = await import(pathToFileURL(join(sdkRoot, "dist/core/extensions/loader.js")));
const allTools = ["apply_patch", "web_search", "image_generation"];
const subagentTools = ["spawn_agent", "send_message", "followup_task", "close_agent", "wait_agent", "interrupt_agent", "list_agents"];
const prefix = "@oai404iao/";

for (const requested of job.orders) {
  const paths = [];
  const expectedTools = new Set();
  let core = false;
  for (const name of requested) {
    const manifest = job.manifests[name];
    const pkg = join(job.cwd, "node_modules", name);
    for (const entry of manifest.pi?.extensions ?? []) paths.push(join(pkg, entry));
    const short = name.replace(prefix, "");
    if (["pi-codex-tools", "pi-codex-minimal-tools"].includes(short)) allTools.forEach(t => expectedTools.add(t));
    if (short === "pi-codex-web-search") expectedTools.add("web_search");
    if (short === "pi-codex-imagegen") expectedTools.add("image_generation");
    if (short === "pi-subagent") subagentTools.forEach(t => expectedTools.add(t));
    if (["pi-codex-core", "pi-codex-minimal-tools"].includes(short)) core = true;
    if (short === "pi-codex-runtime") {
      assert.equal(manifest.pi?.extensions, undefined, "runtime must remain a library");
    }
  }
  const result = await loadExtensions(paths, job.cwd, sdk.createEventBus());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, paths.length, "every candidate extension entry must load");
  const tools = result.extensions.flatMap(extension => [...extension.tools.keys()]);
  assert.deepEqual(tools.sort(), [...expectedTools].sort(), "selective/bundled candidate capability mismatch");
  assert.equal(result.runtime.pendingProviderRegistrations.length, core ? 2 : 0);
  const commands = result.extensions.flatMap(extension => [...extension.commands.keys()]);
  assert.equal(new Set(commands).size, commands.length);
  if (requested.includes(prefix + "pi-subagent")) assert.ok(commands.includes("subagents"));
  if (requested.includes(prefix + "pi-telegram-notify")) assert.ok(commands.includes("telegram-notify"));
  const ctx = { cwd: job.cwd, hasUI: false, sessionManager: { getSessionId: () => "release-consumer" } };
  result.runtime.getActiveTools = () => [];
  result.runtime.setActiveTools = () => {};
  for (const extension of result.extensions) {
    for (const shutdown of extension.handlers.get("session_shutdown") ?? []) await shutdown({}, ctx);
  }
  result.runtime.invalidate();
}
