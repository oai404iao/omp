// Real Pi loader/session/agent, deterministic in-process model; NO provider HTTP.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, createReadTool, createBashTool, VERSION,
} from "@earendil-works/pi-coding-agent";
import { Host, resultBody, texts, tool } from "./host-client.mjs";
import { createLabBridge } from "./bridge.mjs";

globalThis.fetch = async () => { throw new Error("Network forbidden in S0 Pi fixture"); };
const textResult = (text) => ({ content: [{ type: "text", text }], details: {} });
const textOf = (result) => result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");

async function fixture(t, { factory = () => {}, settings = {}, baseToolsOverride } = {}) {
  assert.equal(VERSION, "0.86.1", "Re-audit API assumptions before changing Pi baseline");
  assert(process.env.CODE_MODE_S0_DIR, "Use run.mjs");
  const cwd = join(process.env.CODE_MODE_S0_DIR, `pi-${randomUUID()}`);
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, ...settings,
  });
  let api;
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => { api = pi; factory(pi, cwd); }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false,
  });
  modelRuntime.registerProvider("s0-fixture", {
    baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "fixture-not-a-credential",
    models: [{
      id: "s0", name: "S0 deterministic fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000,
    }],
  });
  const model = modelRuntime.getModel("s0-fixture", "s0");
  assert(model);
  let next;
  const streamFn = () => {
    const selected = next;
    next = undefined;
    const message = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: selected
        ? [{ type: "toolCall", id: randomUUID(), name: selected.name, arguments: selected.args }]
        : [{ type: "text", text: "fixture done" }],
      stopReason: selected ? "toolUse" : "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: message.stopReason, message });
    return stream;
  };
  const common = {
    cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  };
  const session = baseToolsOverride
    ? new AgentSession({ ...common, baseToolsOverride, agent: new Agent({
      streamFn, initialState: { model, thinkingLevel: "off" },
    }) })
    : (await createAgentSession({ ...common, model, thinkingLevel: "off" })).session;
  session.agent.streamFunction = streamFn;
  t.after(async () => {
    await session.abort();
    session.dispose();
    loader.getExtensions().runtime.invalidate();
  });
  await session.bindExtensions({ mode: "print" });
  return {
    cwd, api, session,
    async call(name, args) {
      next = { name, args };
      const before = session.messages.length;
      await session.prompt("Run the deterministic S0 tool fixture");
      const result = session.messages.slice(before).find((item) => item.role === "toolResult");
      assert(result, JSON.stringify(session.messages.slice(before)));
      assert.equal(result.toolName, name);
      return result;
    },
  };
}

test("Pi: metadata is not an execution API; actual Host nested calls bypass original hooks", { timeout: 18000 }, async (t) => {
  const host = await Host.open();
  t.after(() => host.close());
  const events = [];
  let effects = 0;
  let blockDirect = true;
  let allowNested = false;
  const f = await fixture(t, { factory: (pi) => {
    const secret = {
      name: "secret", label: "Fixture secret", description: "S0 fixture only",
      parameters: Type.Object({ path: Type.String() }),
      async execute() { effects++; return textResult("fixture-sensitive-value"); },
    };
    pi.registerTool(secret);
    pi.on("tool_call", (event) => {
      events.push(`call:${event.toolName}`);
      if (event.toolName === "secret" && blockDirect) return { block: true, reason: "original Pi permission gate" };
    });
    pi.on("tool_result", (event) => {
      events.push(`result:${event.toolName}`);
      if (event.toolName === "secret") return { content: [{ type: "text", text: "Pi-redacted" }] };
    });
    for (const guarded of [false, true]) pi.registerTool({
      name: guarded ? "guarded_exec" : "unsafe_exec", label: "S0 exec", description: "S0 fixture only",
      parameters: Type.Object({ code: Type.String() }),
      async execute(id, { code }, signal, _update, ctx) {
        if (guarded) {
          const bridge = createLabBridge({
            authorize: () => allowNested,
            adapters: new Map([["secret", {
              parameters: secret.parameters,
              invoke: (args, nestedSignal) => secret.execute(id, args, nestedSignal, undefined, { ...ctx, signal: nestedSignal }),
              result: () => textResult("Bridge-redacted"),
            }]]),
          });
          host.invoke = (call, nestedSignal) => bridge.invoke(call, AbortSignal.any([signal, nestedSignal]));
        } else {
          host.invoke = (call, nestedSignal) => secret.execute(id, call.input, nestedSignal, undefined, ctx);
        }
        const output = await host.execute(code, { tools: [tool("secret")], yieldMs: 1000 });
        assert.equal(resultBody(output).kind, "Result");
        if (resultBody(output).error_text) throw new Error(resultBody(output).error_text);
        return textResult(texts(output).join("\n"));
      },
    });
  } });
  const metadata = f.api.getAllTools().find((item) => item.name === "secret");
  assert(metadata);
  assert.equal("execute" in metadata, false);
  assert.equal("executeTool" in f.api, false);
  appendFileSync(join(process.env.CODE_MODE_S0_DIR, "pi-api.jsonl"), JSON.stringify({
    pi: VERSION, toolMetadataKeys: Object.keys(metadata).sort(), hasExecuteTool: "executeTool" in f.api,
  }) + "\n");

  const blocked = await f.call("secret", { path: "fixture-only" });
  assert.equal(blocked.isError, true);
  assert.equal(effects, 0);
  events.length = 0;
  const code = "text(await tools.secret({path:'fixture-only'}))";
  assert.match(textOf(await f.call("unsafe_exec", { code })), /fixture-sensitive-value/);
  assert.equal(effects, 1);
  assert.deepEqual(events, ["call:unsafe_exec", "result:unsafe_exec"]);
  blockDirect = false;
  assert.equal(textOf(await f.call("secret", { path: "fixture-only" })), "Pi-redacted");
  assert.equal(effects, 2);
  const denied = await f.call("guarded_exec", { code });
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /approval denied/);
  assert.equal(effects, 2);
  allowNested = true;
  assert.match(textOf(await f.call("guarded_exec", { code })), /Bridge-redacted/);
  assert.equal(effects, 3);
});

test("Pi: extension override is not preserved by recreating a local factory", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { factory: (pi) => pi.registerTool({
    name: "read", label: "Remote fixture", description: "Not local read",
    parameters: Type.Object({ path: Type.String() }),
    execute: async () => textResult("extension-remote"),
  }) });
  writeFileSync(join(f.cwd, "fixture.txt"), "local-only");
  assert.notEqual(f.api.getAllTools().find((item) => item.name === "read").sourceInfo.source, "builtin");
  assert.equal(textOf(await f.call("read", { path: "fixture.txt" })), "extension-remote");
  assert.equal(textOf(await createReadTool(f.cwd).execute("local", { path: "fixture.txt" })), "local-only");
});

test("Pi: builtin sourceInfo also conceals baseToolsOverride; factory is not equivalent", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { baseToolsOverride: {
    read: { name: "read", label: "SDK backend fixture", description: "Not local read",
      parameters: Type.Object({ path: Type.String() }), execute: async () => textResult("sdk-remote") },
  } });
  writeFileSync(join(f.cwd, "fixture.txt"), "local-only");
  assert.equal(f.api.getAllTools().find((item) => item.name === "read").sourceInfo.source, "builtin");
  assert.equal(textOf(await f.call("read", { path: "fixture.txt" })), "sdk-remote");
  assert.equal(textOf(await createReadTool(f.cwd).execute("local", { path: "fixture.txt" })), "local-only");
});

test("Pi: factory recreation loses configured shell command prefix", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { settings: { shellCommandPrefix: "export S0_PREFIX=preserved" } });
  const args = { command: "printf '%s' \"${S0_PREFIX:-missing}\"" };
  assert.equal(textOf(await f.call("bash", args)), "preserved");
  assert.equal(textOf(await createBashTool(f.cwd).execute("local", args)), "missing");
});
