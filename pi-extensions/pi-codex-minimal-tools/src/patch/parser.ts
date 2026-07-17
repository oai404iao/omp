export type PatchActionKind = "add" | "update" | "delete";

export interface PatchUpdateChunk {
	changeContext?: string;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
}

export interface PatchAddAction {
	kind: "add";
	path: string;
	content: string;
}

export interface PatchUpdateAction {
	kind: "update";
	path: string;
	moveTo?: string;
	chunks: PatchUpdateChunk[];
}

export interface PatchDeleteAction {
	kind: "delete";
	path: string;
}

export type PatchAction = PatchAddAction | PatchUpdateAction | PatchDeleteAction;

export interface ParsedPatch {
	actions: PatchAction[];
}

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const UPDATE_FILE = "*** Update File: ";
const DELETE_FILE = "*** Delete File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";

function patchLines(input: string): string[] {
	return input.trim().split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

function parseHeader(line: string): { kind: PatchActionKind; path: string } | undefined {
	for (const [marker, kind] of [[ADD_FILE, "add"], [UPDATE_FILE, "update"], [DELETE_FILE, "delete"]] as const) {
		if (!line.startsWith(marker)) continue;
		const path = line.slice(marker.length).trim();
		if (!path) throw new Error("Patch file header is missing a path.");
		return { kind, path };
	}
	return undefined;
}

function isBoundary(line: string): boolean {
	const trimmed = line.trim();
	return trimmed === END_PATCH || parseHeader(trimmed) !== undefined;
}

function invalidHunk(lineNumber: number, message: string): Error {
	return new Error(`Invalid patch hunk on line ${lineNumber}: ${message}`);
}

function parseAdd(lines: string[], start: number, path: string): { action: PatchAddAction; next: number } {
	let index = start;
	let content = "";
	while (index < lines.length && !isBoundary(lines[index]!)) {
		const line = lines[index]!;
		if (!line.startsWith("+")) {
			throw invalidHunk(index + 1, `Add File lines must start with '+': ${path}`);
		}
		content += `${line.slice(1)}\n`;
		index++;
	}
	if (!content) throw invalidHunk(start, `Add file hunk for path '${path}' is empty`);
	return { action: { kind: "add", path, content }, next: index };
}

function newChunk(changeContext?: string): PatchUpdateChunk {
	return { changeContext, oldLines: [], newLines: [], isEndOfFile: false };
}

function chunkIsEmpty(chunk: PatchUpdateChunk): boolean {
	return chunk.oldLines.length === 0 && chunk.newLines.length === 0;
}

function parseUpdate(lines: string[], start: number, path: string): { action: PatchUpdateAction; next: number } {
	let index = start;
	let moveTo: string | undefined;
	const moveLine = lines[index]?.trimEnd();
	if (moveLine?.startsWith(MOVE_TO)) {
		moveTo = moveLine.slice(MOVE_TO.length).trim();
		if (!moveTo) throw invalidHunk(index + 1, `Move target is empty for ${path}`);
		index++;
	}

	const chunks: PatchUpdateChunk[] = [];
	let current: PatchUpdateChunk | undefined;
	while (index < lines.length) {
		const line = lines[index]!;
		const updateLine = line.trimEnd();
		if (updateLine === END_PATCH || parseHeader(updateLine)) break;

		if (current?.isEndOfFile) {
			if (updateLine === "") {
				index++;
				continue;
			}
			if (updateLine !== "@@" && !updateLine.startsWith("@@ ")) {
				throw invalidHunk(index + 1, `Expected update hunk to start with a @@ context marker, got: '${line}'`);
			}
		}

		if (updateLine === "@@" || updateLine.startsWith("@@ ")) {
			if (current && chunkIsEmpty(current)) {
				throw invalidHunk(index + 1, `Unexpected line found in update hunk: '${line}'. Every line should start with ' ', '+', or '-'`);
			}
			current = newChunk(updateLine === "@@" ? undefined : updateLine.slice(3));
			chunks.push(current);
			index++;
			continue;
		}

		if (updateLine === END_OF_FILE) {
			if (!current || chunkIsEmpty(current)) throw invalidHunk(index + 1, "Update hunk does not contain any lines");
			current.isEndOfFile = true;
			index++;
			continue;
		}

		if (line === "" || line.startsWith(" ") || line.startsWith("+") || line.startsWith("-")) {
			if (!current) {
				current = newChunk();
				chunks.push(current);
			}
			const text = line === "" ? "" : line.slice(1);
			if (line === "" || line.startsWith(" ") || line.startsWith("-")) current.oldLines.push(text);
			if (line === "" || line.startsWith(" ") || line.startsWith("+")) current.newLines.push(text);
			index++;
			continue;
		}

		throw invalidHunk(index + 1, `Expected update hunk to start with a @@ context marker, got: '${line}'`);
	}

	if (chunks.length === 0) throw invalidHunk(start, `Update file hunk for path '${path}' is empty`);
	if (chunkIsEmpty(chunks[chunks.length - 1]!)) throw invalidHunk(index + 1, "Update hunk does not contain any lines");
	return { action: { kind: "update", path, ...(moveTo ? { moveTo } : {}), chunks }, next: index };
}

export function parseApplyPatch(input: string): ParsedPatch {
	if (typeof input !== "string" || input.trim().length === 0) throw new Error("apply_patch input must be a non-empty string.");
	const lines = patchLines(input);
	if (lines[0]?.trim() !== BEGIN_PATCH) throw new Error("The first line of the patch must be '*** Begin Patch'.");
	if (lines[lines.length - 1]?.trim() !== END_PATCH) throw new Error("The last line of the patch must be '*** End Patch'.");

	const actions: PatchAction[] = [];
	let index = 1;
	while (index < lines.length - 1) {
		const line = lines[index]!.trim();
		if (line === END_PATCH) {
			for (let trailing = index + 1; trailing < lines.length; trailing++) {
				if (lines[trailing]!.trim() !== "") throw new Error(`Unexpected content after '*** End Patch' at line ${trailing + 1}.`);
			}
			break;
		}
		const header = parseHeader(line);
		if (!header) throw invalidHunk(index + 1, `'${line}' is not a valid file header`);
		index++;
		if (header.kind === "add") {
			const parsed = parseAdd(lines, index, header.path);
			actions.push(parsed.action);
			index = parsed.next;
		} else if (header.kind === "update") {
			const parsed = parseUpdate(lines, index, header.path);
			actions.push(parsed.action);
			index = parsed.next;
		} else {
			actions.push({ kind: "delete", path: header.path });
		}
	}
	if (index !== lines.length - 1) throw new Error("The last line of the patch must be '*** End Patch'.");
	if (actions.length === 0) throw new Error("No files were modified.");
	return { actions };
}

/**
 * Best-effort parser for model arguments that are still streaming. Only
 * newline-terminated input is considered, and incomplete trailing actions are
 * removed until the remaining prefix forms a valid patch. Final execution
 * always uses parseApplyPatch() instead.
 */
export function parseApplyPatchProgress(input: string): ParsedPatch {
	if (typeof input !== "string" || !input.includes("\n")) return { actions: [] };
	const normalized = input.replace(/\r\n/g, "\n");
	const completePrefix = normalized.slice(0, normalized.lastIndexOf("\n") + 1);
	const lines = completePrefix.split("\n");
	while (lines[lines.length - 1] === "") lines.pop();
	if (lines[0]?.trim() !== BEGIN_PATCH) return { actions: [] };

	const minimum = Math.max(1, lines.length - 64);
	for (let end = lines.length; end >= minimum; end--) {
		const candidate = `${lines.slice(0, end).join("\n")}\n${END_PATCH}`;
		try {
			return parseApplyPatch(candidate);
		} catch {
			// The current line/action may be incomplete; try the previous line.
		}
	}
	return { actions: [] };
}

export function actionSummary(action: PatchAction): string {
	const path = action.kind === "update" && action.moveTo ? action.moveTo : action.path;
	const marker = action.kind === "add" ? "A" : action.kind === "delete" ? "D" : "M";
	return `${marker} ${path}`;
}
