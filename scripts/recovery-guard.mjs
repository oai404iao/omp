export function normalizePackagePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isKnownDevelopmentOnlyPath(path) {
  return path === "tsconfig.json" || /^(?:test|tests|reference)\//.test(path);
}

/**
 * Return changed package paths that could alter an npm tarball.
 *
 * Callers must pass `git diff --no-renames` output so a rename is represented
 * by both its removed source and added destination. This makes deleting a
 * packed source file detectable even though it is absent from the current pack
 * file list.
 */
export function tarballFacingChangedPaths(changedPaths, directory, packedPaths) {
  const prefix = `${directory}/`;
  return changedPaths
    .map((path) => normalizePackagePath(path))
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length))
    .filter(
      (path) =>
        packedPaths.has(path)
        || path === ".npmignore"
        || path === ".gitignore"
        || !isKnownDevelopmentOnlyPath(path),
    );
}
