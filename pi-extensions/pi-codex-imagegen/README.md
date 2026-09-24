# pi-codex-imagegen

See the package guide below for release status; source edits do not publish artifacts.

Peer floor: Pi 0.87.0; development target: 0.87.1.

`/image-gen` jobs are cancelled when the session is replaced or closed.
Late authentication/results cannot notify the replacement session or initiate
new image writes. Already-started server generation or disk writes cannot be
rolled back; cancellation is not a guarantee of avoiding provider charges.

Installs `image_generation`, background image commands, image persistence and
presentation. Depends only on `pi-codex-runtime`, not core, web-search or the bundle.
When global `config.json.imageGeneration` is `false`, none of those generation
surfaces are registered. The gate also blocks late/manual standalone and direct
fallback execution before authentication or network I/O.
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
npm run test:codex-composition
npm run test:codex-packages
```

Client/capture/display/background-job regressions are in `tests/`; hosted
transport integration is in root `tests/codex/`. See the
[shared configuration guide](../pi-codex-runtime/reference/configuration.md) and
[image-generation example](assets/image-generation.gif). The example is a
repository asset, not part of the runtime tarball.
