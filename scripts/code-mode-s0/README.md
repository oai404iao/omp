# Code Mode S0 lab

Repository-only feasibility experiments for the
[independent extension design](../../docs/plans/pi-code-mode.md).
These files are **not** a Pi extension, package, provider, production runtime or
security SDK. They do not change existing Codex tools.

## Run

From the repository root, after the normal locked `npm ci --ignore-scripts`:

```sh
npm run test:code-mode-s0 -- --archive /absolute/path/to/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz
```

The filename itself is irrelevant; both archive and extracted binary must match
[`host-lock.json`](host-lock.json). This command never downloads or executes an
unverified artifact. Obtain the pinned archive separately from the URL in the
lock, or supply an existing cache. Unexpected hash/platform/prerequisites fail
the run; they are not silently skipped.

Required:

- Linux x64, Pi **0.85.1**, repository dependencies, Node 22.19+ (actually
  exercised here on Node 24.13.0; other Node versions are not claimed tested).
- `tar`, `/usr/bin/env`, `systemd-run`, `systemctl`.
- A working **user** systemd manager and cgroup v2 memory controller with
  delegated accounting/limits. No sudo, container setup or system configuration
  changes are performed.

## Safety and isolation

The runner verifies hashes and the exact single archive entry before extraction.
It creates a private retained directory beneath
`$HOME/.local/state/agents/tmp/code-mode-s0-*`, then rebinds child HOME, Pi agent
directory and XDG data/config/cache paths. No real auth file, project extension,
skills, AGENTS context or provider network request is needed. The model is a
deterministic fixture; Pi's loader, session, agent hooks and tools are real.

Every Host is a separate uniquely named user service with:

| Setting | Value |
| --- | --- |
| `MemoryMax` | 192 MiB |
| `MemorySwapMax` | 0 |
| `TasksMax` | 64 |
| `CPUQuota` | 100% |
| `RuntimeMaxSec` | 20 seconds; 2 for the watchdog test |
| `LimitCORE` | 0 |
| process environment | `env -i` plus fixture HOME/TMPDIR |

Before stress code, tests verify both the service properties and the actual
kernel `memory.max`, `memory.swap.max`, `pids.max`, `cpu.max` files, and confirm
the Host PID belongs to that cgroup. Memory allocation is finite (at most approximately 1 GiB requested,
within the 192 MiB cgroup); flood examples are finite. The infinite CPU loop has
both normal V8 termination and an independent OS watchdog.

Teardown stops **only each test's own service/cgroup**, kills its proxy and
clears that service's failed state. It does not sweep other services. Scratch
files, binaries and logs are intentionally retained; nothing removes them.
If the test runner is forcibly killed, Host services still have the OS deadline.
Control-plane commands have explicit timeouts. The outer runner also enforces a
120-second experiment deadline, terminates only its test process group, and
attempts bounded shutdown of only the units recorded by this run.
The supervisor is a **lab safety mechanism**, not proof of a portable production
sandbox. This run intentionally creates OOM/timeout failures in its own services.

## Evidence

The printed directory contains:

- `manifest.json`: fixed artifact identity, Node/Pi/platform, base revision,
  root-lock hash and hashes of the exact lab sources (including uncommitted code).
- `tests.tap`, `result.json`: complete test output and exit status.
- `limits.jsonl`: service settings, kernel limits and Host PID/cgroup membership.
- `units.jsonl`: this run's service identities for abnormal-shutdown handling.
- `memory.jsonl`: actual `oom-kill`, peak memory and enforced limit.
- `watchdog.jsonl`: actual `timeout` outcome.
- `pi-api.jsonl`: real tool metadata keys and absence of `executeTool`.
- Isolated fixtures and the verified Host executable.

See the [S0 audit](../../docs/audits/pi-code-mode-s0.md) for actual results.
**Green tests include assertions that upstream protections are absent.**
They mean those deficiencies were reproduced, not that the Host is safe to
publish without supervision.

This opt-in suite is deliberately not part of ordinary `npm run ci`, which must
not require an external Host archive or a user systemd manager.

## Tested protocol V1 notes

`host-client.mjs` is an intentionally restricted, original lab implementation
written from the observed protocol, not copied/vendored reference source.

- stdio frames: u32 little-endian byte length followed by JSON.
- Hello negotiates V1 with no required capabilities.
- `session/open` creates a Host session.
- `session/execute` receives `execution/started`, then a separate
  `execute/initialResponse` with the same operation ID.
- Runtime values are externally tagged `Result`, `Yielded`, `Terminated`;
  output is in `content_items`, not independent streaming-output events.
- Host→client `delegate/request` requires `delegate/response`; nested cancellation
  is a separate `delegate/cancel`.
- `session/wait` observes; `session/terminate` terminates.
- **After `execution/started`, cancelling that execute operation does not cancel
  its initial observation.** Cancelling a pending wait cancels only the observer.
  Neither substitutes for cell termination.
- Unknown fields, including `max_heap_size_bytes`, fail this pinned protocol.
- `max_output_tokens` is accepted but does not bound Host output.

The lab client has a smaller frame budget than upstream, bounded stderr capture
and operation deadlines. It deliberately omits production features such as
streaming backpressure, schema-complete IPC validation, reload/generation
ownership, durable traces, a background wait UI and arbitrary adapter discovery.
`bridge.mjs` demonstrates explicit admission/approval/result boundaries and
rejects excess concurrency rather than implementing a production scheduler.
It cannot automatically call arbitrary Pi tools or reuse native permission hooks.

## Provenance and distribution

The pinned archive SHA-256 comes from howaboua's `host-assets.ts` at reference
commit `4593f06`; its `code-mode/UPSTREAM_SYNC.md` identifies the upstream source
commit in the lock. The extracted binary hash is separately checked. Hash
matching proves consistency with that recorded artifact, not publisher
attestation, reproducible compilation, freshness or a security review.

No upstream executable, Rust source, archive or license text is redistributed
by this change. Any future published package that bundles/downloads the Host
needs its own source/license/provenance and distribution review. The existing
Codex research checkout at `7498521d28` is newer than this artifact and must not
be used to infer this artifact's wire fields.
