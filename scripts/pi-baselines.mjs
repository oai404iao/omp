export const piFloor = "1.2.0";
export const piTarget = "1.2.0";

// Both lock-validation roles currently use the same version and artifact evidence.
export const piFloorArtifacts = [];

export function piVersion(baseline = process.env.OMP_PI_BASELINE ?? "target") {
  if (baseline === "floor") return piFloor;
  if (baseline === "target") return piTarget;
  throw new Error(`Unknown Pi baseline: ${baseline}`);
}

export const isPiDependency = name => name.startsWith("@earendil-works/pi-");
