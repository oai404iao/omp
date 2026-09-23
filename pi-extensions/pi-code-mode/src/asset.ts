import { constants } from "node:fs";
import { open, mkdir, mkdtemp, chmod, lstat, link, unlink, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOST, errorText } from "./limits.ts";

export function verifyPlatform(): void {
	if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Code Mode requires Linux x64 with user systemd/cgroup v2");
	const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
	const glibc = report.header?.glibcVersionRuntime?.split(".").map(Number);
	const [major, minor] = HOST.glibcMinimum.split(".").map(Number);
	if (!glibc || !Number.isFinite(glibc[0]) || !Number.isFinite(glibc[1])
		|| glibc[0] < major || (glibc[0] === major && glibc[1] < minor)) throw new Error(`Patched Host requires GNU/glibc >= ${HOST.glibcMinimum} and OpenSSL 3; this is not the official musl build`);
}
async function verify(source: string, destination?: FileHandle): Promise<void> {
	const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size !== HOST.bytes) throw new Error(`Expected the pinned ${HOST.release} Host executable`);
		const bytes = Buffer.alloc(1024 * 1024);
		const hash = createHash("sha256");
		let offset = 0;
		while (offset < HOST.bytes) {
			const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, HOST.bytes - offset), offset);
			if (!bytesRead) throw new Error("Host executable changed during verification");
			hash.update(bytes.subarray(0, bytesRead));
			if (destination) {
				let written = 0;
				while (written < bytesRead) {
					const next = await destination.write(bytes, written, bytesRead - written, offset + written);
					if (!next.bytesWritten) throw new Error("Host snapshot write made no progress");
					written += next.bytesWritten;
				}
			}
			offset += bytesRead;
		}
		if ((await handle.stat()).size !== HOST.bytes || hash.digest("hex") !== HOST.sha256) throw new Error("Host SHA-256 mismatch; refusing execution");
	} finally { await handle.close(); }
}
export async function inspectHost(source: string): Promise<void> {
	verifyPlatform();
	await verify(source);
}
async function privateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
		throw new Error("Host state/cache directory must be private, owned and not a symlink");
	}
}
export async function prepareHost(source: string): Promise<{ directory: string; binary: string }> {
	verifyPlatform();
	await verify(source);
	const root = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "pi-code-mode");
	await privateDirectory(root);
	const cache = join(root, "hosts");
	await privateDirectory(cache);
	const binary = join(cache, `${HOST.sha256}.host`);
	const directory = await mkdtemp(join(root, "runtime-"));
	await chmod(directory, 0o700);
	try { await verify(binary); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cached Host verification failed at ${binary}: ${errorText(error)}; refusing to overwrite it`);
		const candidate = join(directory, "host-candidate");
		const file = await open(candidate, "wx", 0o500);
		try { await verify(source, file); await file.sync(); }
		finally { await file.close(); }
		// Publish complete verified bytes once. Concurrent creators never replace
		// an existing inode; every launch rechecks the winning cache file.
		try { await link(candidate, binary); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		finally { await unlink(candidate); }
		await verify(binary);
	}
	return { directory, binary };
}
