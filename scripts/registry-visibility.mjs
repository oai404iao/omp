import { setTimeout as sleepDefault } from "node:timers/promises";
import { registry as defaultRegistry } from "./workspaces.mjs";

export class RegistryVisibilityPending extends Error {
  constructor(message, { retryAfterMs = 0, cause } = {}) {
    super(message, { cause });
    this.name = "RegistryVisibilityPending";
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfter(response, now) {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  if (!/^[A-Za-z]/.test(value.trim())) return 0;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now()) : 0;
}

async function request(url, method, { deadline, now, fetch, accept = "application/vnd.npm.install-v1+json" }) {
  const remaining = deadline - now();
  if (remaining <= 0) throw new RegistryVisibilityPending("Registry visibility deadline reached");
  const requestDeadline = now() + Math.min(15_000, remaining);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RegistryVisibilityPending("Registry request timed out"));
    }, Math.min(15_000, remaining));
  });
  try {
    return await Promise.race([timeout, (async () => {
      let response;
      try {
        response = await fetch(url, {
          method, redirect: "manual", signal: controller.signal,
          headers: { accept, "cache-control": "no-cache" },
        });
      } catch (cause) {
        throw new RegistryVisibilityPending("Registry network request failed", { cause });
      }
      if (response.redirected || (response.url && response.url !== url)) {
        throw new Error("Unexpected registry response URL or redirect");
      }
      if (response.status !== 200) {
        // Release the connection without waiting for an error response body.
        void response.body?.cancel().catch(() => {});
        if ([404, 408, 429].includes(response.status) || response.status >= 500 && response.status <= 599) {
          throw new RegistryVisibilityPending(`Registry HTTP ${response.status}`, {
            retryAfterMs: response.status === 429 ? retryAfter(response, now) : 0,
          });
        }
        throw new Error(`Registry HTTP ${response.status}`);
      }
      let metadata;
      if (method === "GET") {
        let body;
        try { body = await response.text(); }
        catch (cause) { throw new RegistryVisibilityPending("Registry body read failed", { cause }); }
        try { metadata = JSON.parse(body); }
        catch { throw new Error("Malformed registry packument JSON"); }
      }
      if (now() >= requestDeadline) {
        controller.abort();
        throw new RegistryVisibilityPending("Registry request deadline reached");
      }
      return metadata;
    })()]);
  } finally {
    clearTimeout(timer);
  }
}

/** Verify the install packument and canonical tarball, without consulting dist-tags. */
export async function probeRegistryVisibility(candidate, {
  registry = defaultRegistry, now = Date.now, deadline = now() + 15_000, fetch = globalThis.fetch,
} = {}) {
  const base = new URL(registry);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Registry must be a credential-free HTTPS origin");
  }
  const url = `${base.href}${encodeURIComponent(candidate.name)}`;
  const options = { deadline, now, fetch };
  const packument = await request(url, "GET", options);
  if (!packument || typeof packument !== "object" || Array.isArray(packument)
    || packument.name !== candidate.name) throw new Error("Registry packument identity mismatch");
  if (packument.versions !== undefined && (!packument.versions || typeof packument.versions !== "object"
    || Array.isArray(packument.versions))) throw new Error("Malformed registry versions");
  if (!packument.versions || !Object.hasOwn(packument.versions, candidate.version)) {
    throw new RegistryVisibilityPending(`${candidate.name}@${candidate.version} is not visible`);
  }
  const expected = `${base.href}${candidate.name}/-/${candidate.name.split("/").at(-1)}-${candidate.version}.tgz`;
  const verifyMetadata = (metadata, requireSource) => {
    if (metadata?.name !== candidate.name || metadata?.version !== candidate.version
      || requireSource && metadata?.gitHead !== candidate.sourceCommit || metadata?.dist?.integrity !== candidate.integrity
      || candidate.shasum !== undefined && metadata?.dist?.shasum !== candidate.shasum) {
      throw new Error(`Registry identity or digest mismatch: ${candidate.name}@${candidate.version}`);
    }
    if (metadata.dist.tarball !== expected) throw new Error("Registry tarball URL is not canonical");
  };
  verifyMetadata(packument.versions[candidate.version], false);
  // Install-v1 omits gitHead; provenance must come from the full exact-version document.
  const metadata = await request(`${url}/${encodeURIComponent(candidate.version)}`, "GET", { ...options, accept: "application/json" });
  verifyMetadata(metadata, true);
  await request(expected, "HEAD", options);
  return {
    exists: true, version: metadata.version, gitHead: metadata.gitHead,
    integrity: metadata.dist.integrity, shasum: metadata.dist.shasum, tarball: metadata.dist.tarball,
    distTags: packument["dist-tags"] ?? {}, versions: Object.keys(packument.versions),
  };
}

export async function waitForRegistryVisibility(candidate, {
  registry = defaultRegistry, timeoutMs = 1_800_000, initialDelayMs = 5_000, maxDelayMs = 30_000,
  now = Date.now, sleep = sleepDefault, random = Math.random, fetch = globalThis.fetch,
  warning = console.warn, log = console.log, verify = () => {},
} = {}) {
  if (![timeoutMs, initialDelayMs, maxDelayMs].every(value => Number.isSafeInteger(value) && value > 0)
    || initialDelayMs > maxDelayMs) throw new Error("Invalid registry visibility timing options");
  const start = now(), deadline = start + timeoutMs, warningAt = start + 900_000;
  let delay = initialDelayMs, warned = false, pending;
  const warn = () => {
    if (!warned && now() >= warningAt) {
      warned = true;
      warning(`Registry visibility still pending after 15 minutes: ${candidate.name}@${candidate.version}`);
    }
  };
  while (now() < deadline) {
    warn();
    try {
      const metadata = await probeRegistryVisibility(candidate, { registry, deadline, now, fetch });
      await verify(metadata, { deadline, now });
      if (now() >= deadline) throw new RegistryVisibilityPending("Registry visibility deadline reached");
      log(`Registry visibility verified: ${candidate.name}@${candidate.version}`);
      return metadata;
    } catch (error) {
      if (!(error instanceof RegistryVisibilityPending)) throw error;
      pending = error;
    }
    warn();
    const jitter = Math.round(delay * (0.8 + random() * 0.4));
    const resumeAt = Math.min(deadline, now() + Math.max(jitter, pending.retryAfterMs));
    while (now() < resumeAt) {
      await sleep(Math.min(resumeAt, warned ? Infinity : warningAt) - now());
      warn();
    }
    delay = Math.min(maxDelayMs, delay * 2);
  }
  throw new RegistryVisibilityPending(`Registry visibility timed out after ${timeoutMs}ms: ${candidate.name}@${candidate.version}`, { cause: pending });
}
