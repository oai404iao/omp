# Third-party references

The TypeScript implementation is project-authored, MIT-licensed. It is based on
the repository's S0 protocol experiments, not copied from the Codex extension.

This package interoperates with an external user-supplied OpenAI
`codex-code-mode-host`, official release `rust-v0.157.1`:

- Release source: `36650394c5b38c2990ccf2a3457165ca3e9d9726`.
- Upstream includes `aaa2cabfbcb8d9997ce67e166f796f46d5b72342`, disabling
  affected V8 array-sort optimization paths and adding a regression test.
- Source repository: <https://github.com/openai/codex>, Apache-2.0.
- Official asset: `codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz` from
  <https://github.com/openai/codex/releases/tag/rust-v0.157.1>.
- Exact release/source/target, archive digest and extracted executable
  size/digest: `src/host-manifest.json`.

The static musl release replaces the previously authorized local
`rust-v0.155.1+pi-v8-sort.1` GNU build; no local patch or compilation is required.
The former build recipe and 0.145.0 S0 lock remain historical evidence, not
alternative entries in the current allowlist.

No upstream binary, archive, Rust source, or runtime library is distributed or
downloaded by this package. The external executable retains its own upstream
license and notices. The archive digest was checked against the GitHub release
asset digest; the release's Sigstore bundle was not verified. Digest verification
establishes artifact identity, not publisher attestation, reproducible compilation
or a vulnerability audit.
Any future bundling, downloading or public release needs separate provenance,
license and distribution approval. The package remains private/blocked.
