# pi-keep-defaults — retired

Pi 0.86.1 already keeps ordinary model and thinking-level changes local to the
current session. `pi.setModel()` and `pi.setThinkingLevel()` no longer rewrite
the configured defaults for new sessions. This extension's SettingsManager
patch and settings-file watcher have been removed from the repository, along
with its workspace and release entry.

## Migration

Remove the package from each scope where it was installed:

```bash
pi remove npm:@oai404iao/pi-keep-defaults
# Only if installed in project settings:
pi remove -l npm:@oai404iao/pi-keep-defaults
```

For a local-path installation, remove that exact path with `pi remove`, or
remove its entry from your `packages` / `extensions` settings. Then **fully
exit and restart Pi**: the old extension installed process-global patches,
so `/reload` alone is not a reliable way to remove them.

To change defaults intentionally, edit `defaultProvider`, `defaultModel`, and
`defaultThinkingLevel` in your agent `settings.json`, or use Pi's explicit
save-default controls. Ordinary `/model` and thinking-level changes remain
session-local. The SDK can explicitly persist with `{ persist: true }`.

Retirement does **not** preserve the old stronger behavior of reverting
explicit default-setting writes or external edits to `settings.json`.

Previously published npm artifacts, Git history, the [changelog](CHANGELOG.md),
and release-integrity locks are retained. This repository change neither
uninstalls existing user copies nor deprecates/unpublishes anything on npm.
