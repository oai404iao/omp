import { copyFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { root } from "../workspaces.mjs";

/** These fixtures replace git/npm/workspaces, but run the same guarded release modules. */
export function copyReleaseScripts(scripts, additional = []) {
  for (const file of ["release-utils.mjs", "release-selection.mjs", "release-resolution.mjs", "workspace-ranges.mjs",
    "release-dependencies.mjs", "targeted-release.mjs", "release-batch.mjs", "release-consumer-artifacts.mjs", ...additional]) {
    copyFileSync(join(root, "scripts", file), join(scripts, file));
  }
  mkdirSync(join(scripts, "node_modules"));
  symlinkSync(join(root, "node_modules/semver"), join(scripts, "node_modules/semver"), "dir");
}
