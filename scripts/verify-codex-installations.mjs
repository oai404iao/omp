import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { root, readManifest } from "./workspaces.mjs";
import { isolatedConsumerLock } from "./isolated-consumer-lock.mjs";

// This integration probe is intentionally pinned to the workspace Pi floor.
const prefix = "@oai404iao/";
const names = ["pi-codex-runtime", "pi-codex-core", "pi-codex-web-search", "pi-codex-imagegen", "pi-codex-minimal-tools"];
const manifests = new Map(names.map(name => [prefix + name, readManifest(`pi-extensions/${name}`)]));
const directory = mkdtempSync(join(tmpdir(), "codex-tarball-consumers-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousFetch = globalThis.fetch;
const rejectNetwork = async () => { throw new Error("Unexpected HTTP request outside a Codex fixture"); };
globalThis.fetch = rejectNetwork;
process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
const packed = new Map();
const consumers = new Map();
let checks = 0;

function npm(args, cwd) {
  const result = spawnSync("npm", args, {
    cwd, encoding: "utf8", timeout: 90000,
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function assertContainedTree(path, consumer) {
  for (const entry of readdirSync(path)) {
    const file = join(path, entry);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) assert.ok(realpathSync(file).startsWith(`${consumer}/`), `external link: ${file}`);
    else if (stat.isDirectory()) assertContainedTree(file, consumer);
  }
}

function closure(requested) {
  const found = new Set();
  function visit(name) {
    if (found.has(name)) return;
    found.add(name);
    for (const dep of Object.keys(manifests.get(name).dependencies ?? {})) if (manifests.has(dep)) visit(dep);
  }
  for (const name of requested) visit(prefix + name);
  return found;
}

function install(label, requested) {
  const path = join(directory, label);
  mkdirSync(path);
  const included = closure(requested);
  const expected = new Set([...requested, "pi-codex-runtime"]);
  if (requested.includes("pi-codex-minimal-tools")) {
    for (const name of ["pi-codex-core", "pi-codex-web-search", "pi-codex-imagegen"]) expected.add(name);
  }
  assert.deepEqual([...included].sort(), [...expected].map(name => prefix + name).sort(),
    "a capability dependency would reinstall an unrequested capability");
  const consumer = isolatedConsumerLock(`fixture-${label}`, included, manifests, packed,
    JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")));
  writeFileSync(join(path, "package.json"), JSON.stringify(consumer.manifest));
  writeFileSync(join(path, "package-lock.json"), JSON.stringify(consumer.lock));
  npm(["ci", "--offline", "--ignore-scripts", "--legacy-peer-deps", "--omit=dev"], path);
  assertContainedTree(join(path, "node_modules"), path);
  assert.deepEqual(readdirSync(join(path, "node_modules/@oai404iao")).sort(), [...included].map(n => n.slice(prefix.length)).sort());
  for (const name of included) {
    assert.ok(realpathSync(join(path, "node_modules", name)).startsWith(path), `${name} leaked from the workspace`);
  }
  if (requested.includes("pi-codex-minimal-tools")) {
    const smoke = join(path, "inline-smoke.mts");
    writeFileSync(smoke, `
      import assert from "node:assert/strict";
      import * as legacy from "@oai404iao/pi-codex-minimal-tools/subagent-inline";
      import * as runtime from "@oai404iao/pi-codex-runtime/subagent-inline";
      assert.deepEqual(Object.keys(legacy).sort(), ["CODEX_IDENTITY_CUSTOM_TYPE", "createCodexSubagentInlineExtension"]);
      assert.equal(legacy.createCodexSubagentInlineExtension, runtime.createCodexSubagentInlineExtension);
    `);
    const smokeResult = spawnSync(join(root, "node_modules/.bin/tsx"), [smoke], {
      cwd: path, encoding: "utf8", timeout: 45000,
    });
    assert.equal(smokeResult.status, 0, smokeResult.stdout + smokeResult.stderr);
  }
  consumers.set(label, path);
  return path;
}

async function load(label, paths, expectedTools, core, bus) {
  const cwd = consumers.get(label);
  const piRoot = join(cwd, "node_modules/@earendil-works/pi-coding-agent/dist");
  const { loadExtensions } = await import(pathToFileURL(join(piRoot, "core/extensions/loader.js")).href);
  const result = await loadExtensions(paths, cwd, bus);
  assert.deepEqual(result.errors, []);
  const tools = result.extensions.flatMap(extension => [...extension.tools.keys()]);
  assert.deepEqual([...tools].sort(), [...expectedTools].sort());
  const commands = result.extensions.flatMap(extension => [...extension.commands.keys()]);
  assert.equal(new Set(commands).size, commands.length, "commands registered more than once");
  assert.equal(result.runtime.pendingProviderRegistrations.length, core ? 2 : 0);
  const model = { provider: "openai", api: "openai-responses", id: "gpt-5.6-sol", baseUrl: "https://fixture.invalid/v1", input: ["text", "image"] };
  const ctx = { cwd, model, hasUI: false, sessionManager: { getSessionId: () => label },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "not logged in" }) } };
  try {
    for (const name of ["web_search", "image_generation"]) {
      const registration = result.extensions.find(extension => extension.tools.has(name))?.tools.get(name);
      if (!registration) continue;
      const tool = registration.definition;
      const input = name === "web_search" ? { search_query: [{ q: "fixture" }] } : { prompt: "fixture" };
      await assert.rejects(tool.execute("missing-auth", input, undefined, undefined, ctx), /key|auth|logged|credential/i);
      ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "fixture-key", headers: {} });
      let calls = 0;
      globalThis.fetch = async (url, init) => {
        assert.match(String(url), /^https:\/\/fixture\.invalid\//);
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-key");
        calls++;
        if (name === "web_search") {
          assert.ok(String(url).endsWith("/alpha/search"));
          return Response.json({ output: "fixture search result", results: [] });
        }
        assert.ok(String(url).endsWith("/images/generations"));
        return Response.json({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==" }] });
      };
      const response = await tool.execute("fixture-auth", input, undefined, undefined, ctx);
      assert.ok(response.content.length);
      assert.equal(calls, 1);
      ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: "not logged in" });
    }
    checks++;
  } finally {
    globalThis.fetch = rejectNetwork;
    result.runtime.getActiveTools = () => [];
    result.runtime.setActiveTools = () => {};
    for (const extension of result.extensions) {
      for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    }
    result.runtime.invalidate();
  }
}

try {
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  for (const name of names) {
    const [result] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", directory], join(root, "pi-extensions", name)));
    packed.set(prefix + name, { path: join(directory, result.filename), integrity: result.integrity });
  }
  const matrix = [
    ["runtime", ["pi-codex-runtime"], [], false],
    ["core", ["pi-codex-core"], ["apply_patch", "view_image"], true],
    ["web", ["pi-codex-web-search"], ["web_search"], false],
    ["image", ["pi-codex-imagegen"], ["image_generation"], false],
    ["core-web", ["pi-codex-core", "pi-codex-web-search"], ["apply_patch", "view_image", "web_search"], true],
    ["core-image", ["pi-codex-core", "pi-codex-imagegen"], ["apply_patch", "view_image", "image_generation"], true],
    ["web-image", ["pi-codex-web-search", "pi-codex-imagegen"], ["web_search", "image_generation"], false],
    ["all", ["pi-codex-core", "pi-codex-web-search", "pi-codex-imagegen"], ["apply_patch", "view_image", "web_search", "image_generation"], true],
    ["bundle", ["pi-codex-minimal-tools"], ["apply_patch", "view_image", "web_search", "image_generation"], true],
    ["duplicate", ["pi-codex-minimal-tools", "pi-codex-core", "pi-codex-web-search", "pi-codex-imagegen"], ["apply_patch", "view_image", "web_search", "image_generation"], true],
  ];
  for (const [label, requested, tools, core] of matrix) {
    const path = install(label, requested);
    const entries = requested.flatMap(name =>
      (manifests.get(prefix + name).pi?.extensions ?? []).map(entry => join(path, "node_modules", prefix + name, entry)));
    await load(label, entries, tools, core);
    if (entries.length > 1) await load(label, [...entries].reverse(), tools, core);
  }
  // Physically separate runtime copies, not merely different API wrappers.
  const bundle = join(consumers.get("bundle"), "node_modules", prefix + "pi-codex-minimal-tools/src/index.ts");
  const web = join(consumers.get("web"), "node_modules", prefix + "pi-codex-web-search/src/index.ts");
  const allTools = ["apply_patch", "view_image", "web_search", "image_generation"];
  const { createEventBus } = await import(pathToFileURL(join(
    consumers.get("bundle"), "node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js",
  )).href);
  const bus = createEventBus();
  await load("bundle", [bundle, web], allTools, true, bus);
  await load("bundle", [web, bundle], allTools, true, bus); // Same bus after shutdown/reload.
  console.log(`✓ Codex: ${checks} production tarball/Pi-loader combinations; locked offline npm ci; no external links or capability leakage`);
} finally {
  globalThis.fetch = previousFetch;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(directory, { recursive: true, force: true });
}
