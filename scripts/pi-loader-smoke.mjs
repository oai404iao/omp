import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { piVersion } from "./pi-baselines.mjs";
import { root } from "./workspaces.mjs";

globalThis.fetch = async () => { throw new Error("Network is forbidden in the Pi loader probe"); };
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const sdk = await import("@earendil-works/pi-coding-agent");
assert.equal(sdk.VERSION, piVersion());
const before = sdk.AgentSession.prototype._bindExtensionCore;
const loaderPath = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core/extensions/loader.js");
const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
const warnings = [];
const warn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
let loaded;
try {
  loaded = await loadExtensions([join(root, "pi-extensions/pi-tree-continue/index.ts")], process.cwd());
} finally { console.warn = warn; }
assert.deepEqual(loaded.errors, []);
const commands = loaded.extensions.flatMap(extension => [...extension.commands.keys()]);
assert.equal(typeof before, "function");
assert.deepEqual(commands, [], "unaudited Pi versions must not register the private continuation command");
assert.equal(sdk.AgentSession.prototype._bindExtensionCore, before, "unaudited hook must not patch the prototype");
assert.equal(warnings.length, 1);
assert.match(warnings[0], /pi-tree-continue.*disabled/i);
assert.ok(warnings[0].includes(sdk.VERSION));
loaded.runtime.invalidate();
