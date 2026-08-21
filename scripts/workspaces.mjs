import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const registry = "https://registry.npmjs.org/";

export const workspaces = [
  {
    name: "@oai404iao/pi-external-thinking",
    directory: "pi-extensions/external-thinking",
    releaseStatus: "publishable",
  },
  {
    name: "@oai404iao/pi-codex-minimal-tools",
    directory: "pi-extensions/pi-codex-minimal-tools",
    releaseStatus: "bootstrap",
  },
  {
    name: "@oai404iao/pi-keep-defaults",
    directory: "pi-extensions/pi-keep-defaults",
    releaseStatus: "publishable",
  },
  {
    name: "@oai404iao/pi-subagent",
    directory: "pi-extensions/pi-subagent",
    releaseStatus: "publishable",
  },
  {
    name: "@oai404iao/pi-telegram-notify",
    directory: "pi-extensions/pi-telegram-notify",
    releaseStatus: "publishable",
  },
  {
    name: "@oai404iao/pi-tree-continue",
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

export function artifactWorkspaces(includeBootstrap = false, workspaceEntries = workspaces) {
  return workspaceEntries.filter(
    ({ releaseStatus }) =>
      releaseStatus === "publishable" || (includeBootstrap && releaseStatus === "bootstrap"),
  );
}
