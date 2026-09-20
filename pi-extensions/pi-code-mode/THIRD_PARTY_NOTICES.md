# Third-party references

The TypeScript implementation is project-authored, MIT-licensed. It is based on
the repository's S0 protocol experiments, not copied from the Codex extension.

This package interoperates with an external user-supplied OpenAI
`codex-code-mode-host`, release `rust-v0.145.0`, source revision
`25af12f7e61572b0bc18ddb1008be543b91519b0` of
<https://github.com/openai/codex>. Its artifact URL, archive hash and executable
hash are pinned in `src/limits.ts`. The release/source mapping and archive hash
were researched using howaboua-pi-stuff revision `4593f06`
(`packages/pi-codex-conversion/src/tools/code-mode/host-assets.ts` and
`code-mode/UPSTREAM_SYNC.md`).

No upstream binary, archive, Rust source, or runtime library is distributed or
downloaded by this package. The external executable retains its own upstream
license and notices. Digest verification establishes artifact identity, not
publisher attestation, reproducible compilation or a vulnerability audit.
Any future bundling, downloading or public release needs separate provenance,
license and distribution approval. The package remains private/blocked.
