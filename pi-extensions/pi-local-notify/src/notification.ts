import { randomUUID } from "node:crypto";

/** OSC 99 payloads are base64 so project names cannot inject terminal controls. */
export function notificationSequence(
	env: NodeJS.ProcessEnv,
	body: string,
	condition: "unfocused" | "always" = "unfocused",
	id: string = randomUUID(),
): string | undefined {
	if (!env.KITTY_WINDOW_ID) return undefined;

	const encode = (text: string): string => Buffer.from(text, "utf8").toString("base64");
	const title = `\x1b]99;i=${id}:e=1:a=focus:o=${condition}:d=0;${encode("Pi")}\x1b\\`;
	const content = `\x1b]99;i=${id}:e=1:p=body:d=1;${encode(body)}\x1b\\`;
	const sequence = title + content;

	// tmux DCS passthrough requires doubling every ESC in its payload.
	return env.TMUX || env.TMUX_PANE
		? `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`
		: sequence;
}
