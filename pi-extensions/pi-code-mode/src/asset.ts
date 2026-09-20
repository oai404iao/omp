import { constants } from "node:fs";
import { open, mkdir, mkdtemp, chmod, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOST } from "./limits.ts";

export async function prepareHost(source: string): Promise<{ directory: string; binary: string }> {
	if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Code Mode S1 requires Linux x64 with user systemd/cgroup v2");
	const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let bytes: Buffer;
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size !== HOST.bytes) throw new Error(`Expected the pinned ${HOST.release} Host executable`);
		bytes = Buffer.alloc(HOST.bytes);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!bytesRead) throw new Error("Host executable changed during verification");
			offset += bytesRead;
		}
		if (createHash("sha256").update(bytes).digest("hex") !== HOST.sha256) throw new Error("Host SHA-256 mismatch; refusing execution");
	} finally { await handle.close(); }
	// Private, immutable-for-this-runtime snapshot; never execute the caller's
	// mutable source path after verification. Retained; no recursive deletion.
	const root = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "pi-code-mode");
	await mkdir(root, { recursive: true, mode: 0o700 });
	const directory = await mkdtemp(join(root, "runtime-"));
	await chmod(directory, 0o700);
	const binary = join(directory, "host");
	await writeFile(binary, bytes, { mode: 0o500, flag: "wx" });
	return { directory, binary };
}
