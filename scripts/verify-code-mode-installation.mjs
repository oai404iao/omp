import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { isolatedConsumerLock } from "./isolated-consumer-lock.mjs";
import { root } from "./workspaces.mjs";
import { piVersion } from "./pi-baselines.mjs";

const args = process.argv.slice(2);
assert((args.length === 2 || (args.length === 3 && args[2] === "--codex")) && args[0] === "--host",
	"Usage: node scripts/verify-code-mode-installation.mjs --host /absolute/path/to/pinned-host [--codex]");
const withCodex = args[2] === "--codex";
const host = resolve(args[1]);
// Resolve config (including uppercase env/global npmrc) before rebinding HOME.
const npmCache = execFileSync("npm", ["config", "get", "cache"], { cwd: root, encoding: "utf8", timeout: 5000 }).trim();
const scratchRoot = join(homedir(), ".local/state/agents/tmp");
mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
const directory = mkdtempSync(join(scratchRoot, `code-mode-s3-${withCodex ? "codex" : "standalone"}-install-`));
console.log(`Code Mode installation evidence: ${directory}`);
const packageName = "@oai404iao/pi-code-mode";
const packages = [packageName, ...(withCodex ? ["@oai404iao/pi-codex-runtime", "@oai404iao/pi-codex-core", "@oai404iao/pi-codex-web-search"] : [])];
const manifests = new Map(), artifacts = new Map();
for (const name of packages) {
	const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--workspace", name,
		"--pack-destination", directory], { cwd: root, encoding: "utf8", timeout: 30000 }))[0];
	manifests.set(name, JSON.parse(readFileSync(join(root, "pi-extensions", name.split("/")[1], "package.json"), "utf8")));
	artifacts.set(name, { path: join(directory, packed.filename), integrity: packed.integrity });
}
const projected = isolatedConsumerLock("code-mode-s3-isolated-consumer", packages, manifests, artifacts,
	JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")));
writeFileSync(join(directory, "package.json"), JSON.stringify(projected.manifest, null, 2));
writeFileSync(join(directory, "package-lock.json"), JSON.stringify(projected.lock, null, 2));
writeFileSync(join(directory, "probe.mjs"), readFileSync(new URL(withCodex
	? "./code-mode-codex-installation-probe.mjs" : "./code-mode-installation-probe.mjs", import.meta.url)));
for (const name of ["home", "agent", "state", "config", "cache", "cwd"]) mkdirSync(join(directory, name), { mode: 0o700 });
writeFileSync(join(directory, "npmrc"), "");
const env = {
	PATH: process.env.PATH, HOME: join(directory, "home"), TMPDIR: directory,
	XDG_STATE_HOME: join(directory, "state"), XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"),
	PI_CODING_AGENT_DIR: join(directory, "agent"), PI_OFFLINE: "1", CODE_MODE_TEST_HOST: host,
	OMP_PI_EXPECTED_VERSION: piVersion(),
	npm_config_cache: npmCache,
	npm_config_userconfig: join(directory, "npmrc"),
};
for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) if (process.env[key]) env[key] = process.env[key];
const install = execFileSync("npm", ["ci", "--offline", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
	{ cwd: directory, env, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
writeFileSync(join(directory, "install.log"), install);
const installed = join(directory, "node_modules/@oai404iao/pi-code-mode");
assert(realpathSync(installed).startsWith(`${directory}/`), "Installed package must not link back to the workspace");
assert.deepEqual(readdirSync(join(directory, "node_modules/@oai404iao")).sort(), packages.map((name) => name.split("/")[1]).sort(),
	"Only explicitly selected packages and their permitted closure may be installed");
for (const name of packages) assert(realpathSync(join(directory, "node_modules", name)).startsWith(`${directory}/`));
const output = execFileSync(process.execPath, ["probe.mjs"], {
	cwd: directory, env, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024,
});
writeFileSync(join(directory, "probe.log"), output);
writeFileSync(join(directory, "manifest.json"), JSON.stringify({
	node: process.version, withCodex,
	packages: packages.map((name) => ({
		name, version: manifests.get(name).version, tarballIntegrity: artifacts.get(name).integrity,
		tarballSha256: createHash("sha256").update(readFileSync(artifacts.get(name).path)).digest("hex"),
	})),
	probeSha256: createHash("sha256").update(readFileSync(join(directory, "probe.mjs"))).digest("hex"),
}, null, 2));
console.log(output.trim());
