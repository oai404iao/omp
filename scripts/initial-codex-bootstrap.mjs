export const initialCodexBootstrap = Object.freeze({
  version: "0.1.0-alpha.1",
  sourceCommit: "32ba01f3c08b7fd63d09e9b2373cf081c4525533",
  names: Object.freeze(["runtime", "core", "imagegen", "web-search"].map(name => `@oai404iao/pi-codex-${name}`)),
});

const initialToolsBootstrap = Object.freeze({
  version: "0.1.0-alpha.1",
  sourceCommit: "b9deaba6ba07d87c048e474b2ddc977f3bd2b442",
  names: Object.freeze(["@oai404iao/pi-codex-tools"]),
});

export function isInitialCodexBootstrap(candidate) {
  return [initialCodexBootstrap, initialToolsBootstrap].some(bootstrap =>
    bootstrap.names.includes(candidate.name)
    && candidate.version === bootstrap.version
    && candidate.sourceCommit === bootstrap.sourceCommit)
    && candidate.prerelease === true
    && candidate.distTag === "next";
}

// Identity/integrity verification belongs to the caller; this only validates
// the first-publication tag exception, not permission to publish or activate.
export function hasInitialBootstrapLatestAlias(candidate, distTags, versions) {
  // Tools' verified history also contains npm's immutable staged-publication stub.
  // This is not permission to ignore placeholder versions for other packages.
  const expectedVersions = candidate.name === initialToolsBootstrap.names[0]
    ? ["0.0.0-stage", candidate.version] : [candidate.version];
  return isInitialCodexBootstrap(candidate)
    && distTags?.next === candidate.version
    && distTags?.latest === candidate.version
    && Array.isArray(versions)
    && versions.length === expectedVersions.length
    && expectedVersions.every(version => versions.includes(version));
}
