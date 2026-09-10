import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
const denyFetch = async () => { throw new Error("Unexpected HTTP request outside a Codex fixture"); };
globalThis.fetch = denyFetch;
let bus;
for (const { cwd, label, paths, expectedTools, core } of job.probes) {
  const piRoot = join(cwd, "node_modules/@earendil-works/pi-coding-agent/dist");
  assert.equal(JSON.parse(readFileSync(join(piRoot, "../package.json"), "utf8")).version, job.version);
  const sdk = await import(pathToFileURL(join(piRoot, "index.js")).href);
  assert.equal(sdk.VERSION, job.version, "consumer must execute the requested Pi, not a workspace alias");
  bus ??= sdk.createEventBus();
  const { loadExtensions } = await import(pathToFileURL(join(piRoot, "core/extensions/loader.js")).href);
  const result = await loadExtensions(paths, cwd, bus);
  assert.deepEqual(result.errors, []);
  const tools = result.extensions.flatMap(extension => [...extension.tools.keys()]);
  assert.deepEqual([...tools].sort(), [...expectedTools].sort());
  const commands = result.extensions.flatMap(extension => [...extension.commands.keys()]);
  assert.equal(new Set(commands).size, commands.length, "commands registered more than once");
  assert.equal(result.runtime.pendingProviderRegistrations.length, core ? 2 : 0);
  assert.equal(result.runtime.pendingNativeProviderRegistrations.length, 0);
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
      globalThis.fetch = denyFetch;
    }
  } finally {
    globalThis.fetch = denyFetch;
    result.runtime.getActiveTools = () => [];
    result.runtime.setActiveTools = () => {};
    for (const extension of result.extensions) {
      for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    }
    result.runtime.invalidate();
  }
}
