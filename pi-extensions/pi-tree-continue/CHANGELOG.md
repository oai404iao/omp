# @oai404iao/pi-tree-continue

## 0.2.0

### Minor Changes

- 326891d: Require Pi 0.87.0 or newer and target 0.87.1. Respect canonical context edits in
  child inheritance, grammar eligibility and message-free continuation, and collect
  child results from finalized events rather than a mutable context offset.
  
  Native compaction now writes retain-none v4 checkpoints and preserves composed
  context transforms without restoring old system/tool state. Legacy checkpoints
  still replay unchanged contexts; if an earlier context transform changes them,
  the run stops with a request to recompact on the original model instead of
  reviving filtered content. Failed recompression preserves the existing checkpoint.
  
  Add evidence-backed exact Codex GPT-6 Sol/Luna profiles and preserve their
  descriptor's Off reasoning mapping. No guessed fast-mode billing, ultra effort,
  context size override or public-API cache TTL is added to Codex Lite.
  Notifications and cleanup remain on agent_settled; boundary continuation and
  deferred settled runs have real SDK regression coverage.
