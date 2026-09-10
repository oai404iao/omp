export const initialCodexBootstrap = Object.freeze({
  version: "0.1.0-alpha.1",
  sourceCommit: "32ba01f3c08b7fd63d09e9b2373cf081c4525533",
  names: Object.freeze(["runtime", "core", "imagegen", "web-search"].map(name => `@oai404iao/pi-codex-${name}`)),
});

export function isInitialCodexBootstrap(candidate) {
  return initialCodexBootstrap.names.includes(candidate.name)
    && candidate.version === initialCodexBootstrap.version
    && candidate.sourceCommit === initialCodexBootstrap.sourceCommit
    && candidate.prerelease === true
    && candidate.distTag === "next";
}

// Identity/integrity verification belongs to the caller; this only validates
// the first-publication tag exception, not permission to publish or activate.
export function hasInitialBootstrapLatestAlias(candidate, distTags, versions) {
  return isInitialCodexBootstrap(candidate)
    && distTags?.next === candidate.version
    && distTags?.latest === candidate.version
    && Array.isArray(versions)
    && versions.length === 1
    && versions[0] === candidate.version;
}
