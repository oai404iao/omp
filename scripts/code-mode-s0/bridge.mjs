// S0 proof of an EXPLICIT adapter boundary; not a replacement for Pi's hooks.
import { Check } from "typebox/value";

const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

async function abortable(work, signal) {
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export function createLabBridge({
  adapters = new Map(), authorize, approvalMs = 100,
  maxCalls = 8, maxConcurrent = 2, maxResultBytes = 4096,
} = {}) {
  let calls = 0;
  let active = 0;
  let peak = 0;
  return {
    stats: () => ({ calls, active, peak }),
    async invoke(invocation, signal = new AbortController().signal) {
      signal.throwIfAborted();
      if (++calls > maxCalls) throw new Error("Call budget exceeded");
      const { tool_name: identity, input } = invocation;
      if (identity.namespace != null || ["exec", "wait"].includes(identity.name)) throw new Error("Invalid nested tool identity");
      const adapter = adapters.get(identity.name);
      if (!adapter || !authorize) throw new Error("No authorized adapter");
      if (active >= maxConcurrent) throw new Error("Concurrency budget exceeded");
      active++;
      peak = Math.max(peak, active);
      try {
        const args = freeze(structuredClone(adapter.prepare ? adapter.prepare(input) : input));
        if (!Check(adapter.parameters, args)) throw new Error("Invalid tool arguments");
        const approvalSignal = AbortSignal.any([signal, AbortSignal.timeout(approvalMs)]);
        const approved = await abortable(Promise.resolve().then(() =>
          authorize({ name: identity.name, args, signal: approvalSignal })), approvalSignal);
        signal.throwIfAborted();
        if (approved !== true) throw new Error("Tool approval denied");
        // Do NOT race invoke with abort and release the slot early: effects may still run.
        const result = await adapter.invoke(args, signal);
        signal.throwIfAborted();
        const visible = adapter.result ? adapter.result(result) : { content: result.content };
        if (Buffer.byteLength(JSON.stringify(visible)) > maxResultBytes) throw new Error("Result budget exceeded");
        return visible;
      } finally { active--; }
    },
  };
}
