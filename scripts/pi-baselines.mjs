export const piFloor = "0.86.1";
export const piTarget = "0.86.1";

export function piVersion(baseline = process.env.OMP_PI_BASELINE ?? "target") {
  if (baseline === "floor") return piFloor;
  if (baseline === "target") return piTarget;
  throw new Error(`Unknown Pi baseline: ${baseline}`);
}

export const isPiDependency = name => name.startsWith("@earendil-works/pi-");
