import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runIsolatedTests } from "./run-isolated.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../../pi-extensions/pi-codex-core/package.json", import.meta.url));
const piPackage = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"))), "../package.json");
const piVersion = JSON.parse(readFileSync(piPackage, "utf8")).version;
assert.equal(piVersion, "0.87.1", "Characterization expectations are pinned to Pi 0.87.1; review them before changing the baseline.");

const scratchRoot = join(homedir(), ".local/state/agents/tmp");
mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
const dir = mkdtempSync(join(scratchRoot, "codex-ablation-"));
chmodSync(dir, 0o700);
for (const name of ["home", "agent", "config", "cache", "data", "state"]) {
	mkdirSync(join(dir, name), { mode: 0o700 });
}
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sources = readdirSync(import.meta.dirname).filter((name) => /\.(ts|mjs)$/.test(name)).sort();
const manifest = {
	revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
	dirty: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
	node: process.version,
	piVersion,
	lockSha256: sha256(join(root, "package-lock.json")),
	nativeSha256: sha256(new URL(import.meta.resolve("@earendil-works/pi-ai/api/openai-codex-responses"))),
	nativeSharedSha256: sha256(new URL(import.meta.resolve("@earendil-works/pi-ai/api/openai-responses-shared"))),
	sources: Object.fromEntries(sources.map((name) => [name, sha256(join(import.meta.dirname, name))])),
	startedAt: new Date().toISOString(),
};
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Offline Codex ablation evidence: ${dir}`);

// Do not inherit provider credentials, proxies, user configuration, or NODE_OPTIONS.
const result = await runIsolatedTests([
	"--import", pathToFileURL(require.resolve("tsx")).href,
	"--test", "--test-concurrency=1", "--test-reporter=tap",
	...sources.filter((name) => /\.test\.(ts|mjs)$/.test(name)).map((name) => join(import.meta.dirname, name)),
], {
	cwd: dir,
	env: {
		PATH: process.env.PATH,
		HOME: join(dir, "home"),
		TMPDIR: dir,
		XDG_CONFIG_HOME: join(dir, "config"),
		XDG_CACHE_HOME: join(dir, "cache"),
		XDG_DATA_HOME: join(dir, "data"),
		XDG_STATE_HOME: join(dir, "state"),
		PI_CODING_AGENT_DIR: join(dir, "agent"),
		PI_OFFLINE: "1",
	},
	logPath: join(dir, "tests.tap"),
	timeoutMs: 60_000,
});
writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2) + "\n");
process.exitCode = result.code === 0 && !result.error && !result.stopReason ? 0 : 1;
