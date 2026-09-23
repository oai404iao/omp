import { constants } from "node:fs";
import { open, opendir, realpath, lstat, rename, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, join } from "node:path";
import { randomUUID } from "node:crypto";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { LIMITS } from "./limits.ts";

export const readSchema = Type.Object({
	path: Type.String({ maxLength: 4096 }),
	offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.readBytes })),
}, { additionalProperties: false });
export const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ maxLength: 4096 })),
}, { additionalProperties: false });
export const writeSchema = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 4096 }),
	content: Type.String({ maxLength: LIMITS.writeBytes }),
}, { additionalProperties: false });

export const definitions = [
	{ name: "read", description: "Read a regular UTF-8 file inside the authorized local root. offset is a zero-based BYTE offset; limit is bytes, at most 32768. Returns {text,nextOffset,truncated}. Symlinks are refused.", schema: readSchema },
	{ name: "ls", description: "List at most 200 local directory entries inside the authorized root; path defaults to '.'. Returns {entries:[{name,type}],truncated}. Does not follow symlinks.", schema: lsSchema },
];

/** Directory identity only. Read/write authorization belongs to the catalog;
 * this is NOT an adapter for Pi's current read/SSH/guard tool. */
export class ReadRoot {
	private closed = false;
	private constructor(readonly path: string, private root: FileHandle) {}

	static async grant(path: string): Promise<ReadRoot> {
		if (process.platform !== "linux") throw new Error("Code Mode S1 requires Linux");
		const canonical = await realpath(path);
		const handle = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		return new ReadRoot(canonical, handle);
	}

	/** /proc/self/fd anchors traversal to open directories, avoiding pathname
	 * symlink races. Every untrusted component is opened O_NOFOLLOW. */
	private async parentFor(path: string): Promise<{ parent: FileHandle; leaf: string }> {
		if (this.closed) throw new Error("Read authorization was revoked");
		if (path.includes("\0")) throw new Error("NUL in path");
		const local = relative(this.path, resolve(this.path, path));
		if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error("Path is outside the authorized read root");
		const parts = local.split(sep).filter(Boolean);
		let parent = await open(`/proc/self/fd/${this.root.fd}/.`, constants.O_RDONLY | constants.O_DIRECTORY);
		try {
			for (const part of parts.slice(0, -1)) {
				const next = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
				await parent.close();
				parent = next;
			}
			return { parent, leaf: parts.at(-1) ?? "." };
		} catch (error) { await parent.close(); throw error; }
	}
	private async target(path: string, directory: boolean): Promise<FileHandle> {
		const { parent, leaf } = await this.parentFor(path);
		try {
			const handle = await open(`/proc/self/fd/${parent.fd}/${leaf}`,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0));
			try {
				const stat = await handle.stat();
				if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error("Only regular files and directories are permitted");
				return handle;
			} catch (error) { await handle.close(); throw error; }
		} finally { await parent.close(); }
	}

	get processCwd(): string {
		if (this.closed) throw new Error("Root authorization revoked");
		return `/proc/${process.pid}/fd/${this.root.fd}`;
	}

	async write(args: unknown, signal: AbortSignal): Promise<unknown> {
		if (!Check(writeSchema, args)) throw new Error("Invalid write arguments");
		const { path, content } = args as { path: string; content: string };
		if (Buffer.byteLength(content) > LIMITS.writeBytes) throw new Error("Write byte budget exceeded");
		signal.throwIfAborted();
		const { parent, leaf } = await this.parentFor(path);
		const directory = `/proc/self/fd/${parent.fd}`;
		const target = `${directory}/${leaf}`;
		try {
			const key = join(await realpath(directory), leaf);
			return await withFileMutationQueue(key, async () => {
				signal.throwIfAborted();
				const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return undefined;
					throw error;
				});
				if (existing && !existing.isFile()) throw new Error("Write target must be a regular file, not a symlink or special file");
				const temporary = `${directory}/.pi-code-mode-${randomUUID()}`;
				let committed = false;
				const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, existing ? existing.mode & 0o777 : 0o600);
				try {
					await file.writeFile(content, "utf8");
					await file.sync();
					signal.throwIfAborted();
					await rename(temporary, target); // atomic replacement; never follows target links
					committed = true;
					return { path, bytesWritten: Buffer.byteLength(content), committed: true };
				} finally {
					await file.close();
					if (!committed) await unlink(temporary);
				}
			});
		} finally { await parent.close(); }
	}

	async invoke(name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
		signal.throwIfAborted();
		if (this.closed) throw new Error("Read authorization was revoked");
		if (name === "read" && Check(readSchema, args)) {
			const input = args as { path: string; offset?: number; limit?: number };
			const file = await this.target(input.path, false);
			try {
				signal.throwIfAborted();
				const buffer = Buffer.alloc(input.limit ?? LIMITS.readBytes);
				const offset = input.offset ?? 0;
				const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
				const stat = await file.stat();
				signal.throwIfAborted();
				return { text: buffer.subarray(0, bytesRead).toString("utf8"), nextOffset: offset + bytesRead, truncated: offset + bytesRead < stat.size };
			} finally { await file.close(); }
		}
		if (name === "ls" && Check(lsSchema, args)) {
			const file = await this.target((args as { path?: string }).path ?? ".", true);
			try {
				const entries: { name: string; type: string }[] = [];
				let truncated = false;
				const directory = await opendir(`/proc/self/fd/${file.fd}`);
				for await (const item of directory) {
					signal.throwIfAborted();
					if (entries.length === LIMITS.entries) { truncated = true; break; }
					entries.push({ name: item.name, type: item.isFile() ? "file" : item.isDirectory() ? "directory" : item.isSymbolicLink() ? "symlink" : "special" });
				}
				return { entries: entries.sort((a, b) => a.name.localeCompare(b.name)), truncated };
			} finally { await file.close(); }
		}
		throw new Error("Unknown or invalid authorized tool arguments");
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.root.close();
	}
}
