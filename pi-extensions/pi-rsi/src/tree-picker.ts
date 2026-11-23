import { stripVTControlCharacters } from "node:util";
import { TreeSelectorComponent, type ExtensionCommandContext, type SessionMessageEntry, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { historyOutcomes, type Target } from "./targets.ts";

const graphemes = new Intl.Segmenter();

function replyLabel(entry: SessionMessageEntry | null): string {
	if (!entry) return "无最终回复";
	const message = entry.message;
	const content = message.role === "assistant"
		? message.content.filter(block => block.type === "text").map(block => block.text).join(" ").trim() || message.errorMessage || ""
		: "";
	const preview = stripVTControlCharacters(content).replace(/[\s\p{Cc}\p{Bidi_Control}]+/gu, " ").trim();
	let length = 0;
	for (const { index } of graphemes.segment(preview)) {
		if (length++ === 60) return `${entry.id}  ${preview.slice(0, index)}…`;
	}
	return `${entry.id}  ${preview || "（无文本）"}`;
}

export async function pickTreeTarget(ctx: ExtensionCommandContext): Promise<Target | undefined> {
	const tree = ctx.sessionManager.getTree();
	const leaf = ctx.sessionManager.getLeafId();
	const idle = ctx.isIdle();
	const users = new Map<string, SessionTreeNode>();
	const stack = [...tree];
	while (stack.length) {
		const node = stack.pop()!;
		if (node.entry.type === "message" && node.entry.message.role === "user") users.set(node.entry.id, node);
		for (const child of node.children) stack.push(child);
	}
	if (!users.size) {
		ctx.ui.notify("当前会话没有可评价的用户指令。", "warning");
		return;
	}

	const id = await ctx.ui.custom<string | undefined>((tui, _theme, _kb, done) => {
		const selector = new TreeSelectorComponent(tree, leaf, tui.terminal.rows, id => {
			if (users.has(id)) done(id);
			else ctx.ui.notify("请选择要评价的用户指令，而不是回复或其他条目。", "warning");
		}, () => done(undefined), undefined, undefined, "user-only");
		selector.getTreeList().onLabelEdit = () => ctx.ui.notify("评价时只读，不能编辑会话标签。", "info");
		return selector;
	}, { blocked: { kind: "question", message: "选择要评价的用户指令" } });
	const user = id === undefined ? undefined : users.get(id);
	if (!user) return;

	const outcomes = historyOutcomes(user, leaf, idle);
	let outcome = outcomes[0];
	if (outcomes.length > 1) {
		const labels = outcomes.map(replyLabel);
		const selected = await ctx.ui.select("这条指令有多个执行结果，选择要评价的一项", labels);
		if (selected === undefined) return;
		outcome = outcomes[labels.indexOf(selected)];
	}
	if (outcome === undefined) return;
	return { userMessageEntryId: user.entry.id, finalAssistantEntryId: outcome?.id ?? null };
}
