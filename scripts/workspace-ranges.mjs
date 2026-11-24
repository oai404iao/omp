import semver from "semver";

/** Published declarations use a caret with an explicit, canonical SemVer floor. */
export function isWorkspaceRange(declaration) {
  if (typeof declaration !== "string" || !declaration.startsWith("^")) return false;
  const floor = declaration.slice(1);
  return semver.valid(floor) === floor;
}

/** Immutable historical packages can carry exact pins instead of ranges. */
export function satisfiesWorkspaceDependency(version, declaration) {
  if (typeof version !== "string" || semver.valid(version) !== version) return false;
  return declaration === version || (isWorkspaceRange(declaration) && semver.satisfies(version, declaration));
}
