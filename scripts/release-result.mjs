function messageForPublishWarning(warning) {
  const name = typeof warning?.name === "string" ? warning.name : "an unknown package";
  const message = typeof warning?.message === "string" ? warning.message : "no diagnostic was recorded";
  return `npm publish reported a warning for ${name}: ${message}`;
}

/**
 * Return diagnostics that must prevent tag and GitHub Release finalization.
 *
 * The publish job may recover a version that reached npm after a transient
 * command failure, but a retry must perform that recovery cleanly before any
 * Git-side release identity is made visible.
 */
export function releaseFinalizationIssues(result) {
  if (
    !result
    || result.schemaVersion !== 1
    || !Array.isArray(result.releases)
    || !Array.isArray(result.unresolved)
    || !Array.isArray(result.publishWarnings)
  ) {
    return ["release result is malformed"];
  }

  const issues = [];
  if (result.ok !== true) issues.push("release result is not marked ok");
  if (result.releases.length === 0) issues.push("release result contains no finalized packages");
  for (const unresolved of result.unresolved) {
    issues.push(typeof unresolved === "string" ? unresolved : "release result contains an invalid unresolved entry");
  }
  for (const warning of result.publishWarnings) {
    issues.push(messageForPublishWarning(warning));
  }
  return issues;
}
