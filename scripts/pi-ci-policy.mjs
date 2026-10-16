import { isDeepStrictEqual } from "node:util";
import { piFloor, piTarget } from "./pi-baselines.mjs";

// Opt-in only: the CI workflow must also require the target job for this same
// source revision and Node version. Equal version strings alone are not proof.
export function baselineCiScripts({
  baseline, reuseTarget = false, sourceLock, projectedLock,
  sourceManifests, projectedManifests, floorVersion = piFloor, targetVersion = piTarget,
}) {
  if (!["floor", "target"].includes(baseline)) throw new Error(`Unknown Pi baseline: ${baseline}`);
  const completeLock = lock => lock && typeof lock === "object"
    && lock.lockfileVersion && lock.importers && lock.packages && lock.snapshots;
  const sameInputs = baseline === "floor" && reuseTarget === true
    && typeof floorVersion === "string" && floorVersion === targetVersion
    && completeLock(sourceLock) && completeLock(projectedLock)
    && Array.isArray(sourceManifests) && sourceManifests.length > 0
    && isDeepStrictEqual(sourceManifests, projectedManifests)
    && isDeepStrictEqual(sourceLock, projectedLock);
  return sameInputs ? ["check:pi-baseline", "pack:check", "test:codex-packages"] : ["ci"];
}
