// Keep the exhaustive consumer contract as the default. Smoke only reduces
// selection: packing, isolated installation and each loader probe stay intact.
export function codexConsumerMatrix(mode = "full") {
  if (mode !== "full" && mode !== "smoke") {
    throw new Error(`Unknown OMP_CODEX_CONSUMER_MODE: ${mode}; expected full or smoke`);
  }
  const consumers = [
    ["runtime", ["pi-codex-runtime"], [], false],
    ["core", ["pi-codex-core"], [], true],
    ["tools", ["pi-codex-tools"], ["apply_patch", "web_search", "image_generation"], false],
    ["core-tools", ["pi-codex-core", "pi-codex-tools"], ["apply_patch", "web_search", "image_generation"], true],
    ["web", ["pi-codex-web-search"], ["web_search"], false],
    ["image", ["pi-codex-imagegen"], ["image_generation"], false],
    ["core-web", ["pi-codex-core", "pi-codex-web-search"], ["web_search"], true],
    ["core-image", ["pi-codex-core", "pi-codex-imagegen"], ["image_generation"], true],
    ["web-image", ["pi-codex-web-search", "pi-codex-imagegen"], ["web_search", "image_generation"], false],
    ["all", ["pi-codex-core", "pi-codex-tools", "pi-codex-web-search", "pi-codex-imagegen"], ["apply_patch", "web_search", "image_generation"], true],
    ["bundle", ["pi-codex-minimal-tools"], ["apply_patch", "web_search", "image_generation"], true],
    ["duplicate", ["pi-codex-minimal-tools", "pi-codex-core", "pi-codex-web-search", "pi-codex-imagegen"], ["apply_patch", "web_search", "image_generation"], true],
  ];
  return {
    mode,
    consumers: mode === "full" ? consumers : consumers.filter(([label]) => label === "bundle"),
    reverseOrders: mode === "full",
    capabilityMasks: mode === "full" ? [0, 1, 2, 3, 4, 5, 6] : [],
    separateRuntimeCopies: mode === "full",
  };
}
