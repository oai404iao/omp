export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export const MAX_RETRIES = 3;

export const BASE_DELAY_MS = 1000;

export const SSE_RESPONSE_HEADER_TIMEOUT_MS = 20_000;

export const WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;

export const WEBSOCKET_PREWARM_TIMEOUT_MS = 15_000;

export const WEBSOCKET_IDLE_TIMEOUT_MS = 300_000;

export const WEBSOCKET_SEND_TIMEOUT_MS = 300_000;

export const WEBSOCKET_EVENT_QUEUE_CAPACITY = 1600;

export const DEFAULT_WEBSOCKET_STREAM_MAX_RETRIES = 5;

export const MAX_WEBSOCKET_STREAM_MAX_RETRIES = 100;

export const WEBSOCKET_RETRY_BASE_DELAY_MS = 200;

export const WEBSOCKET_RETRY_MAX_DELAY_MS = 60_000;

export const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

export const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";

export const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";

export const CODEX_RESPONSE_STATUSES = new Set(["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"]);

export const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";

export const X_OPENAI_INTERNAL_CODEX_RESPONSES_LITE = "x-openai-internal-codex-responses-lite";

export const WS_RESPONSES_LITE_CLIENT_METADATA_KEY = "ws_request_header_x_openai_internal_codex_responses_lite";

export const WS_STREAM_REQUEST_START_MS_CLIENT_METADATA_KEY = "x-codex-ws-stream-request-start-ms";

export const WEB_SEARCH_SOURCES_INCLUDE = "web_search_call.action.sources";

export const WEB_SEARCH_RESULTS_INCLUDE = "web_search_call.results";

export const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;

export const CODEX_COMPACTION_TRIGGER_TYPE = "compaction_trigger";

export const CODEX_RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;

export const CODEX_MAX_RETAINED_AGENT_MESSAGE_TOKENS = 10_000;

export const CODEX_REMOTE_COMPACTION_STREAM_RETRIES = 2;

export const X_CODEX_BETA_FEATURES = "x-codex-beta-features";

export const CODEX_REMOTE_COMPACTION_V2_FEATURE = "remote_compaction_v2";

export const APPROX_BYTES_PER_TOKEN = 4;
