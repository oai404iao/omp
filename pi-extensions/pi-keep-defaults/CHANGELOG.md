# @oai404iao/pi-keep-defaults

## 0.1.4

### Patch Changes

- 952cb3f: Pin the supported-package development baseline to Pi 0.85.1 while retaining
  the Pi 0.84.2 peer floor. Add full floor/target compatibility verification,
  including independently installed Codex tarballs and real-loader checks.
  The private tree-continue hook remains exact-0.84.2 and disabled under the target
  loader. No Codex catalog, protocol, default capability or publication eligibility
  is changed.

## 0.1.3

### Patch Changes

- ead78ef: Update the published package manifests to the current TypeScript and Node type
  development baselines.

## 0.1.2

### Patch Changes

- 87b8eb3: Move the first public releases to the `@oai404iao` npm scope.

## 0.1.1

### Patch Changes

- c00a4aa: Make runtime and file guarding session-scoped and reload-safe, restore native setter delegation after shutdown, validate patch descriptors transactionally, cancel pending restores, and safely fall back with warnings when Pi's internal SettingsManager setters are incompatible.
