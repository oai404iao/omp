export const piFloor = "0.87.0";
export const piTarget = "0.87.1";

// Floor shrinkwrap-only dependencies have no hashed hoisted counterpart in
// the target lock. Registry SHA-512 values were checked against tarball bytes.
export const piFloorArtifacts = [
  {
    version: "0.87.0",
    resolved: "https://registry.npmjs.org/@earendil-works/chord/-/chord-0.87.0.tgz",
    integrity: "sha512-t8QOTf0GTHrsDSfcdtXuA9RCkh6mnR4l25N0SM/sgH7Ih25jH4tGXNbkGs9MWpV5xTu9MRPj4A7Zn1UEwQm9+g==",
  },
  {
    version: "0.87.0",
    resolved: "https://registry.npmjs.org/@earendil-works/pi-telemetry/-/pi-telemetry-0.87.0.tgz",
    integrity: "sha512-IEUMnV6mgHyOMfAxa4CKXoBKKfHM8KxNjbXWM4Bps/iLJcFMf8hQsEZ+95VnVTc7C0cU77Rmdxt773C35jb5AA==",
  },
];

export function piVersion(baseline = process.env.OMP_PI_BASELINE ?? "target") {
  if (baseline === "floor") return piFloor;
  if (baseline === "target") return piTarget;
  throw new Error(`Unknown Pi baseline: ${baseline}`);
}

export const isPiDependency = name => name.startsWith("@earendil-works/pi-");
