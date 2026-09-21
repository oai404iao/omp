import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPatch, previewApplyPatch } from "../src/patch/apply.js";
import { parseApplyPatch, parseApplyPatchProgress } from "../src/patch/parser.js";
import { executeApplyPatchTool } from "../src/tools/apply-patch.js";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-apply-patch-"));
}

test("apply_patch rechecks abort after acquiring the shared mutation queue", async () => {
	const cwd = tempDir();
	const target = join(cwd, "queued.txt");
	let release!: () => void;
	const held = withFileMutationQueue(target, () => new Promise<void>((resolve) => { release = resolve; }));
	await new Promise((resolve) => setImmediate(resolve));
	const controller = new AbortController();
	const task = executeApplyPatchTool({ input: "*** Begin Patch\n*** Add File: queued.txt\n+must-not-write\n*** End Patch" }, cwd, controller.signal);
	const rejected = assert.rejects(task, /aborted/i);
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	release();
	await held;
	await rejected;
	assert.equal(existsSync(target), false);
});

test("apply_patch rejects distinct aliases rather than losing one of their edits", { timeout: 5000 }, async () => {
	const cwd = tempDir();
	mkdirSync(join(cwd, "real"));
	symlinkSync(join(cwd, "real"), join(cwd, "alias"), "dir");
	writeFileSync(join(cwd, "real/file.txt"), "one\ntwo\n");
	await assert.rejects(executeApplyPatchTool({ input: `*** Begin Patch
*** Update File: real/file.txt
@@
-one
+ONE
*** Update File: alias/file.txt
@@
-two
+TWO
*** End Patch` }, cwd), /alias the same target/);
	assert.equal(readFileSync(join(cwd, "real/file.txt"), "utf8"), "one\ntwo\n");
	await assert.rejects(executeApplyPatchTool({ input: `*** Begin Patch
*** Update File: real/file.txt
*** Move to: alias/file.txt
@@
-one
+ONE
*** End Patch` }, cwd), /alias the same target/);
});

test("apply_patch rejects missing aliases before waiting on native creation", { timeout: 5000 }, async () => {
	const cwd = tempDir();
	mkdirSync(join(cwd, "a"));
	symlinkSync(join(cwd, "a"), join(cwd, "z"), "dir");
	let release!: () => void;
	let acquired!: () => void;
	const ready = new Promise<void>((resolve) => { acquired = resolve; });
	const target = join(cwd, "a/file.txt");
	const held = withFileMutationQueue(target, async () => {
		acquired();
		await new Promise<void>((resolve) => { release = resolve; });
		writeFileSync(target, "native\n");
	});
	await ready;
	try {
		await assert.rejects(executeApplyPatchTool({ input: `*** Begin Patch
*** Add File: a/file.txt
+first
*** Add File: z/file.txt
+second
*** End Patch` }, cwd), /alias the same target/);
		assert.equal(existsSync(target), false);
	} finally { release(); await held; }
	await withFileMutationQueue(target, async () => {});
	assert.equal(readFileSync(target, "utf8"), "native\n");
});

test("apply_patch permits repeated actions on the same lexical path", { timeout: 5000 }, async () => {
	const cwd = tempDir();
	await executeApplyPatchTool({ input: `*** Begin Patch
*** Add File: a.txt
+one
*** Update File: a.txt
@@
-one
+two
*** Update File: a.txt
*** Move to: b.txt
@@
-two
+three
*** Update File: b.txt
@@
-three
+four
*** End Patch` }, cwd);
	assert.equal(readFileSync(join(cwd, "b.txt"), "utf8"), "four\n");
	assert.equal(existsSync(join(cwd, "a.txt")), false);
});

test("apply_patch rejects target identity drift after a native queue wait and releases its locks", { timeout: 5000 }, async (t) => {
	const cwd = tempDir();
	mkdirSync(join(cwd, "z-real"));
	symlinkSync(join(cwd, "z-real"), join(cwd, "z-alias"), "dir");
	const first = join(cwd, "a.txt");
	const created = join(cwd, "z-real/file.txt");
	writeFileSync(first, "before\n");
	let release!: () => void;
	let acquired!: () => void;
	const ready = new Promise<void>((resolve) => { acquired = resolve; });
	const held = withFileMutationQueue(first, async () => {
		acquired();
		await new Promise<void>((resolve) => { release = resolve; });
	});
	await ready;
	const signal = new AbortController().signal;
	const checkAbort = signal.throwIfAborted.bind(signal);
	let captured!: () => void;
	const snapshotsReady = new Promise<void>((resolve) => { captured = resolve; });
	let checkpoints = 0;
	t.mock.method(signal, "throwIfAborted", () => {
		checkAbort();
		// The third checkpoint follows snapshot validation, just before the
		// first acquisition. Synchronize creation without a scheduler delay.
		if (++checkpoints === 3) captured();
	});
	const task = executeApplyPatchTool({ input: `*** Begin Patch
*** Update File: a.txt
@@
-before
+after
*** Update File: z-alias/file.txt
@@
-native
+patched
*** End Patch` }, cwd, signal);
	const rejected = assert.rejects(task, /identity changed/);
	try {
		await snapshotsReady;
		await withFileMutationQueue(created, async () => { writeFileSync(created, "native\n"); });
	} finally { release(); await held; }
	await rejected;
	await withFileMutationQueue(first, async () => {});
	assert.equal(readFileSync(first, "utf8"), "before\n");
	assert.equal(readFileSync(created, "utf8"), "native\n");
});

test("apply_patch refuses ambiguous dangling-link identities without effects", { timeout: 5000 }, async () => {
	const cwd = tempDir();
	symlinkSync(join(cwd, "missing"), join(cwd, "link"), "dir");
	await assert.rejects(executeApplyPatchTool({
		input: "*** Begin Patch\n*** Add File: link/file.txt\n+no\n*** End Patch",
	}, cwd), /Cannot resolve patch target identity/);
	assert.equal(existsSync(join(cwd, "missing/file.txt")), false);
});

test("overlapping patches order canonical locks consistently across reversed aliases", { timeout: 5000 }, async () => {
	const cwd = tempDir();
	for (const name of ["a", "z"]) {
		mkdirSync(join(cwd, name));
		writeFileSync(join(cwd, name, "file.txt"), "original\n");
	}
	symlinkSync(join(cwd, "z"), join(cwd, "b"), "dir");
	symlinkSync(join(cwd, "a"), join(cwd, "y"), "dir");
	const patch = (paths: string[], marker: string) => `*** Begin Patch\n${paths.map((path) =>
		`*** Update File: ${path}/file.txt\n@@\n+${marker}\n original`).join("\n")}\n*** End Patch`;
	await Promise.all([
		executeApplyPatchTool({ input: patch(["a", "z"], "first") }, cwd),
		executeApplyPatchTool({ input: patch(["b", "y"], "second") }, cwd),
	]);
	const a = readFileSync(join(cwd, "a/file.txt"), "utf8");
	assert.equal(readFileSync(join(cwd, "z/file.txt"), "utf8"), a);
	assert.match(a, /first/);
	assert.match(a, /second/);
});

test("apply_patch shares alias locks with native mutations and reads after acquisition", { timeout: 5000 }, async () => {
	const cwd = tempDir();
	mkdirSync(join(cwd, "real"));
	symlinkSync(join(cwd, "real"), join(cwd, "alias"), "dir");
	const target = join(cwd, "real/file.txt");
	writeFileSync(target, "before\n");
	let release!: () => void;
	let acquired!: () => void;
	const ready = new Promise<void>((resolve) => { acquired = resolve; });
	const held = withFileMutationQueue(target, async () => {
		acquired();
		await new Promise<void>((resolve) => { release = resolve; });
		writeFileSync(target, "native\n");
	});
	await ready;
	const task = executeApplyPatchTool({ input: "*** Begin Patch\n*** Update File: alias/file.txt\n@@\n-native\n+patched\n*** End Patch" }, cwd);
	release();
	await Promise.all([held, task]);
	assert.equal(readFileSync(target, "utf8"), "patched\n");
});

test("parseApplyPatch parses add/update/delete actions", () => {
	const parsed = parseApplyPatch(`*** Begin Patch
*** Add File: a.txt
+hello
*** Update File: b.txt
@@
-old
+new
*** Delete File: c.txt
*** End Patch`);
	assert.equal(parsed.actions.length, 3);
	assert.equal(parsed.actions[0]?.kind, "add");
	assert.equal(parsed.actions[1]?.kind, "update");
	assert.equal(parsed.actions[2]?.kind, "delete");
	assert.equal(parsed.actions[0]?.kind === "add" ? parsed.actions[0].content : undefined, "hello\n");
	assert.deepEqual(parsed.actions[1]?.kind === "update" ? parsed.actions[1].chunks : undefined, [{
		changeContext: undefined,
		oldLines: ["old"],
		newLines: ["new"],
		isEndOfFile: false,
	}]);
});

test("parseApplyPatch rejects content after end marker", () => {
	assert.throws(
		() => parseApplyPatch(`*** Begin Patch
*** Add File: a.txt
+hello
*** End Patch
trailing`),
		/The last line of the patch/,
	);
});

test("parseApplyPatch preserves Codex update contexts and end-of-file markers", () => {
	const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: src/app.ts
@@ class App
 old
-before
+after
@@ render()
+tail
*** End of File
*** End Patch`);
	assert.deepEqual(parsed.actions[0]?.kind === "update" ? parsed.actions[0].chunks : undefined, [
		{ changeContext: "class App", oldLines: ["old", "before"], newLines: ["old", "after"], isEndOfFile: false },
		{ changeContext: "render()", oldLines: [], newLines: ["tail"], isEndOfFile: true },
	]);
});

test("parseApplyPatch accepts an initial chunk without @@ and preserves bare empty context lines", () => {
	const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: a.txt
 before

 after
*** End Patch`);
	assert.deepEqual(parsed.actions[0]?.kind === "update" ? parsed.actions[0].chunks : undefined, [{
		changeContext: undefined,
		oldLines: ["before", "", "after"],
		newLines: ["before", "", "after"],
		isEndOfFile: false,
	}]);
});

test("parseApplyPatchProgress keeps completed lines and drops an incomplete trailing action", () => {
	const parsed = parseApplyPatchProgress(`*** Begin Patch
*** Add File: added.txt
+hello
*** Upd`);
	assert.deepEqual(parsed.actions, [{ kind: "add", path: "added.txt", content: "hello\n" }]);
});

test("parseApplyPatch enforces canonical Add, Delete, Move, and Update bodies", () => {
	assert.throws(() => parseApplyPatch(`*** Begin Patch
*** Add File: a.txt
plain
*** End Patch`), /Add File lines must start/);
	assert.throws(() => parseApplyPatch(`*** Begin Patch
*** Delete File: a.txt
-old
*** End Patch`), /not a valid file header/);
	assert.throws(() => parseApplyPatch(`*** Begin Patch
*** Update File: a.txt
*** Move to: b.txt
*** End Patch`), /Update file hunk.*empty/);
	assert.throws(() => parseApplyPatch(`*** Begin Patch
*** Update File: a.txt
@@
-old
+new
*** Move to: b.txt
*** End Patch`), /Expected update hunk/);
});

test("applyPatch adds, updates, deletes, and moves files", async () => {
	const cwd = tempDir();
	writeFileSync(join(cwd, "update.txt"), "alpha\nold\nomega");
	writeFileSync(join(cwd, "delete.txt"), "remove me");
	const result = await applyPatch(`*** Begin Patch
*** Add File: added.txt
+hello
+world
*** Update File: update.txt
@@
 alpha
-old
+new
 omega
*** Delete File: delete.txt
*** Update File: update.txt
*** Move to: moved.txt
@@
 alpha
-new
+newer
 omega
*** End Patch`, { cwd });
	assert.equal(readFileSync(join(cwd, "added.txt"), "utf8"), "hello\nworld\n");
	assert.equal(readFileSync(join(cwd, "moved.txt"), "utf8"), "alpha\nnewer\nomega\n");
	assert.equal(existsSync(join(cwd, "update.txt")), false);
	assert.equal(existsSync(join(cwd, "delete.txt")), false);
	assert.equal(result.files.length, 4);
	assert.equal(result.summary, "Success. Updated the following files:\nA added.txt\nM update.txt\nD delete.txt\nM moved.txt");
});

test("applyPatch accepts relative traversal and absolute paths outside cwd", async () => {
	const root = tempDir();
	const cwd = join(root, "workspace");
	mkdirSync(cwd);
	await applyPatch(`*** Begin Patch
*** Add File: ../relative-outside.txt
+relative
*** End Patch`, { cwd });
	assert.equal(readFileSync(join(root, "relative-outside.txt"), "utf8"), "relative\n");
	const absolutePath = join(root, "absolute-outside.txt");
	await applyPatch(`*** Begin Patch
*** Add File: ${absolutePath}
+ok
*** End Patch`, { cwd });
	assert.equal(readFileSync(absolutePath, "utf8"), "ok\n");
});

test("applyPatch validates all actions before changing files", async () => {
	const cwd = tempDir();
	await assert.rejects(
		() => applyPatch(`*** Begin Patch
*** Add File: ok.txt
+ok
*** Update File: missing.txt
@@
-old
+new
*** End Patch`, { cwd }),
		/Failed to read missing.txt/,
	);
	assert.equal(existsSync(join(cwd, "ok.txt")), false);
});

test("applyPatch rolls back committed files and mode bits after an I/O failure", {
	skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
	const cwd = tempDir();
	const executable = join(cwd, "script.sh");
	const locked = join(cwd, "locked");
	writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	mkdirSync(locked);
	chmodSync(locked, 0o555);
	try {
		await assert.rejects(
			() => applyPatch(`*** Begin Patch
*** Delete File: script.sh
*** Add File: locked/fail.txt
+cannot write
*** End Patch`, { cwd }),
			/Rolled back touched files/,
		);
	} finally {
		chmodSync(locked, 0o755);
	}
	assert.equal(readFileSync(executable, "utf8"), "#!/bin/sh\nexit 0\n");
	assert.equal(statSync(executable).mode & 0o777, 0o755);
	assert.equal(existsSync(join(locked, "fail.txt")), false);
});

test("applyPatch refuses to overwrite existing files with Add File", async () => {
	const cwd = tempDir();
	writeFileSync(join(cwd, "existing.txt"), "keep");
	await assert.rejects(
		() => applyPatch(`*** Begin Patch
*** Add File: existing.txt
+replace
*** End Patch`, { cwd }),
		/already exists/,
	);
	assert.equal(readFileSync(join(cwd, "existing.txt"), "utf8"), "keep");
});

test("applyPatch deletes files without a non-canonical Delete body", async () => {
	const cwd = tempDir();
	writeFileSync(join(cwd, "delete.txt"), "actual\n");
	await applyPatch(`*** Begin Patch
*** Delete File: delete.txt
*** End Patch`, { cwd });
	assert.equal(existsSync(join(cwd, "delete.txt")), false);
});

test("applyPatch refuses to overwrite existing files with Move to", async () => {
	const cwd = tempDir();
	writeFileSync(join(cwd, "source.txt"), "source");
	writeFileSync(join(cwd, "target.txt"), "target");
	await assert.rejects(
		() => applyPatch(`*** Begin Patch
*** Update File: source.txt
*** Move to: target.txt
@@
-source
+updated
*** End Patch`, { cwd }),
		/Move target already exists/,
	);
	assert.equal(readFileSync(join(cwd, "source.txt"), "utf8"), "source");
	assert.equal(readFileSync(join(cwd, "target.txt"), "utf8"), "target");
});

test("applyPatch follows Codex cursor semantics for repeated update context", async () => {
	const cwd = tempDir();
	writeFileSync(join(cwd, "ambiguous.txt"), "same\nsame\n");
	await applyPatch(`*** Begin Patch
*** Update File: ambiguous.txt
@@
-same
+different
*** End Patch`, { cwd });
	assert.equal(readFileSync(join(cwd, "ambiguous.txt"), "utf8"), "different\nsame\n");
});

test("applyPatch uses @@ context and ordered chunks to disambiguate repeated lines", async () => {
	const cwd = tempDir();
	writeFileSync(join(cwd, "ordered.txt"), "class First\nsame\nclass Second\nsame\nlast\n");
	await applyPatch(`*** Begin Patch
*** Update File: ordered.txt
@@ class First
-same
+first
@@ class Second
-same
+second
*** End Patch`, { cwd });
	assert.equal(readFileSync(join(cwd, "ordered.txt"), "utf8"), "class First\nfirst\nclass Second\nsecond\nlast\n");
});

test("applyPatch preflights consecutive Add, Update, Move, and Update actions on virtual state", async () => {
	const cwd = tempDir();
	const result = await applyPatch(`*** Begin Patch
*** Add File: chain.txt
+one
*** Update File: chain.txt
@@
-one
+two
*** Update File: chain.txt
*** Move to: moved.txt
@@
-two
+three
*** Update File: moved.txt
@@
-three
+four
*** End Patch`, { cwd });
	assert.equal(existsSync(join(cwd, "chain.txt")), false);
	assert.equal(readFileSync(join(cwd, "moved.txt"), "utf8"), "four\n");
	assert.equal(result.summary, "Success. Updated the following files:\nA chain.txt\nM chain.txt\nM moved.txt\nM moved.txt");
});

test("previewApplyPatch derives partial changes from the current filesystem without writing", async () => {
	const cwd = tempDir();
	writeFileSync(join(cwd, "existing.txt"), "before\n");
	const preview = await previewApplyPatch(`*** Begin Patch
*** Update File: existing.txt
@@
-before
+after
`, { cwd });
	assert.equal(preview.complete, false);
	assert.deepEqual(preview.files, [{
		kind: "update",
		path: "existing.txt",
		previousContent: "before\n",
		content: "after\n",
	}]);
	assert.equal(readFileSync(join(cwd, "existing.txt"), "utf8"), "before\n");
});

test("applyPatch supports End of File and fuzzy whitespace and punctuation matching", async () => {
	const cwd = tempDir();
	writeFileSync(join(cwd, "fuzzy.txt"), "title\n  value – ‘quoted’   \nlast\n");
	await applyPatch(`*** Begin Patch
*** Update File: fuzzy.txt
@@
-value - 'quoted'
+updated
@@
 last
+tail
*** End of File
*** End Patch`, { cwd });
	assert.equal(readFileSync(join(cwd, "fuzzy.txt"), "utf8"), "title\nupdated\nlast\ntail\n");
});

test("applyPatch preserves CRLF files when patch context uses LF", async () => {
	const cwd = tempDir();
	writeFileSync(join(cwd, "crlf.txt"), "alpha\r\nold\r\nomega\r\n");
	await applyPatch(`*** Begin Patch
*** Update File: crlf.txt
@@
 alpha
-old
+new
 omega
*** End Patch`, { cwd });
	assert.equal(readFileSync(join(cwd, "crlf.txt"), "utf8"), "alpha\r\nnew\r\nomega\r\n");
});

test("applyPatch accepts paths through a symbolic-link ancestor", async () => {
	const cwd = tempDir();
	const outside = tempDir();
	symlinkSync(outside, join(cwd, "link"), "dir");
	await applyPatch(`*** Begin Patch
*** Add File: link/escape.txt
+allowed
*** End Patch`, { cwd });
	assert.equal(readFileSync(join(outside, "escape.txt"), "utf8"), "allowed\n");
});

test("applyPatch refuses to mutate a final symbolic-link target", async () => {
	const cwd = tempDir();
	const outside = join(tempDir(), "outside.txt");
	writeFileSync(outside, "outside\n");
	symlinkSync(outside, join(cwd, "linked.txt"), "file");
	await assert.rejects(
		() => applyPatch(`*** Begin Patch
*** Update File: linked.txt
@@
-outside
+changed
*** End Patch`, { cwd }),
		/apply_patch verification failed: Patch target may not be a symbolic link/,
	);
	assert.equal(readFileSync(outside, "utf8"), "outside\n");
});

test("executeApplyPatchTool returns Codex summary text and verification errors", async () => {
	const cwd = tempDir();
	const result = await executeApplyPatchTool({ input: `*** Begin Patch
*** Add File: added.txt
+hello
*** End Patch` }, cwd);
	assert.equal(result.content[0]?.text, "Success. Updated the following files:\nA added.txt");
	await assert.rejects(
		() => executeApplyPatchTool({ input: "not a patch" }, cwd),
		/apply_patch verification failed: The first line of the patch/,
	);
});
