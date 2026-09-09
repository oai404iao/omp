# @oai404iao/pi-codex-core

## 0.1.0-alpha.1

### Patch Changes

- 952cb3f: Pin the supported-package development baseline to Pi 0.85.1 while retaining
  the Pi 0.84.2 peer floor. Add full floor/target compatibility verification,
  including independently installed Codex tarballs and real-loader checks.
  The private tree-continue hook remains exact-0.84.2 and disabled under the target
  loader. No Codex catalog, protocol, default capability or publication eligibility
  is changed.
- 952cb3f: Restrict native web-search and image-generation placeholder rewriting to
  capabilities installed in the Codex broker. Core-only installations must leave
  unowned tool names unchanged rather than turning another extension's function
  into a hosted or reserved namespace tool.
- 952cb3f: Split Codex ownership into a non-registering runtime library and independent core,
  web-search and image-generation packages. Retain the existing package name and
  subagent-inline entry as compatibility composition paths. Share capability and
  identity lifecycles through a version-checked session broker so equivalent package
  installations do not duplicate providers, tools, commands or renderers.

  At this split-stage checkpoint, new packages remained private/blocked; the
  alpha-bootstrap preparation entry supersedes that status. Artifact preparation rejects
  bundles with unpublished workspace dependencies; this change does not authorize
  their bootstrap or publication. Runtime versions must match when composing
  packages. Hosted capabilities still require core; standalone clients retain the
  existing catalog, Pi authentication, configuration paths and opt-in fallbacks.
- Prepare the split Codex alpha cohort for separately approved, dependency-first
  bootstrap. Update package documentation and the four new manifests to reflect
  bootstrap eligibility, without enabling guarded publication or claiming real
  endpoint acceptance. The compatibility bundle requires the matching alpha
  dependencies; previously published monolith tarballs remain unchanged.
- Updated dependencies [952cb3f]
- Updated dependencies [952cb3f]
- Updated dependencies [952cb3f]
- Updated dependencies
  - @oai404iao/pi-codex-runtime@0.1.0-alpha.1
