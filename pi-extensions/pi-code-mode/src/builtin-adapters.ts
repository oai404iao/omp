import { createLsTool, type ExtensionAPI, type LsToolDetails } from "@earendil-works/pi-coding-agent";
import { registerCodeModeTools } from "./contributions.ts";

/** Explicit installation, not a registry override or inherited tool authority. */
export function registerPiBuiltinLs(pi: ExtensionAPI) {
	const registration = registerCodeModeTools(pi, {
		id: "pi_builtin",
		tools: [{
			name: "ls", effect: "read", parallel: true,
			description: "List LOCAL directories using a new Pi builtin ls implementation with current-user filesystem authority, NOT the registered ls/SSH override, Code Mode root confinement, or Pi tool hooks. Requires exact grant pi_builtin__ls. Default 500 entries / 50 KB; text and truncation metadata are preserved.",
			parameters: createLsTool(".").parameters,
			async invoke(input, context) {
				context.signal.throwIfAborted();
				const result = await createLsTool(context.cwd).execute(context.toolCallId,
					input as { path?: string; limit?: number }, context.signal);
				if (result.content.some((part) => part.type !== "text") || result.terminate)
					throw new Error("Pi ls adapter requires a text-only data result");
				const details = result.details as LsToolDetails | undefined;
				const truncation = details?.truncation;
				return { value: {
					text: result.content.map((part) => part.type === "text" ? part.text : "").join("\n"),
					...(details?.entryLimitReached === undefined ? {} : { entryLimitReached: details.entryLimitReached }),
					...(truncation ? { truncation: {
						truncated: truncation.truncated, truncatedBy: truncation.truncatedBy,
						totalLines: truncation.totalLines, totalBytes: truncation.totalBytes,
						outputLines: truncation.outputLines, outputBytes: truncation.outputBytes,
						lastLinePartial: truncation.lastLinePartial, firstLineExceedsLimit: truncation.firstLineExceedsLimit,
						maxLines: truncation.maxLines, maxBytes: truncation.maxBytes,
					} } : {}),
				} };
			},
		}],
	});
	pi.on("session_shutdown", () => registration.dispose());
	return registration;
}
