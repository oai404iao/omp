import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { actionSummary, parseApplyPatch, type ParsedPatch, type PatchAction, type PatchUpdateChunk } from "./parser.js";

export interface ApplyPatchOptions {
	cwd: string;
	allowAbsolutePaths?: boolean;
}

export interface AppliedPatchFile {
	kind: PatchAction["kind"];
	path: string;
	absolutePath: string;
	moveTo?: string;
	absoluteMoveTo?: string;
}

export interface ApplyPatchResult {
	files: AppliedPatchFile[];
	summary: string;
}

export function resolvePatchPath(pathValue: string, options: ApplyPatchOptions): string {
	const cleaned = pathValue.trim();
	const inputIsAbsolute = isAbsolute(cleaned);
	const absolute = inputIsAbsolute ? resolve(cleaned) : resolve(options.cwd, cleaned);
	const cwd = resolve(options.cwd);
	const rel = relative(cwd, absolute);
	const insideCwd = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	if (!insideCwd && !(options.allowAbsolutePaths && inputIsAbsolute)) throw new Error(`Patch path escapes cwd: ${pathValue}`);
	return absolute;
}

function isWithin(parent: string, candidate: string): boolean {
	const rel = relative(parent, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

function verificationError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return message.startsWith("apply_patch verification failed:") ? new Error(message) : new Error(`apply_patch verification failed: ${message}`);
}

async function validateResolvedPath(absolutePath: string, originalPath: string, options: ApplyPatchOptions, realCwd: string): Promise<void> {
	const lexicalCwd = resolve(options.cwd);
	if (!isWithin(lexicalCwd, absolutePath)) return;

	let candidate = absolutePath;
	while (true) {
		try {
			const info = await lstat(candidate);
			if (candidate === absolutePath && info.isSymbolicLink()) throw new Error(`Patch target may not be a symbolic link: ${originalPath}`);
			const canonical = await realpath(candidate);
			if (!isWithin(realCwd, canonical)) throw new Error(`Patch path escapes cwd through a symbolic link: ${originalPath}`);
			return;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Patch ")) throw error;
			if (errorCode(error) !== "ENOENT") throw error;
			const parent = dirname(candidate);
			if (parent === candidate) throw new Error(`Unable to resolve patch path: ${originalPath}`);
			candidate = parent;
		}
	}
}

function normalizeForMatch(value: string): string {
	return value.trim().replace(/[‐‑‒–—―−]/gu, "-")
		.replace(/[‘’‚‛]/gu, "'")
		.replace(/[“”„‟]/gu, "\"")
		.replace(/[            　]/gu, " ");
}

function sequenceMatches(lines: string[], pattern: string[], index: number, normalize: (value: string) => string): boolean {
	for (let offset = 0; offset < pattern.length; offset++) {
		if (normalize(lines[index + offset]!) !== normalize(pattern[offset]!)) return false;
	}
	return true;
}

export function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | undefined {
	if (pattern.length === 0) return start;
	if (pattern.length > lines.length) return undefined;
	const lastStart = lines.length - pattern.length;
	const searchStart = eof ? lastStart : start;
	if (searchStart > lastStart) return undefined;
	for (const normalize of [(value: string) => value, (value: string) => value.trimEnd(), (value: string) => value.trim(), normalizeForMatch]) {
		for (let index = searchStart; index <= lastStart; index++) {
			if (sequenceMatches(lines, pattern, index, normalize)) return index;
		}
	}
	return undefined;
}

interface Replacement {
	start: number;
	oldLength: number;
	newLines: string[];
}

function computeReplacements(originalLines: string[], path: string, chunks: PatchUpdateChunk[]): Replacement[] {
	const replacements: Replacement[] = [];
	let lineIndex = 0;
	for (const chunk of chunks) {
		if (chunk.changeContext !== undefined) {
			const contextIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
			if (contextIndex === undefined) throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`);
			lineIndex = contextIndex + 1;
		}

		if (chunk.oldLines.length === 0) {
			replacements.push({ start: originalLines.length, oldLength: 0, newLines: chunk.newLines });
			continue;
		}

		let pattern = chunk.oldLines;
		let newLines = chunk.newLines;
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		if (found === undefined && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newLines[newLines.length - 1] === "") newLines = newLines.slice(0, -1);
			found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}
		if (found === undefined) throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
		replacements.push({ start: found, oldLength: pattern.length, newLines });
		lineIndex = found + pattern.length;
	}
	return replacements.sort((a, b) => a.start - b.start);
}

function dominantLineEnding(content: string): "\n" | "\r\n" {
	const crlfCount = content.match(/\r\n/g)?.length ?? 0;
	const lfCount = content.match(/\n/g)?.length ?? 0;
	return crlfCount > lfCount / 2 ? "\r\n" : "\n";
}

export function deriveUpdatedContent(content: string, path: string, chunks: PatchUpdateChunk[]): string {
	const lineEnding = dominantLineEnding(content);
	const originalLines = content.replace(/\r\n/g, "\n").split("\n");
	if (originalLines[originalLines.length - 1] === "") originalLines.pop();
	const replacements = computeReplacements(originalLines, path, chunks);
	const updated = [...originalLines];
	for (const replacement of [...replacements].reverse()) {
		updated.splice(replacement.start, replacement.oldLength, ...replacement.newLines);
	}
	if (updated[updated.length - 1] !== "") updated.push("");
	return updated.join(lineEnding);
}

interface VirtualFile {
	exists: boolean;
	content?: string;
}

interface PlannedAction {
	action: PatchAction;
	absolutePath: string;
	absoluteMoveTo?: string;
	content?: string;
}

async function loadVirtualFile(path: string, files: Map<string, VirtualFile>): Promise<VirtualFile> {
	const cached = files.get(path);
	if (cached) return cached;
	try {
		const info = await lstat(path);
		const file = info.isDirectory() ? { exists: true } : { exists: true, content: await readFile(path, "utf8") };
		files.set(path, file);
		return file;
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
		const file = { exists: false };
		files.set(path, file);
		return file;
	}
}

async function planPatch(parsed: ParsedPatch, options: ApplyPatchOptions): Promise<PlannedAction[]> {
	const realCwd = await realpath(options.cwd);
	const virtualFiles = new Map<string, VirtualFile>();
	const plans: PlannedAction[] = [];
	for (const action of parsed.actions) {
		const absolutePath = resolvePatchPath(action.path, options);
		await validateResolvedPath(absolutePath, action.path, options, realCwd);
		const source = await loadVirtualFile(absolutePath, virtualFiles);

		if (action.kind === "add") {
			if (source.exists) throw new Error(`Add File target already exists: ${action.path}`);
			virtualFiles.set(absolutePath, { exists: true, content: action.content });
			plans.push({ action, absolutePath, content: action.content });
			continue;
		}

		if (!source.exists) throw new Error(`Failed to read ${action.path}: file does not exist`);
		if (source.content === undefined) throw new Error(`Patch target is not a file: ${action.path}`);
		if (action.kind === "delete") {
			virtualFiles.set(absolutePath, { exists: false });
			plans.push({ action, absolutePath });
			continue;
		}

		const content = deriveUpdatedContent(source.content, action.path, action.chunks);
		let absoluteMoveTo: string | undefined;
		if (action.moveTo) {
			absoluteMoveTo = resolvePatchPath(action.moveTo, options);
			await validateResolvedPath(absoluteMoveTo, action.moveTo, options, realCwd);
			if (absoluteMoveTo !== absolutePath) {
				const destination = await loadVirtualFile(absoluteMoveTo, virtualFiles);
				if (destination.exists) throw new Error(`Move target already exists: ${action.moveTo}`);
				virtualFiles.set(absolutePath, { exists: false });
			}
		}
		virtualFiles.set(absoluteMoveTo ?? absolutePath, { exists: true, content });
		plans.push({ action, absolutePath, ...(absoluteMoveTo ? { absoluteMoveTo } : {}), content });
	}
	return plans;
}

interface FileSnapshot {
	absolutePath: string;
	existed: boolean;
	data?: Buffer;
	mode?: number;
}

async function snapshotPath(absolutePath: string): Promise<FileSnapshot> {
	try {
		const [data, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
		return { absolutePath, existed: true, data, mode: metadata.mode };
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { absolutePath, existed: false };
		throw error;
	}
}

async function restoreSnapshots(snapshots: FileSnapshot[]): Promise<void> {
	for (const snapshot of [...snapshots].reverse()) {
		if (snapshot.existed) {
			await mkdir(dirname(snapshot.absolutePath), { recursive: true });
			await writeFile(snapshot.absolutePath, snapshot.data ?? Buffer.alloc(0));
			if (snapshot.mode !== undefined) await chmod(snapshot.absolutePath, snapshot.mode);
		} else {
			await rm(snapshot.absolutePath, { force: true });
		}
	}
}

async function commitPlan(plan: PlannedAction): Promise<void> {
	if (plan.action.kind === "add") {
		await mkdir(dirname(plan.absolutePath), { recursive: true });
		await writeFile(plan.absolutePath, plan.content ?? "", { encoding: "utf8", flag: "wx" });
	} else if (plan.action.kind === "delete") {
		await rm(plan.absolutePath, { force: false });
	} else if (plan.absoluteMoveTo && plan.absoluteMoveTo !== plan.absolutePath) {
		await writeFile(plan.absolutePath, plan.content ?? "", "utf8");
		await mkdir(dirname(plan.absoluteMoveTo), { recursive: true });
		await rename(plan.absolutePath, plan.absoluteMoveTo);
	} else {
		await writeFile(plan.absolutePath, plan.content ?? "", "utf8");
	}
}

function appliedFile(plan: PlannedAction): AppliedPatchFile {
	const { action } = plan;
	return {
		kind: action.kind,
		path: action.path,
		absolutePath: plan.absolutePath,
		...(action.kind === "update" && action.moveTo ? { moveTo: action.moveTo, absoluteMoveTo: plan.absoluteMoveTo } : {}),
	};
}

export async function applyParsedPatch(parsed: ParsedPatch, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
	let plans: PlannedAction[];
	try {
		plans = await planPatch(parsed, options);
	} catch (error) {
		throw verificationError(error);
	}
	const snapshots = new Map<string, FileSnapshot>();
	for (const plan of plans) {
		for (const path of [plan.absolutePath, plan.absoluteMoveTo].filter((value): value is string => Boolean(value))) {
			if (!snapshots.has(path)) snapshots.set(path, await snapshotPath(path));
		}
	}

	const files: AppliedPatchFile[] = [];
	try {
		for (const plan of plans) {
			await commitPlan(plan);
			files.push(appliedFile(plan));
		}
	} catch (error) {
		const applied = files.map((file) => `${file.kind} ${file.path}`).join(", ") || "none";
		const message = error instanceof Error ? error.message : String(error);
		await restoreSnapshots([...snapshots.values()]);
		throw new Error(`${message}\nPartial apply status: completed actions before failure: ${applied}. Rolled back touched files; review the working tree before retrying.`);
	}

	return {
		files,
		summary: `Success. Updated the following files:\n${parsed.actions.map(actionSummary).join("\n")}`,
	};
}

export async function applyPatch(input: string, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
	let parsed: ParsedPatch;
	try {
		parsed = parseApplyPatch(input);
	} catch (error) {
		throw verificationError(error);
	}
	return applyParsedPatch(parsed, options);
}
