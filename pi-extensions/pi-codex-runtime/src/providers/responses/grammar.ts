import type { Api, AssistantMessage, AssistantMessageEventStream, Model, Tool } from "@earendil-works/pi-ai";
import { grammarInputDelta, resolveGrammarSampling } from "./sampling.js";
import type { CustomToolCallState, OpenAIResponsesStreamOptions } from "./types.js";
import { localToolName } from "./text.js";

export function supportsGrammar(model: Model<Api>): boolean {
	return (model.compat as { supportsOpenAIGrammarTools?: boolean } | undefined)?.supportsOpenAIGrammarTools === true;
}

/** Capture the actual request's custom declarations, including Lite namespaces.
 * Legacy custom tools without sampling metadata keep their established {input}. */
export function responseGrammarProperties(body: { tools?: unknown; input?: unknown }, tools?: Tool[], includeLegacy = false): ReadonlyMap<string, string> {
	const properties = new Map<string, string>();
	const visit = (items: unknown, namespace?: string): void => {
		if (!Array.isArray(items)) return;
		for (const item of items) {
			if (!item || typeof item !== "object") continue;
			if (item.type === "namespace" && typeof item.name === "string") { visit(item.tools, item.name); continue; }
			if (item.type !== "custom" || typeof item.name !== "string") continue;
			const name = localToolName(namespace, item.name);
			const tool = tools?.find((candidate) => candidate.name === name);
			const grammar = tool && resolveGrammarSampling(tool, true);
			if (grammar) properties.set(name, grammar.inputProperty);
			else if (includeLegacy) properties.set(name, "input");
		}
	};
	visit(body.tools);
	if (Array.isArray(body.input)) for (const item of body.input) {
		if (item?.type === "additional_tools") visit(item.tools);
	}
	return properties;
}

export function customArguments(name: string, input: string, options?: OpenAIResponsesStreamOptions): Record<string, string> {
	return { [options?.grammarToolInputProperties?.get(name) ?? "input"]: input };
}

export function updateCustomInput(state: CustomToolCallState, input: string, close: boolean,
	output: AssistantMessage, stream: AssistantMessageEventStream, options?: OpenAIResponsesStreamOptions): void {
	const property = options?.grammarToolInputProperties?.get(state.block.name);
	const previous = state.input;
	state.input = input;
	state.block.partialInput = input;
	state.block.arguments = customArguments(state.block.name, input, options);
	if (property !== undefined) {
		state.inputJson ??= { input: "", started: false, closed: false };
		const delta = grammarInputDelta(state.inputJson, property, input, close);
		if (delta) stream.push({ type: "toolcall_delta", contentIndex: state.blockIndex, delta, partial: output });
	} else if (!close && input.startsWith(previous) && input.length > previous.length) {
		stream.push({ type: "toolcall_delta", contentIndex: state.blockIndex, delta: input.slice(previous.length), partial: output });
	}
}
