# Codex wire alignment and migration

The serializer baseline is OpenAI Codex
[`5a3140176e668a2f72f3c098490eb7f7052d9d85`](https://github.com/openai/codex/tree/5a3140176e668a2f72f3c098490eb7f7052d9d85).
This is source/fixture alignment, not a guarantee of endpoint entitlement or
server acceptance. Pi still owns model selection, authentication and effective
base URLs. It does not impersonate the Codex CLI.

## Request contracts

- Both Standard and Lite put base instructions in developer input. Stable
  thread-scoped UUIDv5 prefix IDs match Codex's construction. Standard sends
  an empty tools list when appropriate; Lite omits empty additional-tools items.
- Verified model profiles declare verbosity and reasoning support/defaults.
  Unknown profiles do not acquire capabilities from name patterns.
  Older models absent from the pinned upstream catalog retain explicit local
  profile inheritance; those inherited defaults are compatibility policy, not
  newly verified upstream model records.
- Wire window IDs are `thread_id:window_number`; context-window UUIDs are
  independent and included in turn metadata. Old session identity records are
  migrated without replacing their context UUID or thread identity.
- Spawn headers use `collab_spawn`; metadata uses `thread_spawn` and canonical
  `/root/...` agent paths. Queued work captures causal parent/root turn
  attribution instead of looking up whichever parent turn happens to be active.
- HTTP and WS metadata use ASCII-safe JSON. Actual model/effort and remote
  compaction operation metadata describe the request being sent.
- Lite prewarm accepts stable developer/tool prefixes, not arbitrary user
  history. Native codemode/tool-search still disable speculative prewarm when
  Pi cannot supply the final tool projection.
- Search uses a separate external-tool metadata projection, not the entire
  Responses blob. Visible history ends at the latest user message, with the
  upstream UTF-8 approximate-token truncation policy.
- Image generation accepts `transparent_background`; false/omitted produces
  `opaque`, true produces `transparent`. Generation/edit requests remain JSON.

## Breaking removals

- `tools.imageGeneration:"hosted"` no longer executes. User profiles declaring
  it are disabled with migration diagnostics; select `"standalone"` explicitly.
  The bundled GPT-4.1 image profile now selects standalone generation.
- `directImageApiFallback:true` disables image execution and reports migration diagnostics.
  Remove that property; there is one Images execution path, not a fallback.
- `compaction:"responses-compact"` and global `compactionMode:"responses-compact"`
  no longer execute `/responses/compact`. Select `"responses"` for native
  `compaction_trigger`, or `"pi"` for text compaction where history permits it.
  The removed global setting blocks requests until migrated, without unloading
  historical checkpoint protection.
- Endpoint allowlists no longer accept hosted image or unary compaction.
  Removed/invalid entries disable the affected capability rather than choosing
  an alternate route.
- Historical image results and opaque compaction checkpoints retain replay
  support. Removing execution paths does not authorize deleting session data or
  replacing opaque checkpoints with text.
  Known bundled checkpoint profile hashes are migrated explicitly. Unrecognized
  custom-profile hashes remain fail-closed rather than bypassing model identity.
- Old `systemPromptPlacement:"instructions"` settings normalize to developer
  input with a diagnostic; the current schema advertises only developer input.

## Search model policy

`tools.webSearch` retains hosted/standalone selection and content types, and
accepts `mode` (`cached`, `indexed`, `live`), `searchContextSize`,
`userLocation`, `filters.allowedDomains`, and `maxOutputTokens`.
The standalone output budget defaults to the pinned catalog's 10,000 tokens
and can be overridden per model. Hosted requests receive the applicable search
policy; no endpoint is inferred merely from the declaration.

## Deliberate Pi boundaries

- Keep `originator:pi`, Pi authentication and honest client identification.
  Explicit provider headers and suppression remain authoritative.
- Do not fabricate Codex version, sandbox/approval state, Guardian credits,
  attestation, routing hints, or MCP accounting unavailable from Pi.
- Do not add workspace/Git telemetry collection or upload merely to match
  optional Codex telemetry fields.
- Configured residency/auth headers are passed through. Their presence and
  validity belong to Pi/provider authentication, not guessed token claims.
- Preserve `codexRequestExtensions:false` as an explicit opt-out; Lite/native
  compaction still fail closed when that switch makes their protocol unavailable.

## Source evidence

The baseline's `core/src/client.rs`, `responses_metadata.rs`,
`turn_metadata.rs`, `session/{mod,session,startup_prewarm}.rs`,
`ext/web-search/src/{tool,history,extension}.rs`,
`tools/src/response_history.rs`, `utils/string/src/truncate.rs`,
`ext/image-generation/src/{tool,backend}.rs`, and `codex-api/src/{common,images}.rs`
define the compared field shapes and lifecycle boundaries.
Namespace adaptations retain Apache attribution and immutable prior provenance;
new image declarations have separate pinned evidence. Existing historical
source maps are not rewritten to claim they analyzed this newer commit.
