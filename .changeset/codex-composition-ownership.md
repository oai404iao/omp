---
"@oai404iao/pi-codex-minimal-tools": minor
"@oai404iao/pi-codex-runtime": patch
"@oai404iao/pi-codex-core": patch
"@oai404iao/pi-codex-web-search": patch
"@oai404iao/pi-codex-imagegen": patch
---

Make the Codex bundle composition-only while preserving its default and
subagent-inline exports and existing configuration paths. Remove private source
forwards and duplicate schemas/assets; runtime owns canonical schemas and
catalog, and core owns the grammar. Move behavioral tests, protocol references,
preview assets and source/license documentation to their owners, with
cross-package regression tests at repository root. Retain upstream fingerprints
and enforce the thin bundle through architecture, license and tarball checks.
