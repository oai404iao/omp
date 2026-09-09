# pi-codex-runtime

Alpha bootstrap candidate; initial npm publication is still pending.
It has no Pi extension entry
and does not automatically register tools or providers.

Peer floor: Pi 0.84.2; tested against 0.84.2 and 0.85.1.

Owns shared Codex authentication/headers, wire identity, settings/catalog,
Responses replay contracts and the session-scoped composition broker.
Capability-specific HTTP clients, storage and transports live in other packages.

Configuration paths remain
`<agentDir>/extensions/pi-codex-minimal-tools/{config,models}.json`.
This package ships the canonical schemas and default catalog.
`./subagent-inline` supplies the existing SDK identity integration.
`./internal/*` is implementation wiring, not a stable public API.

Broker composition requires ABI v1 and matching runtime package versions.
See [the package guide](../../docs/codex-packages.md) for lifecycle and release
constraints. From repository root, run:

```bash
npm run check -w @oai404iao/pi-codex-runtime
npm run test:codex-packages
```
