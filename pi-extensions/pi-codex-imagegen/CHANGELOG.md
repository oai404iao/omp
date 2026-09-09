# @oai404iao/pi-codex-imagegen

## 0.1.0

### Patch Changes

- 952cb3f: Pin the supported-package development baseline to Pi 0.85.1 while retaining
  the Pi 0.84.2 peer floor. Add full floor/target compatibility verification,
  including independently installed Codex tarballs and real-loader checks.
  The private tree-continue hook remains exact-0.84.2 and disabled under the target
  loader. No Codex catalog, protocol, default capability or publication eligibility
  is changed.
- 952cb3f: Split Codex ownership into a non-registering runtime library and independent core,
  web-search and image-generation packages. Retain the existing package name and
  subagent-inline entry as compatibility composition paths. Share capability and
  identity lifecycles through a version-checked session broker so equivalent package
  installations do not duplicate providers, tools, commands or renderers.
  
  New packages remain private/blocked. Release artifact preparation now rejects
  bundles with unpublished workspace dependencies; this change does not authorize
  their bootstrap or publication. Runtime versions must match when composing
  packages. Hosted capabilities still require core; standalone clients retain the
  existing catalog, Pi authentication, configuration paths and opt-in fallbacks.
- 952cb3f: Cancel background image jobs when their session is replaced or closed. Scope
  job status and timers to the registering instance, consume late auth/results,
  and suppress stale UI and new writes after cancellation. Already-started
  server generation or disk writes cannot be rolled back.
- Updated dependencies [952cb3f]
- Updated dependencies [952cb3f]
- Updated dependencies [952cb3f]
  - @oai404iao/pi-codex-runtime@0.1.0
