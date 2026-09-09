# pi-codex-web-search

Private/blocked S3 extension; not published to npm.

Peer floor: Pi 0.84.2; tested against 0.84.2 and 0.85.1.

Installs `web_search` and search activity rendering. Depends only on
`pi-codex-runtime`, not core, imagegen or the old bundle.
Catalog-supported standalone profiles call `alpha/search` using Pi's model
registry authentication. Hosted profiles require core; without it the tool stays
inactive and explicit execution reports the missing provider capability.

When core is present, the broker contributes response-local search capture and
citation signatures without a second provider registration.
Uses the existing
`<agentDir>/extensions/pi-codex-minimal-tools/{config,models}.json` settings.
Unknown models are not enabled by inference.

The reserved endpoint is an unsupported compatibility surface, not a promise of
account access. `./internal/*` is implementation wiring.
See [the package guide](../../docs/codex-packages.md). From repository root:

```bash
npm run check -w @oai404iao/pi-codex-web-search
npm run test:codex-packages
```
