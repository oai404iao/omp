import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Context, type Usage } from "@earendil-works/pi-ai";
import { type ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { GrammarInputBuffer } from "./sampling.js";

type MessageRole = Context["messages"][number]["role"];

export type Message = Context["messages"][number];

export interface ImageGenerationCallItem {
	type: "image_generation_call";
	id: string;
	status: string;
	result: string | null;
	revised_prompt?: string;
}

export interface ImageGenerationCallBlock {
	type: "image_generation_call";
	item: ImageGenerationCallItem;
}

export interface ReplayableWebSearchCallItem {
	type: "web_search_call";
	id: string;
	status: "completed";
	action: Record<string, unknown>;
	results?: Array<Record<string, unknown>>;
}

export interface CitationSource {
	url: string;
	title?: string;
}

export interface WebSearchCitationSource extends CitationSource {
	refId: string;
}

export type ReplayableResponseMessageContent =
	| { type: "output_text"; text: string; annotations: Array<Record<string, unknown>> }
	| { type: "refusal"; refusal: string };

export interface ReplayableResponseMessageItem {
	type: "message";
	id: string;
	role: "assistant";
	status: "completed";
	content: ReplayableResponseMessageContent[];
	phase?: TextSignaturePhase;
}

export type InternalAssistantContent = Extract<Message, { role: "assistant" }>["content"][number] | ImageGenerationCallBlock;

export interface OpenAIResponsesStreamOptions {
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (usage: Usage, serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined) => void;
	webSearchCitationSources?: ReadonlyArray<WebSearchCitationSource>;
	historicalCitationSources?: ReadonlyArray<CitationSource>;
}

export type TextSignaturePhase = "commentary" | "final_answer";

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
	grammarToolInputProperties?: ReadonlyMap<string, string>;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
	supportsOpenAIGrammarTools?: boolean;
}

export type ThinkingBlock = Extract<AssistantMessage["content"][number], { type: "thinking" }>;

export type TextBlock = Extract<AssistantMessage["content"][number], { type: "text" }>;

export type ToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }> & { partialJson?: string; partialInput?: string };

export type ReasoningState = {
	kind: "reasoning";
	blockIndex: number;
	block: ThinkingBlock;
	summaryParts: Map<number, { text: string }>;
};

export type MessagePartState = { type: "output_text" | "refusal"; text: string; annotations?: unknown[] };

export type MessageState = {
	kind: "message";
	blockIndex: number;
	block: TextBlock;
	parts: Map<number, MessagePartState>;
};

export type FunctionCallState = {
	kind: "function_call";
	blockIndex: number;
	block: ToolCallBlock;
};

export type CustomToolCallState = {
	kind: "custom_tool_call";
	blockIndex: number;
	block: ToolCallBlock;
	itemId: string;
	sourceItemId?: string;
	callId: string;
	input: string;
	inputJson?: GrammarInputBuffer;
};

export type OutputState = ReasoningState | MessageState | FunctionCallState | CustomToolCallState;
