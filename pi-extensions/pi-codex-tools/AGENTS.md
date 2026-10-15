# pi-codex-tools — maintenance

Owns patch, search and image implementations. Read root guidance and
[Codex composition](../../docs/codex-packages.md) before lifecycle changes.

- `src/apply-patch.ts`, `src/web-search.ts`, `src/imagegen.ts` are selective
  factories; `src/index.ts` composes all three.
- `src/patch/`, `src/tools/apply-patch*` and `src/providers/codex-apply-patch*`
  own patch execution, rendering and the sole pinned grammar asset.
- `src/tools/web-search*` own search schema/client/capture/presentation.
- `src/tools/image-generation*`, `src/background-image-*` and `src/utils/images.ts`
  own image execution, storage, display and cancellable background jobs.

Only runtime is an allowed workspace dependency. Never import core, a legacy
compatibility package or the bundle. Preserve per-capability broker claims;
selective factories must not register another capability. Runtime owns settings,
catalog, namespace evidence and broker contracts.

Custom patch and hosted search require actual compatible engine capability,
not merely a model's provider/API name. Function patch and standalone search/images
can operate independently. Do not infer unknown model or endpoint support.
Global kill switches prevent registration, renderers and commands.

Patch loadout projection hides native mutation declarations only, preserving
active/callable tools and saved history. Preserve parser safety, queued mutations,
rollback, CRLF, grammar fingerprints and Apache adaptation notices.
Image clear invalidates sinks and timers without undoing writes already begun;
abort/shutdown suppress late persistence and notifications.

Before wire changes read [wire alignment](../../docs/codex-wire-alignment.md)
and relevant notes under `reference/`. Preserve source provenance and notices.
New modules must stay within 400 lines. Behavioral tests belong in `tests/`;
cross-package composition belongs in root `tests/codex/`.

From repository root run:

```sh
pnpm --filter @oai404iao/pi-codex-tools run check
pnpm run check:architecture
pnpm run test:codex-composition
```

Use tarball checks for assets/exports and the Pi matrix for compatibility changes.
Do not run live endpoints or publish without explicit authorization.
