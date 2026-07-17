import { Box, Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { previewApplyPatch, type ApplyPatchPreviewFile } from "./apply.js";

const PREVIEW_INTERVAL_MS = 500;

type RenderPreview = { complete: boolean; files: ApplyPatchPreviewFile[] } | { error: string };

interface PreviewRequest {
	input: string;
	cwd: string;
	allowAbsolutePaths: boolean;
	complete: boolean;
	invalidate: () => void;
}

interface ApplyPatchRenderBox extends Box {
	preview?: RenderPreview;
	request?: PreviewRequest;
	requestKey?: string;
	previewPending: boolean;
	previewTimer?: ReturnType<typeof setTimeout>;
	lastPreviewStartedAt: number;
	executionStarted: boolean;
	settledFiles?: Array<{ kind: ApplyPatchPreviewFile["kind"]; path: string; moveTo?: string }>;
	settledError: boolean;
	settledSuccess: boolean;
}

async function computePreview(request: PreviewRequest): Promise<RenderPreview> {
	try {
		const preview = await previewApplyPatch(request.input, {
			cwd: request.cwd,
			allowAbsolutePaths: request.allowAbsolutePaths,
		}, request.complete);
		return {
			complete: preview.complete,
			files: preview.files,
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function createRenderBox(): ApplyPatchRenderBox {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		previewPending: false,
		lastPreviewStartedAt: 0,
		executionStarted: false,
		settledError: false,
		settledSuccess: false,
	});
}

function getRenderBox(state: Record<string, unknown>, lastComponent: Component | undefined): ApplyPatchRenderBox {
	if (lastComponent instanceof Box) {
		state.callComponent = lastComponent;
		return lastComponent as ApplyPatchRenderBox;
	}
	if (state.callComponent instanceof Box) return state.callComponent as ApplyPatchRenderBox;
	const component = createRenderBox();
	state.callComponent = component;
	return component;
}

function requestKey(request: Omit<PreviewRequest, "invalidate">): string {
	return `${request.complete ? "complete" : "partial"}\u0000${request.allowAbsolutePaths ? "absolute" : "workspace"}\u0000${request.cwd}\u0000${request.input}`;
}

function schedulePreview(component: ApplyPatchRenderBox, immediate = false): void {
	if (!component.request || component.previewPending) return;
	if (component.previewTimer) {
		if (!immediate) return;
		clearTimeout(component.previewTimer);
		component.previewTimer = undefined;
	}
	const delay = immediate ? 0 : Math.max(0, PREVIEW_INTERVAL_MS - (Date.now() - component.lastPreviewStartedAt));
	component.previewTimer = setTimeout(() => {
		component.previewTimer = undefined;
		const request = component.request;
		if (!request) return;
		const key = component.requestKey;
		component.previewPending = true;
		component.lastPreviewStartedAt = Date.now();
		void computePreview(request).then((preview) => {
			if (!component.executionStarted && component.requestKey === key) {
				component.preview = preview;
			}
		}).finally(() => {
			component.previewPending = false;
			request.invalidate();
			if (!component.executionStarted && component.requestKey !== key) schedulePreview(component, Boolean(component.request?.complete));
		});
	}, delay);
	component.previewTimer.unref?.();
}

function updatePreviewRequest(component: ApplyPatchRenderBox, request: PreviewRequest): void {
	const key = requestKey(request);
	if (component.requestKey === key) return;
	component.request = request;
	component.requestKey = key;
	schedulePreview(component, request.complete);
}

function contentLineCount(content: string): number {
	if (!content) return 0;
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines.length;
}

function operationLine(file: ApplyPatchPreviewFile, theme: any, expanded: boolean): string {
	const marker = file.kind === "add" ? "A" : file.kind === "delete" ? "D" : "M";
	const markerColor = file.kind === "delete" ? "error" : file.kind === "add" ? "success" : "accent";
	const path = file.moveTo ? `${file.path} → ${file.moveTo}` : file.path;
	const before = contentLineCount(file.previousContent);
	const after = contentLineCount(file.content);
	const size = file.kind === "add" ? `+${after} lines` : file.kind === "delete" ? `-${before} lines` : `${before}→${after} lines`;
	const detail = expanded && file.moveTo ? ` (${file.path} moved)` : "";
	return `${theme.fg(markerColor, marker)} ${theme.fg("accent", path)} ${theme.fg("dim", `${size}${detail}`)}`;
}

function settledOperationLine(file: { kind: ApplyPatchPreviewFile["kind"]; path: string; moveTo?: string }, theme: any): string {
	const marker = file.kind === "add" ? "A" : file.kind === "delete" ? "D" : "M";
	const markerColor = file.kind === "delete" ? "error" : file.kind === "add" ? "success" : "accent";
	const path = file.moveTo ? `${file.path} → ${file.moveTo}` : file.path;
	return `${theme.fg(markerColor, marker)} ${theme.fg("accent", path)}`;
}

function rebuildCall(component: ApplyPatchRenderBox, theme: any, expanded: boolean): ApplyPatchRenderBox {
	component.setBgFn(component.settledError
		? (text: string) => theme.bg("toolErrorBg", text)
		: component.settledSuccess
			? (text: string) => theme.bg("toolSuccessBg", text)
			: (text: string) => theme.bg("toolPendingBg", text));
	component.clear();
	const status = component.settledError
		? "failed"
		: component.settledSuccess
			? "applied"
			: component.executionStarted
				? "applying"
				: component.previewPending
					? "previewing"
					: component.preview && "complete" in component.preview && component.preview.complete ? "ready" : "streaming";
	component.addChild(new Text(`${theme.fg("toolTitle", theme.bold("apply_patch"))} ${theme.fg("dim", status)}`, 0, 0));
	if (component.settledFiles) {
		for (const file of component.settledFiles) component.addChild(new Text(settledOperationLine(file, theme), 0, 0));
		return component;
	}
	if (!component.preview) return component;
	if ("error" in component.preview) {
		component.addChild(new Spacer(1));
		component.addChild(new Text(theme.fg("error", component.preview.error), 0, 0));
		return component;
	}
	for (const file of component.preview.files) component.addChild(new Text(operationLine(file, theme, expanded), 0, 0));
	return component;
}

export function createApplyPatchRenderers(resolveAllowAbsolutePaths: (cwd: string) => boolean) {
	return {
		renderCall(args: { input?: string } | undefined, theme: any, context: any) {
			const component = getRenderBox(context.state, context.lastComponent);
			if (context.executionStarted && !component.executionStarted) {
				component.executionStarted = true;
				if (component.previewTimer) clearTimeout(component.previewTimer);
				component.previewTimer = undefined;
				component.request = undefined;
				component.requestKey = undefined;
			}
			const input = typeof args?.input === "string" ? args.input : "";
			if (input && !component.executionStarted) {
				updatePreviewRequest(component, {
					input,
					cwd: context.cwd,
					allowAbsolutePaths: resolveAllowAbsolutePaths(context.cwd),
					complete: Boolean(context.argsComplete),
					invalidate: context.invalidate,
				});
			}
			return rebuildCall(component, theme, Boolean(context.expanded));
		},
		renderResult(result: {
			content?: Array<{ type?: string; text?: string }>;
			details?: { files?: Array<{ kind?: string; path?: string; moveTo?: string }> };
		}, _options: unknown, theme: any, context: any) {
			const component = getRenderBox(context.state, context.state.callComponent);
			component.settledError = Boolean(context.isError);
			component.settledSuccess = !context.isError;
			if (!context.isError && Array.isArray(result.details?.files)) {
				component.settledFiles = result.details.files.flatMap((file) =>
					(file.kind === "add" || file.kind === "update" || file.kind === "delete") && typeof file.path === "string"
						? [{ kind: file.kind, path: file.path, ...(typeof file.moveTo === "string" ? { moveTo: file.moveTo } : {}) }]
						: []);
				component.preview = undefined;
			}
			rebuildCall(component, theme, Boolean(context.expanded));
			const message = result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
			if (context.isError) return message ? new Text(theme.fg("error", message), 0, 0) : new Container();
			return new Text(theme.fg("success", context.expanded && message ? message : "Applied"), 0, 0);
		},
	};
}