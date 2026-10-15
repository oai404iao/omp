# @oai404iao/pi-codex-imagegen

Compatibility entry that selects only `image_generation` from
[`pi-codex-tools`](../pi-codex-tools/README.md). It does not install the Responses
engine or register the other tools. Compatible duplicate installations share
per-capability broker claims in either load order.

Existing configuration remains at
`<agentDir>/extensions/pi-codex-minimal-tools/{config,models}.json`.
Runtime owns the schemas/catalog. Global `enabled:false` and the capability's
kill switch prevent registration, rendering and commands. Pi 1.2.0 is the
supported floor and development target.

Standalone execution uses Pi model-registry authentication and the resolved
endpoint. No fallback account, endpoint or implementation is selected.
Image generation is standalone-only; `/image-gen` and display are owned by tools.

See the [tools guide](../pi-codex-tools/README.md) and
[composition guide](../../docs/codex-packages.md). Internal implementation paths
are not exported by this compatibility package.

## License

See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
