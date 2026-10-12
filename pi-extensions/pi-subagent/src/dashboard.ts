import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { DashboardSnapshot, DashboardSource } from "./dashboard-types.ts";
import { AGENT_ROW_HEIGHT, dashboardSummary, dashboardText, fit, renderAgentDetails, renderAgentRows } from "./dashboard-view.ts";

export interface DashboardOptions {
	tui: Pick<TUI, "requestRender" | "mode"> & { terminal: Pick<TUI["terminal"], "rows" | "columns"> };
	theme: () => Theme;
	keybindings: Pick<KeybindingsManager, "matches">;
	source: DashboardSource;
	done: () => void;
	now?: () => number;
}

/** One interaction owns one instance; source lifetime belongs to the coordinator. */
export class DashboardComponent implements Component {
	private snapshot: DashboardSnapshot = { agents: [], activeCount: 0, maxConcurrentAgents: 0 };
	private selectedPath?: string;
	private pane: "agents" | "details" = "agents";
	private narrow = true;
	private width = 0;
	private bodyTop = 5;
	private bodyHeight = 1;
	private leftWidth = 0;
	private now: () => number;
	private disposed = false;
	private finished = false;
	private unsubscribe?: () => void;
	private clock?: ReturnType<typeof setInterval>;
	private refresh?: ReturnType<typeof setTimeout>;
	private closeTimer?: ReturnType<typeof setTimeout>;
	private list: ScrollView;
	private details: ScrollView;
	private revealSelection = true;
	private taskExpanded = false;

	constructor(private readonly options: DashboardOptions) {
		this.now = options.now ?? Date.now;
		const content = (render: (width: number) => string[]): Component => ({ render, invalidate() {} });
		this.list = new ScrollView(content(width =>
			renderAgentRows(this.snapshot, this.selectedPath, width, options.theme(), this.now())));
		this.details = new ScrollView(content(width =>
			renderAgentDetails(this.selectedAgent, width, options.theme(), this.now(), this.taskExpanded)));
		try {
			this.unsubscribe = options.source.subscribe(() => this.queueRefresh());
			this.readSnapshot();
		} catch (error) { this.snapshot.error = this.errorText(error); }
		this.clock = setInterval(() => { if (!this.disposed) options.tui.requestRender(); }, 1000);
		this.clock.unref();
	}

	private get selectedAgent() { return this.snapshot.agents.find(agent => agent.path === this.selectedPath); }
	private errorText(error: unknown): string { return dashboardText(error instanceof Error ? error.message : String(error)); }
	private queueRefresh(): void {
		if (this.disposed || this.refresh) return;
		this.refresh = setTimeout(() => {
			this.refresh = undefined;
			if (this.disposed) return;
			this.readSnapshot();
			this.options.tui.requestRender();
		}, 40);
		this.refresh.unref();
	}
	private readSnapshot(): void {
		try {
			const snapshot = this.options.source.getSnapshot();
			const before = this.selectedPath;
			const beforeIndex = this.snapshot.agents.findIndex(agent => agent.path === before);
			this.snapshot = snapshot;
			if (!snapshot.agents.some(agent => agent.path === before)) this.selectedPath = snapshot.agents[0]?.path;
			if (before !== this.selectedPath) {
				this.details.scrollToStart();
				this.taskExpanded = false;
				this.revealSelection = true;
			}
			if (snapshot.agents.findIndex(agent => agent.path === this.selectedPath) !== beforeIndex) this.revealSelection = true;
			// Pi mounts custom() via a Promise; closing in a microtask can precede that mount.
			if (snapshot.closed && !this.closeTimer) this.closeTimer = setTimeout(() => this.finish(), 0);
		} catch (error) { this.snapshot = { ...this.snapshot, error: this.errorText(error) }; }
	}

	private finish(): void {
		if (this.finished || this.disposed) return;
		this.finished = true;
		this.dispose();
		this.options.done();
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.clock);
		clearTimeout(this.refresh);
		clearTimeout(this.closeTimer);
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
	invalidate(): void {
		this.list.invalidate();
		this.details.invalidate();
	}

	private select(index: number): void {
		const agent = this.snapshot.agents[Math.max(0, Math.min(this.snapshot.agents.length - 1, index))];
		if (!agent) return;
		if (agent.path !== this.selectedPath) {
			this.details.scrollToStart();
			this.taskExpanded = false;
		}
		this.selectedPath = agent.path;
		this.revealSelection = true;
	}
	handleInput(data: string): void {
		if (this.disposed) return;
		const matches = (action: Parameters<KeybindingsManager["matches"]>[1]) => this.options.keybindings.matches(data, action);
		if (matches("tui.select.cancel") || matchesKey(data, "escape")) {
			if (this.narrow && this.pane === "details") this.pane = "agents";
			else { this.finish(); return; }
		} else if (matchesKey(data, "tab")) {
			this.pane = this.pane === "agents" ? "details" : "agents";
		} else if (matches("tui.select.confirm")) {
			if (this.pane === "details") {
				this.taskExpanded = !this.taskExpanded;
				this.details.scrollToStart();
			} else if (this.selectedAgent) this.pane = "details";
		} else if (matches("tui.select.pageUp") || matches("tui.select.pageDown")) {
			const direction = matches("tui.select.pageUp") ? -1 : 1;
			(this.pane === "agents" ? this.list : this.details).scrollBy(direction * Math.max(1, this.bodyHeight - 1));
		} else if (matches("tui.select.up") || matches("tui.select.down") || data === "j" || data === "k") {
			const direction = matches("tui.select.up") || data === "k" ? -1 : 1;
			if (this.pane === "agents") {
				this.select(this.snapshot.agents.findIndex(agent => agent.path === this.selectedPath) + direction);
			} else this.details.scrollBy(direction);
		} else return;
		this.options.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed || this.options.tui.mode !== "fullscreen" ||
			event.y < this.bodyTop || event.y >= this.bodyTop + this.bodyHeight ||
			event.x < 1 || event.x >= this.width - 1) return;
		const pane = this.narrow ? this.pane : event.x <= this.leftWidth ? "agents" : "details";
		if (event.type === "wheel") {
			this.pane = pane;
			(pane === "agents" ? this.list : this.details).scrollBy(event.wheelDelta ?? 0);
		} else if (event.type === "click" && event.button === "left") {
			this.pane = pane;
			if (pane === "agents") {
				this.select(Math.floor((event.y - this.bodyTop + this.list.scrollTop) / AGENT_ROW_HEIGHT));
				if (this.narrow && (event.clickCount ?? 1) > 1) this.pane = "details";
			}
		} else return;
		return { handled: true, render: true };
	}

	private viewport(view: ScrollView, width: number, height: number, reveal = false): string[] {
		const lines = view.render(width);
		view.updateLayout(lines.length, height, () => { if (!this.disposed) this.options.tui.requestRender(); });
		if (reveal) {
			const index = this.snapshot.agents.findIndex(agent => agent.path === this.selectedPath);
			const start = Math.max(0, index) * AGENT_ROW_HEIGHT;
			if (start < view.scrollTop) view.scrollTo(start);
			else if (start + AGENT_ROW_HEIGHT - 1 > view.scrollTop + height) {
				view.scrollTo(start + Math.min(AGENT_ROW_HEIGHT - 1, height) - height);
			}
		}
		const visible = lines.slice(view.scrollTop, view.scrollTop + height);
		while (visible.length < height) visible.push("");
		return visible.map(line => fit(line, width));
	}

	render(width: number): string[] {
		width = Math.max(0, Math.floor(width));
		const height = Math.max(1, Math.min(this.options.tui.terminal.rows, Math.floor(this.options.tui.terminal.rows * 0.88)));
		const narrow = width - 2 < 110;
		const bodyHeight = width < 24 || height < 10 ? 0 : height - 8;
		if (width !== this.width || narrow !== this.narrow || bodyHeight !== this.bodyHeight) {
			this.revealSelection = true;
		}
		this.width = width;
		this.narrow = narrow;
		this.bodyHeight = bodyHeight;
		if (!width) return [];
		if (width < 24 || height < 10) {
			return ["Subagents", "Terminal too small", "Esc close"].slice(0, height).map(line => fit(line, width));
		}
		const theme = this.options.theme();
		const inner = width - 2;
		const border = (text: string) => theme.fg("border", text);
		const row = (text: string) => border("│") + fit(text, inner) + border("│");
		const [summary, totals] = dashboardSummary(this.snapshot);
		const rows = [
			border("╭") + fit(theme.fg("accent", theme.bold(" Subagents ")), inner) + border("╮"),
			row(` ${summary}`),
			row(this.snapshot.error ? theme.fg("warning", ` Data unavailable: ${dashboardText(this.snapshot.error)}`) : ` ${totals}`),
			border(`├${"─".repeat(inner)}┤`),
		];
		this.bodyTop = 5;
		const title = (text: string, active: boolean) => theme.fg(active ? "accent" : "muted", `${active ? "›" : " "} ${text}`);
		if (this.narrow) {
			rows.push(row(title(this.pane === "agents" ? "AGENTS" : "DETAILS", true)));
			const view = this.pane === "agents" ? this.list : this.details;
			for (const line of this.viewport(view, inner - 2, this.bodyHeight, this.pane === "agents" && this.revealSelection)) {
				rows.push(row(` ${line} `));
			}
		} else {
			this.leftWidth = Math.floor((inner - 1) * 0.55);
			const rightWidth = inner - 1 - this.leftWidth;
			rows.push(row(fit(title("AGENTS", this.pane === "agents"), this.leftWidth) +
				border("│") + fit(title("DETAILS", this.pane === "details"), rightWidth)));
			const left = this.viewport(this.list, this.leftWidth - 2, this.bodyHeight, this.revealSelection);
			const right = this.viewport(this.details, rightWidth - 2, this.bodyHeight);
			for (let i = 0; i < this.bodyHeight; i++) rows.push(row(` ${left[i]} ${border("│")} ${right[i]} `));
		}
		if (!this.narrow || this.pane === "agents") this.revealSelection = false;
		rows.push(border(`├${"─".repeat(inner)}┤`));
		const hint = this.narrow ? this.pane === "agents" ? "↑↓/jk Select · Enter Details · PgUp/Dn Scroll · Esc Close" :
			"↑↓/jk Scroll · Enter Task · PgUp/Dn Page · Esc Back" :
			"↑↓/jk Navigate · Tab Focus · Enter Task · PgUp/Dn Scroll · Esc Close";
		rows.push(row(theme.fg("muted", ` ${hint}`)));
		rows.push(border(`╰${"─".repeat(inner)}╯`));
		return rows;
	}
}

export async function openDashboard(ctx: ExtensionCommandContext, source: DashboardSource): Promise<void> {
	if (ctx.mode !== "tui") return;
	let terminal: TUI["terminal"] | undefined;
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		terminal = tui.terminal;
		return new DashboardComponent({ tui, theme: () => ctx.ui.theme ?? theme, keybindings, source, done });
	}, {
			overlay: true,
			overlayOptions: {
				anchor: "center", maxHeight: "88%",
				// Pi 0.99.1 resolves an options factory once; layout reads this property on resize.
				get width() { return Math.max(1, Math.min(160, Math.floor((terminal?.columns ?? 80) * 0.94))); },
			},
		});
}
