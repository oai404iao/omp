import assert from "node:assert/strict";
import { test } from "node:test";
import { RegistryVisibilityPending, probeRegistryVisibility, waitForRegistryVisibility } from "./registry-visibility.mjs";

const registry = "https://registry.npmjs.org/";
const candidate = { name: "@example/test", version: "1.2.3", sourceCommit: "a".repeat(40), integrity: `sha512-${"A".repeat(86)}==` };
const tarball = `${registry}@example/test/-/test-1.2.3.tgz`;
const metadata = () => ({ name: candidate.name, version: candidate.version, gitHead: candidate.sourceCommit,
  dist: { integrity: candidate.integrity, shasum: "b".repeat(40), tarball } });
const packument = () => {
  const { gitHead, ...abbreviated } = metadata();
  return { name: candidate.name, "dist-tags": { latest: "0.9.0" }, versions: { [candidate.version]: abbreviated } };
};
const response = (body = packument(), status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
const responseFor = url => response(url.endsWith(`/${candidate.version}`) ? metadata() : packument());
function harness(fetch, options = {}) {
  let time = 0;
  const sleeps = [], warnings = [], logs = [];
  return { sleeps, warnings, logs, now: () => time,
    advance: ms => { time += ms; },
    options: { registry, now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; },
      random: () => 0.5, warning: value => warnings.push([time, value]), log: value => logs.push(value), fetch, ...options } };
}

test("abbreviated install metadata without gitHead uses full exact-version GET before canonical HEAD", async () => {
  assert.equal(Object.hasOwn(packument().versions[candidate.version], "gitHead"), false);
  const calls = [];
  const h = harness(async (url, options) => { calls.push([url, options]); return responseFor(url); });
  const result = await waitForRegistryVisibility(candidate, h.options);
  assert.equal(result.exists, true);
  assert.equal(result.version, candidate.version);
  assert.equal(result.gitHead, candidate.sourceCommit);
  assert.equal(result.integrity, candidate.integrity);
  assert.deepEqual(result.distTags, { latest: "0.9.0" });
  assert.deepEqual(result.versions, [candidate.version]);
  assert.deepEqual(h.sleeps, []);
  assert.equal(h.logs.length, 1);
  assert.deepEqual(calls.map(([url, opts]) => [url, opts.method]), [
    [`${registry}%40example%2Ftest`, "GET"], [`${registry}%40example%2Ftest/${candidate.version}`, "GET"], [tarball, "HEAD"],
  ]);
  for (const [, options] of calls) {
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.accept, options === calls[1][1] ? "application/json" : "application/vnd.npm.install-v1+json");
    assert.equal(options.headers["cache-control"], "no-cache");
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test("missing version uses 5/10/20/30s capped exponential backoff", async () => {
  let attempts = 0;
  const h = harness(async (url, { headers }) => headers.accept !== "application/json" && ++attempts < 6
    ? response({ name: candidate.name, versions: {} }) : responseFor(url));
  await waitForRegistryVisibility(candidate, h.options);
  assert.deepEqual(h.sleeps, [5000, 10000, 20000, 30000, 30000]);
});

for (const [random, expected] of [[0, 4000], [1, 6000]]) {
  test(`jitter endpoint ${random} stays within +/-20%`, async () => {
    let attempts = 0;
    const h = harness(async url => ++attempts === 1 ? response({}, 404) : responseFor(url), { random: () => random });
    await waitForRegistryVisibility(candidate, h.options);
    assert.deepEqual(h.sleeps, [expected]);
  });
}

for (const status of [404, 408, 429, 500, 502, 503, 599]) {
  test(`HTTP ${status} transient for install GET, full GET and HEAD`, async () => {
    for (const failureMethod of ["GET", "FULL", "HEAD"]) {
      let failed = false;
      const h = harness(async (url, { method, headers }) => {
        const phase = headers.accept === "application/json" ? "FULL" : method;
        if (phase === failureMethod && !failed) { failed = true; return response({}, status); }
        return responseFor(url);
      });
      await waitForRegistryVisibility(candidate, h.options);
      assert.deepEqual(h.sleeps, [5000]);
    }
  });
}

for (const status of [201, 301, 302, 400, 401, 403, 410]) {
  test(`HTTP ${status} fatal for install GET, full GET and HEAD`, async () => {
    for (const failureMethod of ["GET", "FULL", "HEAD"]) {
      const h = harness(async (url, { method, headers }) => (headers.accept === "application/json" ? "FULL" : method) === failureMethod
        ? response({}, status) : responseFor(url));
      await assert.rejects(waitForRegistryVisibility(candidate, h.options), new RegExp(`HTTP ${status}`));
      assert.deepEqual(h.sleeps, []);
    }
  });
}

test("network and interrupted body reads are transient", async () => {
  for (const failureMethod of ["GET", "HEAD", "BODY"]) {
    let failed = false;
    const h = harness(async (url, { method }) => {
      if (!failed && (method === failureMethod || failureMethod === "BODY")) {
        failed = true;
        if (failureMethod === "BODY") return { status: 200, text: async () => { throw new TypeError("reset"); } };
        throw new TypeError("offline");
      }
      return responseFor(url);
    });
    await waitForRegistryVisibility(candidate, h.options);
    assert.deepEqual(h.sleeps, [5000]);
  }
});

for (const value of ["120", new Date(120_000).toUTCString()]) {
  test(`429 honors Retry-After ${value}`, async () => {
    let attempts = 0;
    const h = harness(async url => ++attempts === 1 ? response({}, 429, { "retry-after": value }) : responseFor(url));
    await waitForRegistryVisibility(candidate, h.options);
    assert.deepEqual(h.sleeps, [120_000]);
  });
}

test("long Retry-After splits sleep to warn once at 15m and clamps to total 30m deadline", async () => {
  let attempts = 0;
  const h = harness(async () => { attempts++; return response({}, 429, { "retry-after": "999999" }); });
  await assert.rejects(waitForRegistryVisibility(candidate, h.options), RegistryVisibilityPending);
  assert.deepEqual(h.sleeps, [900_000, 900_000]);
  assert.equal(h.now(), 1_800_000);
  assert.equal(attempts, 1);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.warnings[0][0], 900_000);
});

test("expired or malformed Retry-After falls back to backoff", async () => {
  for (const value of ["invalid", "-2", new Date(0).toUTCString()]) {
    let attempts = 0;
    const h = harness(async url => ++attempts === 1 ? response({}, 429, { "retry-after": value }) : responseFor(url));
    await waitForRegistryVisibility(candidate, h.options);
    assert.deepEqual(h.sleeps, [5000]);
  }
});

test("fatal install-packument identity and digest corruption never retries", async () => {
  const changes = [
    doc => { doc.name = "wrong"; }, doc => { doc.versions = []; },
    doc => { doc.versions[candidate.version].name = "wrong"; },
    doc => { doc.versions[candidate.version].version = "wrong"; },
    doc => { doc.versions[candidate.version].dist.integrity = "wrong"; },
    doc => { delete doc.versions[candidate.version].dist; },
  ];
  for (const change of changes) {
    const doc = packument(); change(doc);
    const h = harness(async () => response(doc));
    await assert.rejects(waitForRegistryVisibility(candidate, h.options), error => !(error instanceof RegistryVisibilityPending));
    assert.deepEqual(h.sleeps, []);
  }
});

test("full exact-version metadata must independently match identity, source, digest and URL", async () => {
  for (const change of [
    doc => { delete doc.gitHead; }, doc => { doc.gitHead = "b".repeat(40); },
    doc => { doc.name = "wrong"; }, doc => { doc.version = "wrong"; },
    doc => { doc.dist.integrity = "wrong"; }, doc => { doc.dist.shasum = "wrong"; },
    doc => { doc.dist.tarball = "https://evil.test/test.tgz"; },
  ]) {
    const doc = metadata(); change(doc);
    const calls = [];
    const h = harness(async (url, options) => {
      calls.push(options.method);
      return options.headers.accept === "application/json" ? response(doc) : responseFor(url);
    });
    await assert.rejects(waitForRegistryVisibility({ ...candidate, shasum: "b".repeat(40) }, h.options),
      error => !(error instanceof RegistryVisibilityPending));
    assert.deepEqual(calls, ["GET", "GET"]);
    assert.deepEqual(h.sleeps, []);
  }
});

test("full exact-version request and body share total deadline", async () => {
  for (const phase of ["REQUEST", "BODY"]) {
    const calls = [];
    const h = harness(async (url, options) => {
      calls.push(options.method);
      if (options.headers.accept === "application/json") {
        if (phase === "REQUEST") h.advance(1000);
        return { status: 200, text: async () => {
          if (phase === "BODY") h.advance(1000);
          return JSON.stringify(metadata());
        } };
      }
      return responseFor(url);
    }, { timeoutMs: 1000 });
    await assert.rejects(waitForRegistryVisibility(candidate, h.options), RegistryVisibilityPending);
    assert.deepEqual(calls, ["GET", "GET"]);
    assert.deepEqual(h.sleeps, []);
  }
});

test("missing versions transient; invalid JSON fatal; supplied shasum must match", async () => {
  let attempts = 0;
  const h = harness(async url => ++attempts === 1 ? response({ name: candidate.name }) : responseFor(url));
  await waitForRegistryVisibility(candidate, h.options);
  assert.deepEqual(h.sleeps, [5000]);
  await assert.rejects(probeRegistryVisibility(candidate, { fetch: async () => new Response("not JSON") }), /Malformed/);
  await probeRegistryVisibility({ ...candidate, shasum: "b".repeat(40) }, { fetch: async url => responseFor(url) });
  await assert.rejects(probeRegistryVisibility({ ...candidate, shasum: "c".repeat(40) }, { fetch: async () => response() }), /digest mismatch/);
});

test("only literal canonical tarball URL allowed before HEAD; credentialed registries rejected", async () => {
  for (const url of [tarball.replace("https:", "http:"), tarball.replace("registry.npmjs.org", "evil.test"),
    tarball.replace("https://", "https://user:pass@"), `${tarball}?token=secret`, `${tarball}#fragment`,
    tarball.replace("1.2.3", "1.2.4"), tarball.replace("/-/", "/%2e/-/")]) {
    let calls = 0;
    const doc = packument(); doc.versions[candidate.version].dist.tarball = url;
    await assert.rejects(probeRegistryVisibility(candidate, { fetch: async () => { calls++; return response(doc); } }), /canonical/);
    assert.equal(calls, 1);
  }
  for (const registry of ["https://user:pass@registry.npmjs.org/", "http://registry.npmjs.org/", "https://registry.npmjs.org/?token=x"]) {
    await assert.rejects(probeRegistryVisibility(candidate, { registry, fetch: () => assert.fail("must not request") }), /credential-free/);
  }
});

test("unexpected response URL or redirect is fatal for GET and HEAD", async () => {
  for (const method of ["GET", "HEAD"]) {
    for (const surprise of [{ redirected: true }, { url: "https://evil.test/" }]) {
      const h = harness(async (url, opts) => opts.method === method ? { status: 200, ...surprise } : responseFor(url));
      await assert.rejects(waitForRegistryVisibility(candidate, h.options), /redirect/);
      assert.deepEqual(h.sleeps, []);
    }
  }
});

test("request/body elapsed time consumes deadline and prevents late HEAD or success", async () => {
  for (const phase of ["GET", "BODY", "HEAD"]) {
    const calls = [];
    const h = harness(async (url, { method }) => {
      calls.push(method);
      if (method === phase) h.advance(1000);
      if (phase === "BODY" && method === "GET") return { status: 200, text: async () => { h.advance(1000); return JSON.stringify(packument()); } };
      return responseFor(url);
    }, { timeoutMs: 1000 });
    await assert.rejects(waitForRegistryVisibility(candidate, h.options), RegistryVisibilityPending);
    assert.deepEqual(calls, phase === "HEAD" ? ["GET", "GET", "HEAD"] : ["GET"]);
    assert.deepEqual(h.sleeps, []);
  }
});

test("hanging requests and bodies abort within remaining deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const phase of ["GET", "BODY", "FULL", "FULL_BODY", "HEAD"]) {
    let signal;
    let reached;
    const ready = new Promise(resolve => { reached = resolve; });
    const rejected = assert.rejects(probeRegistryVisibility(candidate, { now: () => 0, deadline: 20,
      fetch: async (url, options) => {
        signal = options.signal;
        const requestPhase = options.headers.accept === "application/json" ? "FULL" : options.method;
        if (phase === "BODY" && requestPhase === "GET" || phase === "FULL_BODY" && requestPhase === "FULL") {
          return { status: 200, text: () => { reached(); return new Promise(() => {}); } };
        }
        if (requestPhase === phase) { reached(); return new Promise(() => {}); }
        return responseFor(url);
      } }), RegistryVisibilityPending);
    await ready;
    t.mock.timers.tick(19);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(signal.aborted, true);
  }
});

test("per-request timeout is capped at 15s even with longer overall deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const result = probeRegistryVisibility(candidate, { now: () => 0, deadline: 60_000,
    fetch: async (_, options) => { signal = options.signal; return new Promise(() => {}); } });
  const rejected = assert.rejects(result, /timed out/);
  t.mock.timers.tick(14_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal.aborted, true);
});

test("tag verifier may retry pending and receives bounded metadata context", async () => {
  let verified = 0;
  const h = harness(async url => responseFor(url), { verify: (metadata, context) => {
    assert.deepEqual(metadata.versions, [candidate.version]);
    assert.equal(context.deadline, 1_800_000);
    if (++verified === 1) throw new RegistryVisibilityPending("tags not visible");
  } });
  await waitForRegistryVisibility(candidate, h.options);
  assert.deepEqual(h.sleeps, [5000]);
  await assert.rejects(waitForRegistryVisibility(candidate, { ...h.options, verify: () => { throw new Error("tag mismatch"); } }), /tag mismatch/);
});

test("HEAD Retry-After and elapsed requests share the same overall deadline", async () => {
  const h = harness(async (url, { method }) => {
    h.advance(1000);
    return method === "GET" ? responseFor(url) : response({}, 429, { "retry-after": "100" });
  }, { timeoutMs: 12_000 });
  await assert.rejects(waitForRegistryVisibility(candidate, h.options), RegistryVisibilityPending);
  assert.deepEqual(h.sleeps, [9000]);
  assert.equal(h.now(), 12_000);
});

test("repeated short retries still warn only once and end at deadline", async () => {
  const h = harness(async () => response({}, 503));
  await assert.rejects(waitForRegistryVisibility(candidate, h.options), RegistryVisibilityPending);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.warnings[0][0], 900_000);
  assert.equal(h.now(), 1_800_000);
});

test("invalid delay settings fail before any requests", async () => {
  for (const timing of [{ timeoutMs: 0 }, { initialDelayMs: -1 }, { maxDelayMs: NaN },
    { initialDelayMs: 50, maxDelayMs: 10 }, { timeoutMs: 1.5 }]) {
    await assert.rejects(waitForRegistryVisibility(candidate, { ...timing,
      fetch: () => assert.fail("must not request") }), /Invalid/);
  }
});
