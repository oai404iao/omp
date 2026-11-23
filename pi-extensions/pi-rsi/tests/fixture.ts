import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export function sandbox(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "pi-rsi-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const env = { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, "xdg"), PI_CODING_AGENT_DIR: join(root, "agent") };
	for (const [key, value] of Object.entries(env)) {
		const original = process.env[key];
		process.env[key] = value;
		t.after(() => {
			if (original === undefined) delete process.env[key];
			else process.env[key] = original;
		});
	}
	return root;
}
