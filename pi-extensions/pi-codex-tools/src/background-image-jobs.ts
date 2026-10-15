import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { frameGlyphs, glyphs, treeGlyph } from "@oai404iao/pi-codex-runtime/internal/glyphs";

const STATUS_KEY = "codex-image-gen";
const PADDING = 1;

interface Job {
	id: string;
	startedAt: number;
	prompt: string;
	referenceCount: number;
	imageModel: string;
	controller: AbortController;
}

function padAnsi(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function panelFrame(lines: string[], width: number, theme: Theme): string[] {
	const safeWidth = Math.max(1, width);
	if (safeWidth < 8) return lines.map(line => truncateToWidth(line, safeWidth, ""));
	const inner = Math.max(1, width - 2);
	const contentWidth = Math.max(1, width - 2 - PADDING * 2);
	const border = (text: string) => theme.fg("borderAccent", text);
	const frame = frameGlyphs();
	return [
		`${border(frame.tl)}${border(frame.h.repeat(inner))}${border(frame.tr)}`,
		...lines.map(line => `${border(frame.v)}${" ".repeat(PADDING)}${padAnsi(line, contentWidth)}${" ".repeat(PADDING)}${border(frame.v)}`),
		`${border(frame.bl)}${border(frame.h.repeat(inner))}${border(frame.br)}`,
	].map(line => truncateToWidth(line, safeWidth, ""));
}

export function panelBranch(theme: Theme, branch: "├" | "└" | "│"): string {
	return theme.fg("muted", treeGlyph(branch));
}

function renderJobs(active: Map<string, Job>, theme: Theme, width: number): string[] {
	const jobs = [...active.values()].sort((a, b) => a.startedAt - b.startedAt);
	if (!jobs.length) return [];
	const elapsed = Math.max(0, Math.round((Date.now() - jobs[0]!.startedAt) / 1000));
	const imageModels = [...new Set(jobs.map(job => job.imageModel))];
	const modelText = imageModels.length === 1 ? imageModels[0] : `${imageModels.length} models`;
	const refs = jobs.reduce((total, job) => total + job.referenceCount, 0);
	const refText = refs > 0 ? ` · ${refs} ref${refs === 1 ? "" : "s"}` : "";
	const lines = [`${theme.fg("customMessageLabel", theme.bold("Image Generation"))} ${theme.fg("muted", `${jobs.length} running · ${modelText}${refText} · ${elapsed}s`)}`];
	const dot = theme.fg("dim", glyphs().dot);
	const shown = jobs.slice(0, 4);
	for (const [index, job] of shown.entries()) {
		const age = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
		const isLast = index === shown.length - 1 && jobs.length <= shown.length;
		const references = job.referenceCount > 0 ? `${dot}${theme.fg("dim", `${job.referenceCount} ref${job.referenceCount === 1 ? "" : "s"}`)}` : "";
		const promptWidth = Math.max(16, width - 36);
		lines.push(`${panelBranch(theme, isLast ? "└" : "├")}${theme.fg("accent", glyphs().bullet.trim())} ${theme.fg("accent", truncateToWidth(job.prompt, promptWidth, glyphs().ellipsis))}${dot}${theme.fg("muted", job.imageModel)}${references}${dot}${theme.fg("dim", `${age}s`)}`);
	}
	if (jobs.length > shown.length) lines.push(`${panelBranch(theme, "└")}${theme.fg("muted", `${glyphs().ellipsis} ${jobs.length - shown.length} more`)}`);
	return panelFrame(lines, width, theme);
}

export function createBackgroundImageJobs() {
	const jobs = new Map<string, Job>();
	let generation = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let statusContext: ExtensionContext | undefined;
	const stopTimer = () => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
	const update = (ctx: ExtensionContext) => {
		statusContext = ctx;
		ctx.ui?.setStatus(STATUS_KEY, jobs.size ? `image-gen ${jobs.size}` : undefined);
		ctx.ui?.setWidget(STATUS_KEY, jobs.size ? (_tui: unknown, theme: Theme): Component => ({
			invalidate() {},
			render: width => renderJobs(jobs, theme, width),
		}) : undefined, { placement: "aboveEditor" });
		if (!jobs.size) stopTimer();
		else if (timer === undefined) {
			timer = setInterval(() => { if (statusContext) update(statusContext); }, 1000);
			timer.unref?.();
		}
	};
	return {
		start(ctx: ExtensionContext, parsed: { prompt: string; imagePaths: string[] }, imageModel: string) {
			const epoch = generation;
			const job: Job = {
				id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
				startedAt: Date.now(), prompt: parsed.prompt, referenceCount: parsed.imagePaths.length,
				imageModel, controller: new AbortController(),
			};
			jobs.set(job.id, job);
			update(ctx);
			const isCurrent = () => epoch === generation && !job.controller.signal.aborted;
			return {
				signal: job.controller.signal,
				isCurrent,
				finish() {
					if (!isCurrent()) return;
					jobs.delete(job.id);
					update(ctx);
				},
			};
		},
		reset(ctx?: ExtensionContext) {
			generation++;
			for (const job of jobs.values()) job.controller.abort(new Error("Image generation session ended"));
			jobs.clear();
			stopTimer();
			const current = ctx ?? statusContext;
			statusContext = undefined;
			current?.ui?.setStatus(STATUS_KEY, undefined);
			current?.ui?.setWidget(STATUS_KEY, undefined);
		},
	};
}
