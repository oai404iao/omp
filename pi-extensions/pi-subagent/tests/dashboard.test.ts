import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DashboardComponent, openDashboard } from "../src/dashboard.ts";
import { agentDuration, dashboardSummary, dashboardText, renderAgentDetails, renderAgentRows } from "../src/dashboard-view.ts";
import type { DashboardAgent, DashboardSnapshot, DashboardSource, TranscriptSnapshot } from "../src/dashboard-types.ts";

const now = Date.parse("2026-10-08T10:00:00Z");
const theme = {
	fg: (_color: unknown, text: string) => text,
	bg: (_color: unknown, text: string) => text,
	bold: (text: string) => text,
} as Theme;
const styledTheme = {
	fg: (_color: unknown, text: string) => `\x1b[36m${text}\x1b[39m`,
	bg: (_color: unknown, text: string) => `\x1b[44m${text}\x1b[49m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as Theme;

function agent(name = "review", overrides: Partial<DashboardAgent> = {}): DashboardAgent {
	return {
		path: `/root/${name}`, parentPath: "/root", type: "reviewer", model: "fixture/scripted",
		thinkingLevel: "high", createdAt: new Date(now - 120_000).toISOString(), status: "running",
		topic: `Task ${name}`, task: `Review ${name} carefully.`,
		usage: {
			available: true, input: 12400, output: 2800, cacheRead: 20000, cacheWrite: 0,
			reasoning: 1200, totalTokens: 35200, cost: 0.043, requests: 12, tools: 18,
			nestedTools: 3, nestedToolsPartial: false,
		},
		durationMs: 5000, durationPartial: false, activeSince: now - 7000,
		context: { tokens: 39700, contextWindow: 128000, percent: 31, timestamp: now - 2000, live: true },
		activity: [
			{ id: "old", timestamp: now - 5000, kind: "response", status: "info", label: "reply", summary: "old response" },
			{ id: "new", timestamp: now - 1000, kind: "tool", status: "running", label: "read", summary: "new tool" },
		],
		...overrides,
	};
}
function snapshot(agents = [agent()]): DashboardSnapshot {
	return { agents, activeCount: agents.filter(a => a.status === "running").length, maxConcurrentAgents: 4 };
}
function harness(initial = snapshot(), options: { rows?: number; mode?: "regular" | "fullscreen"; theme?: Theme } = {}) {
	let state = initial;
	let reads = 0;
	let renders = 0;
	let closed = 0;
	let unsubscribed = 0;
	let failure = false;
	let currentTheme = options.theme ?? theme;
	let currentNow = now;
	const listeners = new Set<() => void>();
	const source: DashboardSource = {
		getSnapshot: () => { reads++; if (failure) throw new Error("Unable to load data"); return state; },
		subscribe: listener => { listeners.add(listener); return () => { unsubscribed++; listeners.delete(listener); }; },
	};
	const terminal = { rows: options.rows ?? 45, columns: 160 };
	const tui = { terminal, mode: options.mode ?? "regular", requestRender: () => { renders++; } };
	const component = new DashboardComponent({
		tui, source, theme: () => currentTheme,
		keybindings: new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o" } }),
		done: () => { closed++; }, now: () => currentNow,
	});
	return {
		component, tui, source,
		setTranscript(handler: NonNullable<DashboardSource["getTranscript"]>) { source.getTranscript = handler; },
		emit(next = state) { state = next; for (const listener of listeners) listener(); },
		setTheme(next: Theme) { currentTheme = next; component.invalidate(); },
		setNow(next: number) { currentNow = next; },
		fail() { failure = true; },
		get reads() { return reads; }, get renders() { return renders; },
		get closed() { return closed; }, get unsubscribed() { return unsubscribed; },
	};
}
const text = (component: DashboardComponent, width = 150) => stripTerminalSequences(component.render(width).join("\n"));

test("dashboard renders scoped summary, agent metrics and complete detail semantics", () => {
	const state = snapshot([agent(), agent("failed", { status: "errored", error: "Test failure" })]);
	assert.match(dashboardSummary(state).join("\n"), /2 agents.*1\/4 active.*1 errored/);
	const row = renderAgentRows(state, "/root/review", 80, theme, now).join("\n");
	for (const expected of ["/root/review", "reviewer", "Running", "Task review", "~$0.043", "12s", "12 req", "18 tools", "35.2k tok"]) {
		assert(row.includes(expected), expected);
	}
	assert.equal(renderAgentRows(state, "/root/review", 80, theme, now)[3].trim(),
		new Date(state.agents[0].createdAt).toTimeString().slice(0, 8));
	assert.doesNotMatch(row, /Created|ago/);
	const detail = renderAgentDetails(state.agents[0], 90, theme, now).join("\n");
	for (const expected of ["AGENT INFO", "fixture/scripted", "USAGE", "~31%", "model rounds",
		"top-level", "Nested tools", "3", "12,400", "2,800", "included in output", "35,200", "RECENT ACTIVITY"]) {
		assert(detail.includes(expected), expected);
	}
	assert(detail.indexOf("new tool") < detail.indexOf("old response"));
	assert.match(renderAgentDetails(state.agents[1], 90, theme, now).join("\n"), /Error\s+Test failure/);
});

test("missing and partial values remain unknown, context timestamps are hidden, reasoning is not added twice", () => {
	const missing = agent("legacy", {
		usage: { ...agent().usage, available: false, cost: null }, durationMs: undefined,
		activeSince: undefined, durationPartial: true, context: undefined, dataError: "Transcript incomplete", activity: [],
	});
	assert.equal(agentDuration(missing, now), "—");
	const detail = renderAgentDetails(missing, 90, theme, now).join("\n");
	assert.match(detail, /Usage unavailable; not zero/);
	assert.match(detail, /Requests\s+—/);
	assert.match(detail, /Cost \/ time\s+—/);
	assert.match(detail, /Context\s+— · no snapshot/);
	assert.match(detail, /Transcript incomplete/);
	assert.match(detail, /No recorded activity/);
	assert.match(dashboardSummary(snapshot([missing])).join("\n"), /Est\. —.*— req.*partial data/);
	const partial = agent("partial", {
		durationPartial: true, usage: { ...agent().usage, cost: null, nestedToolsPartial: true },
		context: { tokens: null, percent: null, contextWindow: 128000, timestamp: now - 61_000, live: false },
	});
	const partialText = renderAgentDetails(partial, 90, theme, now).join("\n");
	assert.match(partialText, /waiting for next response/);
	assert.doesNotMatch(partialText, /(?:Snapshot|Updated) at/);
	assert.match(partialText, /Price unavailable/);
	assert.match(partialText, /≥12s · partial/);
	assert.match(partialText, /Nested tools\s+3 · partial/);
	assert.match(partialText, /Total\s+35,200/);
});

test("context timestamps are absent for live and unloaded agents while detail duration still advances", () => {
	for (const live of [false, true]) {
		const value = agent("clock", { context: { ...agent().context!, live } });
		const before = renderAgentDetails(value, 100, theme, now);
		const after = renderAgentDetails(value, 100, theme, now + 90_000);
		assert.doesNotMatch([...before, ...after].join("\n"), /(?:Snapshot|Updated) at/);
		assert.notEqual(agentDuration(value, now), agentDuration(value, now + 90_000));
	}
});

test("agent list duration is sampled once per opening despite ticks, completion and new runs", t => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const value = agent("frozen", { usage: { ...agent().usage, nestedTools: 0, reasoning: undefined } });
	const h = harness(snapshot([value]), { rows: 30 });
	try {
		const listMetric = () => text(h.component).split("\n").find(line => /\breq ·.*\btok\s/.test(line));
		assert.match(listMetric()!, /· 12s ·/);
		h.setNow(now + 90_000);
		t.mock.timers.tick(1000);
		assert.match(listMetric()!, /· 12s ·/);
		h.emit(snapshot([{ ...value, status: "completed", activeSince: undefined, durationMs: 102_000,
			usage: { ...value.usage, requests: 20 } }]));
		t.mock.timers.tick(40);
		assert.match(listMetric()!, /· 12s · 20 req/);
		assert.match(text(h.component), /Completed/);
		h.emit(snapshot([{ ...value, durationMs: 102_000, activeSince: now + 90_000 },
			agent("new", { durationMs: 2000, activeSince: now + 85_000 })]));
		t.mock.timers.tick(40);
		assert.match(listMetric()!, /· 12s ·/);
		assert.match(text(h.component), /· 7s ·/);
		h.setNow(now + 120_000);
		t.mock.timers.tick(1000);
		assert.match(listMetric()!, /· 12s ·/);
		assert.match(text(h.component), /· 7s ·/);
		const reopened = harness(snapshot([{ ...value, durationMs: 102_000, activeSince: undefined }]));
		try {
			assert.match(text(reopened.component), /· 1m42s ·/);
		} finally { reopened.component.dispose(); }
	} finally { h.component.dispose(); }
});

test("activity has bounded multiline content previews and sanitizes control sequences", () => {
	const value = agent("activity", { activity: [{
		id: "tool", timestamp: now, kind: "tool", status: "running", label: "bash", summary: "command",
		preview: "$ pnpm run check\n正在检查🙂\nthird line\nfourth must be omitted\x1b[2J",
	}] });
	const lines = renderAgentDetails(value, 80, theme, now);
	const activity = lines.slice(lines.findIndex(line => line.includes("RECENT ACTIVITY")));
	assert.match(activity.join("\n"), /\$ pnpm run check/);
	assert.match(activity.join("\n"), /正在检查🙂/);
	assert.match(activity.join("\n"), /third line…/);
	assert.doesNotMatch(activity.join(""), /fourth|[\x00-\x1f]/);
	for (const width of [1, 12, 40, 80]) {
		for (const line of renderAgentDetails(value, width, styledTheme, now)) assert(visibleWidth(line) <= width);
	}
});

test("Response previews replace repeated heading summaries while legacy summaries remain visible", () => {
	const value = agent("response", { activity: [{
		id: "answer", timestamp: now, kind: "response", status: "success", label: "Response",
		summary: "This answer is visible once", preview: "This answer is visible once",
	}, {
		id: "legacy", timestamp: now - 1, kind: "response", status: "success", label: "Response",
		summary: "Legacy answer without a preview",
	}] });
	const lines = renderAgentDetails(value, 100, theme, now);
	const activity = lines.slice(lines.findIndex(line => line.includes("RECENT ACTIVITY")));
	assert.equal(activity.join("\n").match(/This answer is visible once/g)?.length, 1);
	assert.doesNotMatch(activity[1], /This answer/);
	assert.match(activity.join("\n"), /Response Legacy answer without a preview/);
});

test("rendering stays within all widths and heights, including CJK, emoji, long tasks and theme invalidation", () => {
	const h = harness(snapshot([agent("long", {
		path: `/root/${"路径🙂".repeat(100)}/tail`, type: "测试".repeat(30), topic: "中文👩‍💻".repeat(100),
		task: `${"段落".repeat(300)}\n${"more ".repeat(300)}`,
	})]), { theme: styledTheme });
	try {
		for (const height of [1, 5, 12, 24, 45]) {
			h.tui.terminal.rows = height;
			for (const width of [0, 1, 2, 12, 24, 40, 80, 111, 112, 150]) {
				const lines = h.component.render(width);
				assert(lines.length <= Math.max(1, Math.floor(height * 0.88)));
				for (const line of lines) assert(visibleWidth(line) <= width, `${width}: ${visibleWidth(line)}`);
			}
		}
		h.setTheme(theme);
		assert.doesNotMatch(h.component.render(150).join("\n"), /\x1b\[(?:36|44|1)m/);
		h.setTheme(styledTheme);
		assert.match(h.component.render(150).join("\n"), /\x1b\[36m/);
		assert.equal(h.reads, 1, "render/resize/theme changes must never read source");
	} finally { h.component.dispose(); }
});

test("transcript data cannot inject ANSI, OSC hyperlinks, cursor markers, control characters or extra rows", () => {
	const attack = "\x1b[2J\x1b[31mBAD\x1b[0m\x1b]8;;https://evil.test\x07link\x1b]8;;\x07\x1b_pi:c\x07\r\t\x00\u202e";
	assert.equal(dashboardText(attack), "BADlink");
	const hostile = agent("unsafe", {
		path: attack, type: attack, model: attack, parentPath: attack, thinkingLevel: attack,
		topic: `${attack}\nextra`, task: attack, error: attack, dataError: attack,
		activity: [{ id: "unsafe", timestamp: now, kind: "tool", status: "error", label: attack, summary: `${attack}\nextra` }],
	});
	const lines = [...renderAgentRows(snapshot([hostile]), attack, 80, theme, now), ...renderAgentDetails(hostile, 80, theme, now)];
	assert.doesNotMatch(lines.join(""), /[\x00-\x1f\x7f-\x9f\u202e]/);
	assert.doesNotMatch(lines.join(""), /https:\/\/evil/);
	for (const line of lines) assert(visibleWidth(line) <= 80);
});

test("empty state and source errors are rendered without invented agents", t => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = harness(snapshot([]));
	try {
		assert.match(text(h.component), /No subagents in this session/);
		assert.match(text(h.component), /Select an agent/);
		h.fail();
		h.emit();
		t.mock.timers.tick(40);
		assert.match(text(h.component), /Data unavailable: Unable to load data/);
	} finally { h.component.dispose(); }
});

test("keyboard navigation preserves selection on updates, panes scroll independently and narrow Esc returns", t => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const agents = Array.from({ length: 12 }, (_, i) => agent(`agent_${i}`));
	const h = harness(snapshot(agents), { rows: 30 });
	try {
		text(h.component);
		h.component.handleInput("j");
		assert.match(text(h.component), /› \/root\/agent_1/);
		h.emit(snapshot([agent("new"), ...agents.map(a => ({ ...a, status: "completed" as const }))]));
		t.mock.timers.tick(40);
		assert.match(text(h.component), /› \/root\/agent_1/);
		h.component.handleInput("\t");
		h.component.handleInput("\x1b[6~");
		const scrolled = text(h.component);
		assert.match(scrolled, /› \/root\/agent_1/);
		assert.doesNotMatch(scrolled, /AGENT INFO/);
		h.component.handleInput("\t");
		h.component.handleInput("\x1b[6~");
		assert.doesNotMatch(text(h.component), /› \/root\/agent_1/);
		h.component.handleInput("j");
		assert.match(text(h.component), /› \/root\/agent_2/);
		assert.match(text(h.component), /AGENT INFO/, "selection resets detail scroll");
		text(h.component, 80);
		h.component.handleInput("\r");
		assert.match(text(h.component, 80), /DETAILS/);
		h.component.handleInput("\x1b");
		assert.equal(h.closed, 0);
		assert.match(text(h.component, 80), /AGENTS/);
		h.component.handleInput("\x1b");
		assert.equal(h.closed, 1);
		assert.equal(h.unsubscribed, 1);
	} finally { h.component.dispose(); }
});

test("default task preview keeps recent activity visible and Enter expands/collapses without changing selection", () => {
	const task = `${"Long task content ".repeat(200)}\nEND OF TASK`;
	const h = harness(snapshot([agent("preview", { task, usage: { ...agent().usage, nestedTools: 0, reasoning: undefined } })]), { rows: 40 });
	try {
		const initial = text(h.component);
		assert.match(initial, /Enter to expand task/);
		assert.match(initial, /RECENT ACTIVITY/);
		assert.match(initial, /new tool/);
		h.component.handleInput("\t");
		h.component.handleInput("\r");
		const expanded = text(h.component);
		assert.doesNotMatch(expanded, /Enter to expand task/);
		assert.doesNotMatch(expanded, /RECENT ACTIVITY/);
		assert.match(expanded, /› \/root\/preview/);
		h.component.handleInput("\r");
		assert.match(text(h.component), /RECENT ACTIVITY/);
		assert.match(renderAgentDetails(agent("full", { task }), 80, theme, now, true).join("\n"), /END OF TASK/);
	} finally { h.component.dispose(); }
});

test("resize reveals the selected agent once without overriding manual scrolling on clock renders", t => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = harness(snapshot(Array.from({ length: 12 }, (_, i) => agent(`resize_${i}`))), { rows: 45 });
	try {
		text(h.component);
		for (let i = 0; i < 4; i++) h.component.handleInput("j");
		const tall = text(h.component);
		assert.match(tall, /\/root\/resize_0/);
		assert.match(tall, /› \/root\/resize_4/);
		h.tui.terminal.rows = 24;
		assert.match(text(h.component), /› \/root\/resize_4/, "height shrink keeps selection visible");
		for (let i = 0; i < 2; i++) h.component.handleInput("\x1b[6~");
		const scrolled = text(h.component);
		assert.doesNotMatch(scrolled, /› \/root\/resize_4/);
		t.mock.timers.tick(1000);
		assert.equal(text(h.component), scrolled, "ordinary clock renders preserve manual scroll");
		assert.match(text(h.component, 80), /› \/root\/resize_4/, "width/layout change reveals selection");
		for (let i = 0; i < 2; i++) h.component.handleInput("\x1b[6~");
		assert.doesNotMatch(text(h.component, 80), /› \/root\/resize_4/);
		assert.match(text(h.component, 90), /› \/root\/resize_4/, "width changes within one layout also reveal");
		h.tui.terminal.rows = 5;
		assert.match(text(h.component, 90), /Terminal too small/);
		h.tui.terminal.rows = 24;
		assert.match(text(h.component, 90), /› \/root\/resize_4/);
		assert.equal(h.reads, 1, "geometry and clock updates never fetch snapshots");
	} finally { h.component.dispose(); }
});

test("selection removal falls back safely and both scroll directions clamp at their bounds", t => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = harness(snapshot([agent("one"), agent("two")]), { rows: 24 });
	try {
		text(h.component);
		h.component.handleInput("j");
		assert.match(text(h.component), /› \/root\/two/);
		h.emit(snapshot([agent("one")]));
		t.mock.timers.tick(40);
		assert.match(text(h.component), /› \/root\/one/);
		h.component.handleInput("\t");
		for (let i = 0; i < 10; i++) h.component.handleInput("\x1b[6~");
		const end = text(h.component);
		h.component.handleInput("\x1b[6~");
		assert.equal(text(h.component), end);
		for (let i = 0; i < 10; i++) h.component.handleInput("\x1b[5~");
		assert.match(text(h.component), /AGENT INFO/);
		const start = text(h.component);
		h.component.handleInput("\x1b[5~");
		assert.equal(text(h.component), start);
		h.emit(snapshot([]));
		t.mock.timers.tick(40);
		assert.match(text(h.component), /Select an agent/);
		h.component.handleInput("\r");
		assert.match(text(h.component), /No subagents/);
	} finally { h.component.dispose(); }
});

test("source updates are coalesced after events; clock ticks only render; close cleans pending timers exactly once", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = harness();
	h.emit();
	h.emit();
	h.emit();
	assert.equal(h.reads, 1);
	t.mock.timers.tick(39);
	assert.equal(h.reads, 1);
	t.mock.timers.tick(1);
	assert.equal(h.reads, 2);
	const rendered = h.renders;
	t.mock.timers.tick(1000);
	assert(h.renders > rendered);
	assert.equal(h.reads, 2);
	h.emit({ ...snapshot(), closed: true });
	t.mock.timers.tick(40);
	await Promise.resolve();
	assert.equal(h.closed, 1);
	assert.equal(h.unsubscribed, 1);
	const lastRender = h.renders;
	h.component.dispose();
	h.emit();
	t.mock.timers.tick(5000);
	assert.equal(h.renders, lastRender);
	assert.equal(h.reads, 3);
	assert.equal(h.unsubscribed, 1);
});

test("initial closed sources finish after mounting and disposal cancels pending refresh", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const closed = harness({ ...snapshot(), closed: true });
	assert.equal(closed.closed, 0);
	await Promise.resolve();
	assert.equal(closed.closed, 0, "wait until custom() has mounted through its Promise continuation");
	t.mock.timers.tick(0);
	assert.equal(closed.closed, 1);
	const h = harness();
	h.emit();
	h.component.dispose();
	t.mock.timers.tick(1000);
	assert.equal(h.reads, 1);
	assert.equal(h.renders, 0);
});

test("normalized mouse input works only in fullscreen and targets the correct pane", () => {
	const h = harness(snapshot(Array.from({ length: 12 }, (_, i) => agent(`mouse_${i}`))), { mode: "fullscreen", rows: 30 });
	const mouse = (overrides: Partial<TuiMouseEvent>): TuiMouseEvent => ({
		type: "click", button: "left", x: 4, y: 11, screenX: 4, screenY: 11, width: 150, height: 26,
		shift: false, alt: false, ctrl: false, ...overrides,
	});
	try {
		text(h.component);
		assert.equal(h.component.handleMouse(mouse({}))?.handled, true);
		assert.match(text(h.component), /› \/root\/mouse_1/);
		h.component.handleMouse(mouse({ type: "wheel", x: 120, wheelDelta: 20 }));
		const result = text(h.component);
		assert.match(result, /› \/root\/mouse_1/);
		assert.doesNotMatch(result, /AGENT INFO/);
		assert.equal(h.component.handleMouse(mouse({ y: 0 })), undefined);
		h.tui.mode = "regular";
		assert.equal(h.component.handleMouse(mouse({})), undefined);
	} finally { h.component.dispose(); }
});

test("openDashboard uses a native responsive overlay and does not open in non-TUI modes", async () => {
	const h = harness();
	h.component.dispose();
	let calls = 0;
	const ctx = {
		mode: "tui", ui: {
			theme,
			custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0],
				options: Parameters<ExtensionCommandContext["ui"]["custom"]>[1]) => {
				calls++;
				assert.equal(options?.overlay, true);
				const component = await factory(h.tui as TUI, theme, new KeybindingsManager(TUI_KEYBINDINGS) as never, () => {});
				assert.equal(typeof options?.overlayOptions, "object");
				if (!options?.overlayOptions || typeof options.overlayOptions === "function") throw new Error("missing options");
				assert.equal(options.overlayOptions.width, 150);
				h.tui.terminal.columns = 300;
				assert.equal(options.overlayOptions.width, 160);
				h.tui.terminal.columns = 80;
				assert.equal(options.overlayOptions.width, 75);
				assert.equal(options.overlayOptions.maxHeight, "88%");
				component.dispose?.();
			},
		},
	} as unknown as ExtensionCommandContext;
	await openDashboard(ctx, h.source);
	assert.equal(calls, 1);
	ctx.mode = "rpc";
	await openDashboard(ctx, h.source);
	assert.equal(calls, 1);
});

test("transcript opens read-only, reads only outside rendering, restores panes and can reopen", t => {
	initTheme("dark", false);
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const h = harness(snapshot([agent("one"), agent("two")]), { rows: 30 });
	const reads: { path: string; before?: string }[] = [];
	let body = "Child answer";
	let childStatus: TranscriptSnapshot["status"] = "running";
	h.setTranscript((path, before) => {
		reads.push({ path, before });
		return {
			path, status: childStatus, inheritedCount: 2, before: "previous-raw-entry",
			entries: [{ id: before ? "earlier" : "latest", timestamp: now, kind: "assistant", status: "success",
				text: before ? "Earlier child answer" : body }],
		};
	});
	try {
		text(h.component);
		h.component.handleInput("j");
		h.component.handleInput("\t");
		h.component.handleInput("\x1b[6~");
		const original = text(h.component);
		h.component.handleInput("t");
		assert.deepEqual(reads, [{ path: "/root/two", before: undefined }]);
		assert.match(text(h.component), /READ ONLY · Following · running · TRANSCRIPT \/root\/two/);
		assert.match(text(h.component), /Child answer/);
		assert.equal(reads.length, 1);
		h.component.invalidate();
		text(h.component, 80);
		t.mock.timers.tick(1000);
		assert.equal(reads.length, 1, "resize, invalidate and clock rendering never fetch transcript");
		h.component.handleInput("p");
		assert.equal(reads[1].before, "previous-raw-entry");
		assert.match(text(h.component), /Earlier child answer/);
		body = "Updated child answer";
		childStatus = "completed";
		h.emit();
		t.mock.timers.tick(40);
		assert.match(text(h.component), /Updated child answer/);
		assert.match(text(h.component), /READ ONLY · History · completed · TRANSCRIPT \/root\/two/);
		h.component.handleInput("\x1b[F");
		assert.match(text(h.component), /Following/);
		h.component.handleInput("\x1b");
		assert.equal(h.closed, 0);
		assert.equal(text(h.component), original, "return restores detail scroll and selected agent");
		h.component.handleInput("t");
		assert.match(text(h.component), /Updated child answer/);
		h.emit({ ...snapshot(), closed: true });
		t.mock.timers.tick(40);
		t.mock.timers.tick(0);
		assert.equal(h.closed, 1);
		assert.equal(h.unsubscribed, 1);
	} finally { h.component.dispose(); }
});

test("transcript errors and unsupported sources are safe, fullscreen mouse scrolls and tools expand", () => {
	initTheme("dark", false);
	const h = harness(snapshot(), { rows: 30, mode: "fullscreen" });
	try {
		text(h.component);
		h.component.handleInput("t");
		assert.doesNotMatch(text(h.component), /TRANSCRIPT/);
		h.setTranscript(() => { throw new Error("\x1b[2JUnavailable"); });
		h.component.handleInput("t");
		assert.match(text(h.component), /Unavailable/);
		assert.doesNotMatch(h.component.render(150).join(""), /\x1b\[2J/);
		h.component.handleInput("\x1b");
		const state: TranscriptSnapshot = {
			path: "/root/review", status: "completed", inheritedCount: 0, entries: [{
				id: "bash", timestamp: now, kind: "tool", status: "success", toolName: "bash", args: { command: "fixture" },
				result: { content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `result_${i}`).join("\n") }], isError: false },
			}],
		};
		h.setTranscript(() => state);
		h.component.handleInput("t");
		h.component.handleInput("\x1b[H");
		assert.doesNotMatch(text(h.component), /result_24\b/);
		h.component.handleInput("\x0f"); // Default app.tools.expand: Ctrl+O.
		h.component.handleInput("\x1b[F");
		assert.match(text(h.component), /result_24\b/);
		const mouse: TuiMouseEvent = {
			type: "wheel", wheelDelta: -2, button: "none", x: 5, y: 8, screenX: 5, screenY: 8,
			width: 150, height: 26, shift: false, alt: false, ctrl: false,
		};
		assert.equal(h.component.handleMouse(mouse)?.handled, true);
		assert.match(text(h.component), /History/);
		h.tui.mode = "regular";
		assert.equal(h.component.handleMouse(mouse), undefined);
	} finally { h.component.dispose(); }
});
