import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	AssistantMessageComponent, BashExecutionComponent, BranchSummaryMessageComponent, CompactionSummaryMessageComponent,
	CustomMessageComponent, getMarkdownTheme, ToolExecutionComponent, UserMessageComponent, type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import type { TranscriptEntry, TranscriptSnapshot, TranscriptPresentation } from "./dashboard-types.ts";
import { dashboardText, fit } from "./dashboard-view.ts";
import { transcriptIdentifier, transcriptText } from "./transcript-text.ts";
import { builtinToolRenderers, disposeTranscriptComponent, readOnlyToolRenderers } from "./transcript-renderers.ts";

const MAX_ENTRIES = 600;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 8192;

interface Page { snapshot: TranscriptSnapshot; latest: boolean }
interface CachedEntry { signature: string; component: Component; entry: TranscriptEntry; width?: number; lines?: string[] }

/** Sanitize a display copy; never alter a persisted message or replay signature. */
function clean(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return transcriptText(value);
	if (depth > 8) return "[omitted]";
	if (Array.isArray(value)) return value.map(item => clean(item, depth + 1));
	if (value && typeof value === "object") return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, clean(item, depth + 1)]));
	return value;
}

function displayEntry(entry: TranscriptEntry): TranscriptEntry {
	const copy = clean({ ...entry, message: undefined }) as TranscriptEntry;
	// Identity is opaque, not display text: stripping ANSI can merge unrelated tool calls.
	copy.id = transcriptIdentifier(entry.id);
	copy.toolCallId = entry.toolCallId === undefined ? undefined : transcriptIdentifier(entry.toolCallId);
	copy.parentToolCallId = entry.parentToolCallId === undefined ? undefined : transcriptIdentifier(entry.parentToolCallId);
	if (entry.message) copy.message = displayMessage(entry.message);
	else if (entry.text && entry.text.length > MAX_TEXT) {
		copy.text = dashboardText(entry.text.slice(0, MAX_TEXT), true);
		copy.truncated = true;
	}
	return copy;
}

/** Preserve structured metadata; only visible strings/blocks are transformed. */
function displayMessage(message: AgentMessage): AgentMessage {
	if (message.role === "assistant") return {
		...message, errorMessage: message.errorMessage ? transcriptText(message.errorMessage) : undefined,
		content: message.content.filter(block => block.type !== "thinking").map(block => block.type === "text" ?
			{ ...block, text: transcriptText(block.text) } : {
				...block, id: transcriptIdentifier(block.id), name: dashboardText(block.name), arguments: clean(block.arguments) as typeof block.arguments,
			}),
	};
	if (message.role === "user" || message.role === "custom") return {
		...message, ...(message.role === "custom" ? { customType: transcriptText(message.customType) } : {}),
		content: typeof message.content === "string" ? transcriptText(message.content) :
			message.content.filter(block => block.type === "text").map(block => ({ ...block, text: transcriptText(block.text) })),
	};
	if (message.role === "bashExecution") return {
		...message, command: transcriptText(message.command), output: transcriptText(message.output),
		fullOutputPath: message.fullOutputPath ? dashboardText(message.fullOutputPath) : undefined,
	};
	if (message.role === "compactionSummary" || message.role === "branchSummary") return {
		...message, summary: transcriptText(message.summary),
	};
	return message;
}

function isExpandable(entry: TranscriptEntry): boolean {
	if (entry.kind === "tool") return true;
	return ["custom", "bashExecution", "compactionSummary", "branchSummary"].includes(entry.message?.role ?? "");
}

function messageFor(entry: TranscriptEntry): AgentMessage | undefined {
	if (entry.message) return entry.message;
	if (entry.kind === "assistant") return assistant(entry);
	if (entry.kind === "user") return { role: "user", content: entry.text ?? "", timestamp: entry.timestamp };
	return undefined;
}

function expand(component: Component, value: boolean): void {
	if ("setExpanded" in component && typeof component.setExpanded === "function") component.setExpanded(value);
}

function compatible(cached: CachedEntry, entry: TranscriptEntry): boolean {
	if (cached.component instanceof ToolExecutionComponent) {
		return entry.kind === "tool" && entry.message?.role !== "bashExecution" &&
			cached.entry.toolName === entry.toolName && !(cached.entry.result && !entry.result) &&
			(cached.entry.toolCallId ?? cached.entry.id) === (entry.toolCallId ?? entry.id) &&
			!(cached.entry.argsComplete !== false && entry.argsComplete === false);
	}
	return cached.component instanceof AssistantMessageComponent && messageFor(entry)?.role === "assistant";
}

function assistant(entry: TranscriptEntry): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text: entry.text ?? "" }],
		api: "openai-responses", provider: "display", model: "display", timestamp: entry.timestamp,
		stopReason: entry.streaming ? "pending" : "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

/** One read-only screen, mounted inside the dashboard's existing custom() interaction. */
export class TranscriptView {
	private pages: Page[] = [];
	private entries: TranscriptEntry[] = [];
	private cache = new Map<string, CachedEntry>();
	private snapshot?: TranscriptSnapshot;
	private following = true;
	private expanded = false;
	private overrides = new Map<string, boolean>();
	private scrollTop = 0;
	private height = 0;
	private positions: { id: string; start: number; end: number }[] = [];
	private lines: string[] = [];
	private anchor?: { id: string; offset: number };
	private clipped = false;
	private disposed = false;
	private rendering = false;
	private presentation?: TranscriptPresentation;
	private presentationKey = "";

	constructor(private readonly tui: Pick<TUI, "requestRender">, private readonly theme: () => Theme) {}

	get isFollowing(): boolean { return this.following; }
	get before(): string | undefined { return this.pages[0]?.snapshot.before; }
	get path(): string | undefined { return this.snapshot?.path; }
	get status(): TranscriptSnapshot["status"] | undefined { return this.snapshot?.status; }
	get closed(): boolean { return this.snapshot?.closed ?? false; }

	update(snapshot: TranscriptSnapshot, previous = false): void {
		if (this.disposed) return;
		const key = JSON.stringify([snapshot.presentation?.revision, snapshot.presentation?.cwd, snapshot.presentation?.outputPad]);
		if (key !== this.presentationKey) { this.clearCache(); this.presentationKey = key; }
		this.presentation = snapshot.presentation;
		if (snapshot.error || snapshot.closed) {
			// Invalidated visibility is authoritative, including any previously paged history.
			this.pages = [];
			this.entries = [];
			this.clearCache();
			this.overrides.clear();
			this.lines = [];
			this.positions = [];
			this.scrollTop = 0;
			this.anchor = undefined;
			this.clipped = false;
			this.snapshot = { ...snapshot, entries: [], before: undefined };
			return;
		}
		const page = { ...snapshot, entries: snapshot.entries.map(displayEntry) };
		let pageBytes = 0;
		const ordered = previous ? page.entries : [...page.entries].reverse();
		const kept = ordered.filter((entry, index) => {
			pageBytes += JSON.stringify(entry).length * 2;
			return pageBytes <= MAX_BYTES && index < MAX_ENTRIES;
		});
		if (kept.length < page.entries.length) {
			this.clipped = true;
			page.entries = previous ? kept : kept.reverse();
			if (!previous && page.entries.length) page.before = page.entries[0].id;
		}
		this.snapshot = { ...page, entries: [] };
		if (previous) {
			this.pages.unshift({ snapshot: page, latest: false });
		} else {
			const latest = this.pages.find(item => item.latest);
			if (latest) {
				if (!this.following) {
					const currentIds = new Set(page.entries.map(entry => entry.id));
					const retired = latest.snapshot.entries.filter(entry =>
						!currentIds.has(entry.id) && !entry.id.startsWith("live:") && !entry.streaming && entry.status !== "running");
					if (retired.length) {
						// A rolling source window must not remove the row the user is reading.
						// Retain the old page cursor so p still loads before the oldest visible history.
						this.pages.splice(this.pages.indexOf(latest), 0, {
							snapshot: { ...latest.snapshot, entries: retired }, latest: false,
						});
					}
				}
				latest.snapshot = page;
			}
			else if (!this.pages.length) this.pages.push({ snapshot: page, latest: true });
			else {
				// The newest page was evicted while browsing old history. Only update known records.
				const updates = new Map(page.entries.map(entry => [entry.id, entry]));
				for (const item of this.pages) item.snapshot.entries = item.snapshot.entries.map(entry => updates.get(entry.id) ?? entry);
			}
		}
		const size = () => this.pages.reduce((sum, item) => sum + JSON.stringify(item.snapshot.entries).length * 2, 0);
		const count = () => this.pages.reduce((sum, item) => sum + item.snapshot.entries.length, 0);
		while (this.pages.length > 1 && (size() > MAX_BYTES || count() > MAX_ENTRIES)) {
			if (previous) this.pages.pop();
			else this.pages.shift();
			this.clipped = true;
		}
		const merged = new Map<string, TranscriptEntry>();
		for (const item of this.pages) for (const entry of item.snapshot.entries) merged.set(entry.id, entry);
		this.entries = [...merged.values()];
		// A single unusually large source page is still bounded, with loss disclosed.
		let bytes = 0;
		this.entries = this.entries.filter(entry => {
			bytes += JSON.stringify(entry).length * 2;
			if (bytes <= MAX_BYTES) return true;
			this.clipped = true;
			return false;
		}).slice(0, MAX_ENTRIES);
		const retained = new Set(this.entries.map(entry => entry.id));
		for (const [id, cached] of this.cache) if (!retained.has(id)) {
			disposeTranscriptComponent(cached.component);
			this.cache.delete(id);
		}
		for (const id of this.overrides.keys()) if (!retained.has(id)) this.overrides.delete(id);
	}

	/** End starts a fresh latest window; old pages remain available through p. */
	resume(snapshot: TranscriptSnapshot): void {
		this.pages = [];
		this.clipped = false;
		this.anchor = undefined;
		this.following = true;
		this.update(snapshot);
	}

	scrollBy(delta: number): void {
		this.following = false;
		this.scrollTop = Math.max(0, Math.min(Math.max(0, this.lines.length - this.height), this.scrollTop + delta));
		this.captureAnchor();
	}
	scrollToStart(): void { this.following = false; this.scrollTop = 0; this.anchor = undefined; }
	toggleTools(): void { this.expanded = !this.expanded; this.overrides.clear(); }
	toggleAt(row: number): boolean {
		const position = this.positions.find(item => item.start <= row + this.scrollTop && item.end > row + this.scrollTop);
		const entry = this.entries.find(item => item.id === position?.id);
		if (!entry || !isExpandable(entry)) return false;
		this.overrides.set(entry.id, !(this.overrides.get(entry.id) ?? this.expanded));
		return true;
	}
	invalidate(): void {
		this.clearCache();
	}
	private clearCache(): void {
		for (const cached of this.cache.values()) disposeTranscriptComponent(cached.component);
		this.cache.clear();
	}
	dispose(): void {
		this.disposed = true;
		this.pages = [];
		this.entries = [];
		this.clearCache();
		this.overrides.clear();
		this.lines = [];
		this.positions = [];
		this.presentation = undefined;
	}

	private captureAnchor(): void {
		const item = this.positions.find(position => position.end > this.scrollTop);
		this.anchor = item ? { id: item.id, offset: this.scrollTop - item.start } : undefined;
	}

	private component(entry: TranscriptEntry): Component {
		const pad = this.presentation?.outputPad ?? 1;
		const markdownTheme = getMarkdownTheme();
		const transformers = this.presentation?.markdownTransformers ?? [];
		const message = messageFor(entry);
		const ui = { requestRender: () => {
			for (const cached of this.cache.values()) { cached.width = undefined; cached.lines = undefined; }
			if (!this.rendering && !this.disposed) this.tui.requestRender();
		} } as TUI;
		if (entry.kind === "tool" && message?.role !== "bashExecution") {
			const name = entry.toolName ?? "tool";
			const cwd = this.presentation?.cwd ?? ".";
			const fallback = builtinToolRenderers(name, cwd);
			const renderers = this.presentation ? this.presentation.resolveTool(name, fallback) : fallback;
			const readonly = readOnlyToolRenderers(name, renderers);
			const component = new ToolExecutionComponent(entry.toolName ?? "tool", entry.toolCallId ?? entry.id, entry.args ?? {},
				{ showImages: false, outputPad: pad }, readonly, ui, cwd);
			if (readonly) Object.assign(component, { dispose: () => readonly.dispose() });
			component.setExpanded(this.overrides.get(entry.id) ?? this.expanded);
			if (entry.argsComplete !== false) component.setArgsComplete();
			if (entry.result) component.updateResult(entry.result, entry.streaming ?? false);
			return component;
		}
		if (message?.role === "assistant") {
			const component = new AssistantMessageComponent(undefined, true, markdownTheme, "", pad, transformers);
			component.updateContent(message, entry.streaming ?? false);
			return component;
		}
		if (message?.role === "user") {
			const text = typeof message.content === "string" ? message.content :
				message.content.filter(block => block.type === "text").map(block => block.text).join("");
			return new UserMessageComponent(text, markdownTheme, pad, transformers);
		}
		if (message?.role === "custom") {
			if (!message.display) return new Text("", 0, 0);
			const component = new CustomMessageComponent(message, this.presentation?.resolveMessage(message.customType), markdownTheme, pad);
			component.setExpanded(this.overrides.get(entry.id) ?? this.expanded);
			return component;
		}
		if (message?.role === "bashExecution") {
			const component = new BashExecutionComponent(message.command, ui, message.excludeFromContext, pad);
			// Stop the native loader synchronously; this viewer does not execute shell commands.
			component.setComplete(message.exitCode, message.cancelled,
				message.truncated ? { truncated: true } as NonNullable<Parameters<BashExecutionComponent["setComplete"]>[2]> : undefined,
				message.fullOutputPath);
			component.appendOutput(message.output);
			component.setExpanded(this.overrides.get(entry.id) ?? this.expanded);
			return component;
		}
		if (message?.role === "compactionSummary" || message?.role === "branchSummary") {
			const component = message.role === "compactionSummary" ? new CompactionSummaryMessageComponent(message, markdownTheme, pad) :
				new BranchSummaryMessageComponent(message, markdownTheme, pad);
			component.setExpanded(this.overrides.get(entry.id) ?? this.expanded);
			return component;
		}
		return new Text(this.theme().fg(entry.status === "error" ? "error" : "muted", entry.text ?? ""), pad, 0);
	}

	private renderEntry(entry: TranscriptEntry, width: number): string[] {
		const signature = JSON.stringify([entry, this.overrides.get(entry.id) ?? this.expanded]);
		let cached = this.cache.get(entry.id);
		if (!cached || cached.signature !== signature) {
			if (cached && compatible(cached, entry)) {
				if (cached.component instanceof ToolExecutionComponent) {
					cached.component.updateArgs(entry.args ?? {});
					if (cached.entry.argsComplete === false && entry.argsComplete !== false) cached.component.setArgsComplete();
					if (entry.result) cached.component.updateResult(entry.result, entry.streaming ?? false);
				} else if (cached.component instanceof AssistantMessageComponent) {
					cached.component.updateContent(messageFor(entry) as AssistantMessage, entry.streaming ?? false);
				}
				expand(cached.component, this.overrides.get(entry.id) ?? this.expanded);
				cached.signature = signature;
				cached.entry = entry;
				cached.lines = undefined;
			} else {
				if (cached) disposeTranscriptComponent(cached.component);
				cached = { signature, entry, component: this.component(entry) };
			}
			this.cache.set(entry.id, cached);
		}
		if (cached.width !== width || !cached.lines) {
			const indent = entry.parentToolCallId ? 2 : 0;
			const contentWidth = Math.max(1, width - indent);
			const note = entry.kind === "tool" && entry.message?.role !== "bashExecution" && entry.text ? new Text(
				this.theme().fg(entry.status === "error" ? "error" : "muted", entry.text), this.presentation?.outputPad ?? 1, 0).render(contentWidth) : [];
			cached.lines = [...cached.component.render(contentWidth), ...note].map(line => " ".repeat(indent) + line);
			cached.width = width;
		}
		return cached.lines;
	}

	viewport(width: number, height: number): string[] {
		if (this.disposed || width < 1 || height < 1) return [];
		this.height = height;
		const theme = this.theme();
		const snapshot = this.snapshot;
		const lines = [theme.fg("muted", `READ ONLY · ${this.following ? "Following live output" : "History · End to follow"}`)];
		if (snapshot?.inheritedCount) lines.push(theme.fg("muted", `${snapshot.inheritedCount} inherited entries hidden`));
		if (this.before) lines.push(theme.fg("muted", "p Load earlier records"));
		if (this.clipped) lines.push(theme.fg("warning", "Display window bounded · p for older records · End for latest"));
		if (snapshot?.error) lines.push(theme.fg("warning", dashboardText(snapshot.error)));
		if (!this.entries.length) lines.push(theme.fg("muted", "No recorded transcript yet."));
		this.positions = [];
		for (const entry of this.entries) {
			const start = lines.length;
			this.rendering = true;
			try { lines.push(...this.renderEntry(entry, width)); }
			finally { this.rendering = false; }
			if (entry.truncated) lines.push(theme.fg("warning", "… content truncated in this display"));
			this.positions.push({ id: entry.id, start, end: lines.length });
		}
		this.lines = lines;
		if (this.following) this.scrollTop = Math.max(0, lines.length - height);
		else if (this.anchor) {
			const position = this.positions.find(item => item.id === this.anchor!.id);
			if (position) this.scrollTop = position.start + this.anchor.offset;
		}
		this.scrollTop = Math.max(0, Math.min(Math.max(0, lines.length - height), this.scrollTop));
		this.captureAnchor();
		const result = lines.slice(this.scrollTop, this.scrollTop + height);
		while (result.length < height) result.push("");
		// Native message components add OSC shell-integration markers. They do not belong inside an overlay.
		return result.map(line => fit(line.replace(/\x1b\]133;[^\x07]*\x07/g, ""), width));
	}
}
