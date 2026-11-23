import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { feedbackInput, parseFeedback, ratings } from "./src/feedback.ts";
import { saveFeedback } from "./src/store.ts";
import { latestTarget } from "./src/targets.ts";
import { pickTreeTarget } from "./src/tree-picker.ts";

const usage = "用法：/rsi good|bad [说明]，或在 TUI 中用 /rsi tree 选择历史指令。";

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console.error(message); // Keep print/JSON stdout reserved for Pi.
}

export default function rsiExtension(pi: ExtensionAPI): void {
	pi.registerCommand("rsi", {
		description: `评价用户指令的执行结果。输入 /rsi 打开评分表单。${usage}`,
		handler: async (args, ctx) => {
			const query = args.trim();
			const fromTree = query === "tree";
			if (fromTree && ctx.mode !== "tui") {
				notify(ctx, "/rsi tree 需要在 Pi TUI 中选择历史指令。", "warning");
				return;
			}
			const sessionId = ctx.sessionManager.getSessionId();
			const projectPath = ctx.cwd;
			const target = fromTree ? await pickTreeTarget(ctx) : latestTarget(ctx.sessionManager.getBranch(), ctx.isIdle());
			if (!target) {
				if (!fromTree) notify(ctx, "当前分支没有可评价的用户指令。", "warning");
				return;
			}

			let input;
			if (query && !fromTree) {
				input = parseFeedback(query);
			} else {
				if (!ctx.hasUI) {
					notify(ctx, usage, "warning");
					return;
				}
				const rating = await ctx.ui.select("评价这条用户指令的执行结果", [...ratings]);
				if (rating === undefined) return;
				const description = await ctx.ui.editor("说明（可选；留空提交）");
				if (description === undefined) return;
				input = feedbackInput(rating, description);
			}
			if (!input) {
				notify(ctx, usage, "warning");
				return;
			}
			try {
				await saveFeedback({ sessionId, projectPath, ...target, ...input });
			} catch (error) {
				notify(ctx, `反馈保存失败：${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			notify(ctx, `已保存 ${input.feedback} 反馈。`, "info");
		},
	});
}
