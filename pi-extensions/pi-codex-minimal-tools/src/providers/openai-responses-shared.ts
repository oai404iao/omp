// Compatibility facade. Implementations must import their owning modules directly.
export { collectHistoricalCitationSources, collectWebSearchCitationSources, extractWebSearchCitationSources } from "./responses/citations.js";
export { convertResponsesMessages } from "./responses/messages.js";
export { WEB_SEARCH_ACTIVITY_TEXT_SIGNATURE_PREFIX, decodeWebSearchActivityTextSignature, encodeWebSearchActivityTextSignature, isWebSearchActivityTextSignature } from "./responses/signatures.js";
export { processResponsesStream } from "./responses/stream.js";
export { convertResponsesTools } from "./responses/tools.js";
export type { CitationSource, OpenAIResponsesStreamOptions, ReplayableWebSearchCallItem, WebSearchCitationSource } from "./responses/types.js";
