# Third-party references

The TypeScript implementation is project-authored, MIT-licensed. It is based on
the repository's S0 protocol experiments, not copied from the Codex extension.

This package interoperates with an external user-supplied OpenAI
`codex-code-mode-host`, locally patched version `rust-v0.155.1+pi-v8-sort.1`:

- Base source: `be2951ea34f0d295ed0becf97079f92fa5f6950e` (`rust-v0.155.1`).
- Backported upstream patch: `aaa2cabfbcb8d9997ce67e166f796f46d5b72342`,
  disabling affected V8 array-sort optimization paths and adding a regression test.
- Source/patch repository: <https://github.com/openai/codex>, Apache-2.0.
- Exact binary, compiler, source-lock repair and V8 archive/binding hashes:
  `src/host-manifest.json`.

This is not an official OpenAI release artifact. The user separately authorized
the local build; the development recipe in `scripts/build-code-mode-host.mjs`
retains the extracted source LICENSE/NOTICE. The old 0.145.0 provenance remains
in the repository's historical S0 lock and audits, not in the current allowlist.

No upstream binary, archive, Rust source, or runtime library is distributed or
downloaded by this package. The external executable retains its own upstream
license and notices. Digest verification establishes artifact identity, not
publisher attestation, reproducible compilation or a vulnerability audit.
Any future bundling, downloading or public release needs separate provenance,
license and distribution approval. The package remains private/blocked.
