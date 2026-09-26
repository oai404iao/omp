import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { moduleReferences } from "../../scripts/check-codex-architecture.mjs";
import bundle from "@oai404iao/pi-codex-minimal-tools";
import * as bundleInline from "@oai404iao/pi-codex-minimal-tools/subagent-inline";
import * as runtimeInline from "@oai404iao/pi-codex-runtime/subagent-inline";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bundleDir = resolve(root, "pi-extensions/pi-codex-minimal-tools");

test("bundle preserves its public factory and exact runtime inline exports", () => {
	assert.equal(typeof bundle, "function");
	assert.deepEqual(Object.keys(bundleInline), Object.keys(runtimeInline));
	for (const key of Object.keys(runtimeInline)) assert.equal(bundleInline[key], runtimeInline[key]);
	const manifest = JSON.parse(readFileSync(resolve(bundleDir, "package.json"), "utf8"));
	assert.deepEqual(manifest.exports, { ".": "./index.ts", "./subagent-inline": "./subagent-inline.ts" });
	assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
});

test("bundle contains only composition entries and package maintenance files", () => {
	const entries = readdirSync(bundleDir).filter(name => name !== "node_modules").sort();
	assert.deepEqual(entries, [
		"AGENTS.md", "CHANGELOG.md", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md",
		"index.ts", "package.json", "subagent-inline.ts", "tsconfig.json",
	].sort());
});

function sources(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
	});
}

test("owner tests and shared fixtures cannot pull in sibling implementations", () => {
	const owners = ["runtime", "core", "web-search", "imagegen"];
	const packageOf = path => /\/pi-extensions\/(pi-codex-[^/]+)\//.exec(path)?.[1];
	for (const owner of owners) {
		const allowed = new Set(["pi-codex-runtime", `pi-codex-${owner}`]);
		const seen = new Set();
		const visit = (file, chain) => {
			if (seen.has(file)) return;
			seen.add(file);
			const packageName = packageOf(file);
			assert.ok(!packageName || allowed.has(packageName), `forbidden test dependency: ${[...chain, file].join(" -> ")}`);
			for (const specifier of moduleReferences(readFileSync(file, "utf8"), file)) {
				let target;
				if (specifier.startsWith(".")) {
					target = resolve(dirname(file), specifier.replace(/\.(?:m?js|tsx?)$/, ".ts"));
				} else if (specifier.startsWith("@oai404iao/pi-codex-")) {
					target = createRequire(file).resolve(specifier);
				}
				if (target?.endsWith(".ts") && existsSync(target)) visit(target, [...chain, file]);
			}
		};
		for (const file of sources(resolve(root, `pi-extensions/pi-codex-${owner}/tests`))) visit(file, []);
	}
});
