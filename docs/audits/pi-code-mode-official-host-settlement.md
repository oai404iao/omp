# Official Code Mode Host and truthful policy settlement

Date: 2026-09-26. Based on `main@92c0a630` after PR #61 integrated the previous
Responses/composition work. Scope is the private Code Mode package; no npm
publication, automatic Host download, platform expansion or permission expansion.

## Official artifact

The production pin changes from the local GNU
`rust-v0.155.1+pi-v8-sort.1` build to the official static musl
[`rust-v0.157.1`](https://github.com/openai/codex/releases/tag/rust-v0.157.1) Host.

| Identity | Value |
| --- | --- |
| Release source | `36650394c5b38c2990ccf2a3457165ca3e9d9726` |
| Target | `x86_64-unknown-linux-musl` |
| Archive | `codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz` |
| Archive bytes / SHA-256 | `27470020` / `3516f9b8bbe6bc06ee7bdb92b293a17eab194b3f10b9b9ea10c5b839e972d7fc` |
| Executable bytes / SHA-256 | `73962384` / `67b86142bac5cead11b8420cf32d3a2bf88c8868d71733f351ed7c5d95a953e0` |

The downloaded archive digest matches the GitHub release asset digest. `file`
reports a stripped x86-64 static-PIE ELF. The release contains the formerly
backported V8 workaround `aaa2cabfbcb8d9997ce67e166f796f46d5b72342`; the binary
contains `--no-maglev --no-turbolev --no-turbo-inline-array-builtins`.
`code-mode-protocol/src/host` has no source difference between the 0.155.1 and
0.157.1 release tags, but runtime internals did change, hence the real Host tests.

Only the obsolete glibc/OpenSSL gate is removed. Linux x64, user systemd,
verified cgroup limits, independent watchdogs, regular-file/hash validation and
content-addressed cache validation remain mandatory. Old binaries are not
fallbacks. Historical build scripts, S0 locks and old audits remain historical.

This is digest/provenance verification, not a Sigstore attestation check,
reproducible-build claim or general sandbox/security certification.

## Settlement changes

- Structural unsettled-effect failures are handled at synchronous `prepare`,
  policy and approval boundaries as well as invocation/after-policy failures.
  Shared scheduler admission closes before cancellation can pump a queued job.
  Each bridge reports its fatal state once, without losing late fatal errors.
- Binding delivery and invocation lifetime are distinct promises. A policy
  abort/timeout rejects delivery promptly; the lifetime still awaits the
  original hook. Exclusive slots, `settledAt`, completion receipts and cell
  retirement follow that lifetime, not the delivery race.
- A late successful policy result cannot dispatch another stage or expose
  unredacted data. Ordinary asynchronous cancellation cleanup does not poison a
  session. Explicit unsettled effects do. Never-settling hooks remain pending;
  bounded session teardown still fails closed rather than claiming cleanup.
- Approval providers retain their original receiver and the approval queue
  retains its real-dialog lifetime. No new permission or redaction mechanism
  is introduced.

## Verification

- `npm run check --workspace @oai404iao/pi-code-mode`: **161 passed**, including
  synchronous/late fatal preflight and approval cases, actual five-second
  policy timeout, retained exclusive slots, late cleanup and receipt timing.
- `CODE_MODE_TEST_HOST=... npm run test:host --workspace @oai404iao/pi-code-mode`:
  **57 passed** against the official binary, including OOM/watchdogs, store,
  concurrent cells, transport/history, termination and Pi lifecycle coverage.
  New real-Host cases catch a policy timeout in JS and confirm the cell remains
  nonterminal until cleanup, usage is delivered once, and late fatal cleanup
  blocks session reuse.
- `npm run test:code-mode-package -- --host ...`: passed the isolated standalone
  production-tarball installation and real-Host probe on Pi 0.87.1.
- The same command with `--codex`: passed the isolated Codex composition,
  grammar/exec/wait, patch/search fixtures and cooperative visibility checks.
- `npm run ci`: passed complete workspace verification, architecture/release
  checks, license/pack gates and the 17 isolated Codex installation combinations.
- Independent read-only implementation review: no actionable defects found.

Provider requests used fixtures; no live model account calls were made.
Machine-local logs are retained under
`~/.local/state/agents/tmp/code-mode-upgrade.YxSe8Kx3/`.
