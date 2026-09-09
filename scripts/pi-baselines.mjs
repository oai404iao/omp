export const piFloor = "0.84.2";
export const piTarget = "0.85.1";
export const privatePiPackage = "@oai404iao/pi-tree-continue";

export function piVersion(baseline = process.env.OMP_PI_BASELINE ?? "target") {
  if (baseline === "floor") return piFloor;
  if (baseline === "target") return piTarget;
  throw new Error(`Unknown Pi baseline: ${baseline}`);
}

export function piDevelopmentVersion(packageName, baseline) {
  return packageName === privatePiPackage ? piFloor : piVersion(baseline);
}

export const isPiDependency = name => name.startsWith("@earendil-works/pi-");
