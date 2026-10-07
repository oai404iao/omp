# pi-codex-imagegen

See the package guide below for release status; source edits do not publish artifacts.

Peer floor and development target: Pi 0.99.1.

Image generation uses standalone Images endpoints and is directly callable,
including through codemode while active. This does not enable codemode itself.
Hosted Responses image generation and `directImageApiFallback` have been removed.
Legacy hosted profiles are disabled with a diagnostic rather than silently routed
to a different implementation. Historical image outputs still replay and display.

Codemode scripts receive `{ path, latestPath?, image: { type, data, mimeType } }`.
The image data is base64; use `image(result.image)` to forward it to the model.
Saving and direct model-facing image/text output retain their existing behavior.
Failed generation rejects the call instead of returning success-shaped data.
Pi intentionally resolves retained structured data if a `tool_result` hook
only sets `isError: true`. To reject or redact, that hook must also replace
`content` without supplying `structuredContent`.

`/image-gen` jobs are cancelled when the session is replaced or closed.
Late authentication/results cannot notify the replacement session or initiate
new image writes. Already-started server generation or disk writes cannot be
rolled back; cancellation is not a guarantee of avoiding provider charges.

Installs `image_generation`, background image commands, image persistence and
presentation. Its only workspace dependency is `pi-codex-runtime`, not core,
web-search or the bundle. Photon supplies image decoding and PNG encoding.
When global `config.json.imageGeneration` is `false`, none of those generation
surfaces are registered. The gate also blocks late/manual standalone execution
before authentication or network I/O.
Catalog-supported standalone profiles call Images generation/edit endpoints with
Pi authentication. `transparent_background:true` requests transparency;
omitted or false requests an opaque background. References are sniffed by content,
including extensionless PNG/JPEG/WebP; GIF/BMP normalize to PNG without resizing.
All image paths, including background jobs, use
the selected provider's Pi-resolved credentials, headers and base URL. The
client never reads a separate `OPENAI_API_KEY` or forces the public OpenAI endpoint.
Authentication failure never switches accounts or providers.
`endpoint_config.imageGeneration` limits allowed modes at the authenticated
endpoint. Rejected/denied standalone jobs do not fall through to hosted jobs.
Explicit protocol rejection temporarily disables that mode for the session,
including background jobs. With `codexRequestExtensions:false`, standalone
requests omit generated Codex image-turn headers.

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

Client/capture/display/background-job regressions are in `tests/`; cross-package
integration is in root `tests/codex/`. See the
[shared configuration guide](../pi-codex-runtime/reference/configuration.md) and
[image-generation example](assets/image-generation.gif). The example is a
repository asset, not part of the runtime tarball.
