import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const registry = "https://registry.npmjs.org/";

export const workspaces = [
  {
    name: "pi-codex-minimal-tools",
    directory: "pi-extensions/pi-codex-minimal-tools",
    releaseStatus: "blocked",
  },
  {
    name: "pi-keep-defaults",
    directory: "pi-extensions/pi-keep-defaults",
    releaseStatus: "publishable",
  },
  {
    name: "pi-subagent",
    directory: "pi-extensions/pi-subagent",
    releaseStatus: "blocked",
  },
  {
    name: "pi-telegram-notify",
    directory: "pi-extensions/pi-telegram-notify",
    releaseStatus: "publishable",
  },
  {
    name: "pi-tree-continue",
    directory: "pi-extensions/pi-tree-continue",
    releaseStatus: "blocked",
  },
];

export function readManifest(directory) {
  return JSON.parse(readFileSync(resolve(root, directory, "package.json"), "utf8"));
}

export const publishableWorkspaces = workspaces.filter(
  ({ releaseStatus }) => releaseStatus === "publishable",
);
