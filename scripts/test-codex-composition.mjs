import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../pi-extensions/pi-codex-core/package.json", import.meta.url));
const tests = readdirSync(new URL("../tests/codex/", import.meta.url))
	.filter(name => /\.test\.(?:ts|mjs)$/.test(name)).sort().map(name => `tests/codex/${name}`);
for (const args of [
	[resolve(dirname(require.resolve("typescript/package.json")), "bin/tsc"), "-p", "tests/codex/tsconfig.json", "--noEmit"],
	[require.resolve("tsx/cli"), "--test", ...tests],
]) {
	const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: process.env });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
