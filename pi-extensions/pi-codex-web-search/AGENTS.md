# pi-codex-web-search — maintenance

Thin compatibility factory selecting only `web_search` through the declared
`pi-codex-tools` subpath. Implementation, behavioral tests, protocol evidence,
assets and rendering belong to [tools](../pi-codex-tools/AGENTS.md).

Do not restore implementation forwards or add core/runtime/capability dependencies.
Preserve the public default factory, explicit manifest allowlist and independent
capability selection. Read [composition](../../docs/codex-packages.md) before
changing wiring. Follow root Changesets and publication requirements.

From the repository root run:

```sh
pnpm --filter @oai404iao/pi-codex-web-search run check
pnpm run test:codex-composition
pnpm run test:codex-packages
```

The local test checks importability; behavior belongs to tools and cross-package
composition belongs to root `tests/codex/`. Do not run live endpoints.
