import { workspaces } from "./workspaces.mjs";

/** Parse the explicit guarded publish/recovery targets, not their verify-only dependencies. */
export function releaseTargets(raw, entries = workspaces) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("Select at least one exact release package");
  const names = raw.split(",").map(name => name.trim());
  for (const name of names) {
    if (!entries.some(entry => entry.name === name && entry.releaseStatus === "publishable")) {
      throw new Error(`Unapproved release target: ${name || "(empty)"}`);
    }
  }
  if (new Set(names).size !== names.length) throw new Error("Duplicate release target");
  return names.sort();
}
