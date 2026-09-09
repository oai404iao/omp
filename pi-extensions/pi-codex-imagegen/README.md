# pi-codex-imagegen

Private/blocked S3 extension; not published to npm.

Peer floor: Pi 0.84.2; tested against 0.84.2 and 0.85.1.

Installs `image_generation`, background image commands, image persistence and
presentation. Depends only on `pi-codex-runtime`, not core, web-search or the bundle.
Catalog-supported standalone profiles call Images generation/edit endpoints with
Pi authentication. Hosted profiles need core unless the existing
`directImageApiFallback` option was explicitly enabled.

Uses the existing
`<agentDir>/extensions/pi-codex-minimal-tools/{config,models}.json` settings and
existing output locations. With core, captured display sinks belong to the request's
starting session. Session replacement suppresses late display, not disk writes;
abort prevents subsequent persistence/notifications and shutdown cancels jobs.

Matching runtime versions compose once through the broker, with no duplicate
providers. Reserved endpoints remain unsupported compatibility surfaces.
`./internal/*` is implementation wiring.
See [the package guide](../../docs/codex-packages.md). From repository root:

```bash
npm run check -w @oai404iao/pi-codex-imagegen
npm run test:codex-packages
```
