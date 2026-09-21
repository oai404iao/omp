import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function trackCompactionPrompt(pi: ExtensionAPI): () => string | undefined {
	let runOptions: BuildSystemPromptOptions | undefined;
	pi.on("before_agent_start", (event) => {
		// Pi chains all handlers through this same mutable options object.
		runOptions = event.systemPromptOptions;
	});
	const clear = () => { runOptions = undefined; };
	pi.on("agent_settled", clear);
	pi.on("session_start", clear);
	pi.on("session_shutdown", clear);
	return () => runOptions?.forceSystemPrompt;
}
