# Patched Code Mode Host build

**Historical recipe only.** The current pin is the official static musl
`rust-v0.157.1` Host, which already includes the workaround below. No local build
is required; see [current requirements](../pi-extensions/pi-code-mode/README.md).
This recipe still produces the old GNU candidate, which the current allowlist
rejects. Retained build hashes and audit records are not rewritten.

U0 targets a **local patched** `rust-v0.155.1+pi-v8-sort.1`, not the official
0.155.1 release binary. The user authorized backporting upstream
[`aaa2cabfbc`](https://github.com/openai/codex/commit/aaa2cabfbcb8d9997ce67e166f796f46d5b72342)
to [`be2951ea34`](https://github.com/openai/codex/commit/be2951ea34f0d295ed0becf97079f92fa5f6950e).
OpenAI's patch/source is Apache-2.0; see the extracted upstream LICENSE/NOTICE
and repository `LICENSES/Apache-2.0.txt`. No Host binary is bundled in this repo.

```sh
node scripts/build-code-mode-host.mjs --repo /absolute/path/to/openai/codex
```

The local repository must contain both exact commits. The script archives them
without changing that checkout, verifies patch/lock hashes, repairs only the
upstream release lock's source-less workspace versions, then uses locked Cargo
dependencies. The default denoland sandbox artifact URL is not published for this
target: the recipe verifies Codex's checked manifest and matching archive/binding
pair from `rusty-v8-v150.4.0`, using `RUSTY_V8_ARCHIVE` and
`RUSTY_V8_SRC_BINDING_PATH` exactly as the upstream release flow does.
The upstream regression uses main's newer per-execute delegate API; only its
fixture wiring is adapted to stable 0.155.1's constructor delegate API. The JS
regression and expected result are unchanged, and the adapted test hash is recorded.
It runs that regression and retains source/build
output/provenance beneath `~/.local/state/agents/tmp/`.

Requirements: Linux x64 GNU/glibc, Rust 1.95.0, Cargo, C/C++ linker, cmake and
protoc, network access to locked crate/git/V8 artifacts, sufficient disk/memory.
This is a trusted native build, not execution of model code. Run with bounded
build resources where appropriate. It is not a musl/static distribution or a
cross-platform artifact. Rustup/Cargo may populate their normal tool caches.

Profile: release, two jobs, no debug/incremental/LTO, 16 codegen units, stripped
symbols. Provenance records the actual compiler and output hash. Different build
environments can produce different bytes; this is **not** a reproducible-build
or signature claim. An output candidate is not silently added to the allowlist.

Only after regression, real supervised Host tests and production installation
checks pass may the reviewed candidate replace the single production pin.
The upstream optimization workaround is not a general security certification;
Code Mode remains private/blocked and the Host is not an OS permission sandbox.
