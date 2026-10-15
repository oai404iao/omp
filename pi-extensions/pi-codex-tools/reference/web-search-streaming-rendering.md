# Web search transport, streaming, and rendering

This note records how the analyzed Codex checkout turns hosted OpenAI
Responses web-search items into a begin/end UI lifecycle. It also defines the
minimum behavior for this extension's SSE and WebSocket adapters.

Codex also has a standalone client-executed `web.run` extension. Hosted and
standalone search share a user-facing purpose but use different protocols.

## Wire lifecycle

Hosted web search is represented by a Responses output item, not a normal
function/custom tool call.

The start event is a partial item:

```json
{
  "type": "response.output_item.added",
  "output_index": 0,
  "item": {
    "type": "web_search_call",
    "id": "ws_123",
    "status": "in_progress"
  }
}
```

The authoritative completed item arrives later:

```json
{
  "type": "response.output_item.done",
  "output_index": 0,
  "item": {
    "type": "web_search_call",
    "id": "ws_123",
    "status": "completed",
    "action": {
      "type": "search",
      "query": "weather seattle"
    }
  }
}
```

The public OpenAI Responses stream also defines three web-search-specific
progress events:

```json
{
  "type": "response.web_search_call.in_progress",
  "item_id": "ws_123",
  "output_index": 0,
  "sequence_number": 3
}
```

```json
{
  "type": "response.web_search_call.searching",
  "item_id": "ws_123",
  "output_index": 0,
  "sequence_number": 4
}
```

```json
{
  "type": "response.web_search_call.completed",
  "item_id": "ws_123",
  "output_index": 0,
  "sequence_number": 5
}
```

These progress events identify the item and phase but do not carry the query,
action, or sources. The completed `response.output_item.done` item remains the
authoritative source for display detail.

Codex's SSE parser maps both events to the generic response-item lifecycle:

```text
response.output_item.added -> ResponseEvent::OutputItemAdded
response.output_item.done  -> ResponseEvent::OutputItemDone
```

At the analyzed commit, Codex ignores the three
`response.web_search_call.*` progress events and derives its UI lifecycle from
the partial and completed output items. The extension supports both forms:
the progress events improve compatibility with public Responses streams, while
the output items provide Codex-compatible detail and fallback behavior. The
same extension state machine is used for SSE and Responses WebSocket.

## Action variants

`WebSearchAction` is a tagged union:

```text
search       { query?, queries? }
open_page    { url? }
find_in_page { url?, pattern? }
other
```

Display detail follows Codex's precedence:

- `search`: non-empty `query`; otherwise the first entry in `queries`, with
  ` ...` when more than one query exists;
- `open_page`: URL;
- `find_in_page`: `'<pattern>' in <url>`, or whichever value is present;
- unknown/missing action: no detail.

The start item commonly has no action. Rendering must therefore allow an
activity row to begin with only the item ID and be reconciled by the completed
item.

## Codex UI lifecycle

On `response.output_item.added`, Codex:

1. parses the partial `web_search_call` into a `WebSearchItem`;
2. emits `ItemStarted` and the legacy `WebSearchBegin` event;
3. creates an active TUI cell labeled `Searching the web`.

On `response.output_item.done`, Codex:

1. parses the completed action;
2. emits `ItemCompleted` and the legacy `WebSearchEnd` event;
3. finds the active cell by call ID, updates its action/detail, marks it
   complete, and renders `Searched the web for <detail>`;
4. falls back to a new completed cell when no matching active cell exists.

This ID-based reconciliation is important for incomplete streams, missing
start events, and terminal response payloads that contain only completed
output items.

## Sources and citations

When requested through:

```json
{
  "include": [
    "web_search_call.action.sources",
    "web_search_call.results"
  ]
}
```

the completed action can contain source records, while `results` contains the
search result snippets, titles, URLs, and internal reference markers such as
`turn0search2`. The extension preserves the completed item for exact history
replay and builds a reference-to-URL map from those result records. Assistant
answer citations are a separate stream concern: `url_citation` annotations
attached to output text are rendered as Markdown links by the Responses message
parser and retained in the replayed message item.

Some compatible endpoints return a prior-turn citation without annotations as
an internal marker such as `cite...` or `【0†source】`. The parser resolves
those markers from the preserved search results or the latest prior citation
links. Unresolvable protocol markers are removed rather than exposed to the
user; literal examples inside Markdown code remain unchanged.

## Extension behavior

Pi's assistant stream protocol has no provider-activity event variant.
`pi.sendMessage()` during an active model stream enters the steer queue, which
would display the search only after the assistant reply finishes. The adapter
therefore does not use custom messages for newly streamed search activity.

Instead, it inserts a display-only text block directly into the current partial
assistant message. This preserves the wire order seen by Pi:

```text
thinking block
web-search activity block
final answer block or later tool call
```

The activity block is updated in place as progress and authoritative output
items arrive. Its `textSignature` uses a reserved
`pi:web-search-activity:` prefix. A completed activity stores a sanitized
`web_search_call` item, including `results`, in the signature. The Responses
history converter recognizes that payload and replays the provider item in its
original output position; legacy activity signatures remain display-only. The
session transcript therefore retains both the compact UI row and the hidden
metadata needed by later turns.

The adapter uses this transport-neutral lifecycle:

```text
output_item.added(web_search_call) -> begin/update pending search by call ID
web_search_call.in_progress        -> begin/update pending search by item ID
web_search_call.searching          -> mark pending search as searching
web_search_call.completed          -> mark pending search as completed
output_item.done(web_search_call)  -> complete pending search by call ID
terminal response.output fallback -> synthesize missing done event once
```

Rendering follows the Codex compact form:

```text
Searching the web <detail>
Searched the web for <detail>
```

Searches are deduplicated by call ID so a normal `added`/`done` pair, the
three progress events, and a terminal-output fallback update one row rather
than creating duplicates. The old custom-message renderer remains readable for
sessions created by earlier extension versions.

## Standalone `web.run`

The current Codex web-search extension registers a namespace tool:

```json
{
  "type": "namespace",
  "name": "web",
  "description": "Tools in the web namespace.",
  "tools": [
    {
      "type": "function",
      "name": "run",
      "strict": false,
      "parameters": "<SearchCommands schema>"
    }
  ]
}
```

`SearchCommands` supports:

- text and image queries;
- open, click, and find operations;
- PDF screenshots;
- finance, weather, sports, and time lookups;
- short, medium, or long output.

The executor posts a `SearchRequest` to `alpha/search` containing the session
ID, active model, a bounded recent visible conversation tail, commands,
settings, and a maximum output-token budget. Current extension settings use
`allowed_callers:["direct"]` and live external web access.

The response carries plaintext `output`, optional opaque structured `results`,
and an optional encrypted field. Codex returns only plaintext as the
function-call output and publishes structured results out of band. This
extension follows that model: the text is model-visible and `results` remain
in Pi tool-result details.

In Lite, hosted tools are invalid, so an enabled search profile must use
standalone `web.run`. In Standard mode the profile explicitly chooses hosted
or standalone behavior.

## Codex sources

- `codex-rs/codex-api/src/sse/responses.rs`
- `codex-rs/protocol/src/models.rs`
- `codex-rs/core/src/event_mapping.rs`
- `codex-rs/core/src/web_search.rs`
- `codex-rs/core/src/session/turn.rs`
- `codex-rs/core/tests/common/responses.rs`
- `codex-rs/core/tests/suite/items.rs`
- `codex-rs/tui/src/chatwidget/tool_lifecycle.rs`
- `codex-rs/tui/src/history_cell/search.rs`
- `codex-rs/ext/web-search/src/tool.rs`
- `codex-rs/ext/web-search/src/history.rs`
- `codex-rs/ext/web-search/src/extension.rs`
- `codex-rs/codex-api/src/search.rs`
- `codex-rs/codex-api/src/endpoint/search.rs`
- `openai/resources/responses/responses.d.ts` from the installed OpenAI
  JavaScript SDK (definitions of the three progress events)
