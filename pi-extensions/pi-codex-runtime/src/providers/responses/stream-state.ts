import type { AssistantMessage } from "@earendil-works/pi-ai";
import { extractWebSearchCitationSources } from "./citations.js";
import { sanitizeImageGenerationCallItem } from "./items.js";
import { shortHash } from "./text.js";
import type { CustomToolCallState, InternalAssistantContent, OpenAIResponsesStreamOptions, OutputState, WebSearchCitationSource } from "./types.js";

export function createResponsesStreamState(output: AssistantMessage, options?: OpenAIResponsesStreamOptions) {

	const blocks = output.content;

	const blockIndex = () => blocks.length - 1;

	const outputStates = new Map<number, OutputState>();

	const imageGenerationCallIds = new Set<string>();

	const nativeCompactionSignatures = new Set<string>();

	const webSearchCitationSources = new Map<string, WebSearchCitationSource>();

	for (const source of options?.webSearchCitationSources ?? []) {
		if (source.refId && source.url) webSearchCitationSources.set(source.refId, source);
	}

	const registerWebSearchCitationSources = (item: unknown): void => {
		for (const source of extractWebSearchCitationSources(item)) {
			webSearchCitationSources.set(source.refId, source);
		}
	};

	const historicalCitationSources = [...(options?.historicalCitationSources ?? [])];

	const responseOutputIndexByBlock = new WeakMap<object, number>();

	const pushResponseBlock = <T extends InternalAssistantContent>(block: T, outputIndex: number): T => {
		(output.content as InternalAssistantContent[]).push(block);
		responseOutputIndexByBlock.set(block as object, outputIndex);
		return block;
	};

	const normalizeResponseBlockOrder = (): void => {
		const content = output.content as InternalAssistantContent[];
		const slots: number[] = [];
		const indexedBlocks: Array<{ block: InternalAssistantContent; outputIndex: number; sequence: number }> = [];
		for (let index = 0; index < content.length; index++) {
			const block = content[index]!;
			const outputIndex = responseOutputIndexByBlock.get(block as object);
			if (outputIndex === undefined) continue;
			slots.push(index);
			indexedBlocks.push({ block, outputIndex, sequence: indexedBlocks.length });
		}
		indexedBlocks.sort((a, b) => a.outputIndex - b.outputIndex || a.sequence - b.sequence);
		for (let index = 0; index < slots.length; index++) {
			content[slots[index]!] = indexedBlocks[index]!.block;
		}
	};

	const customItemId = (itemId: string | undefined, callId: string): string =>
		itemId?.startsWith("ctc_") ? itemId : `ctc_${shortHash(itemId || callId)}`;

	const findCustomToolCallState = (event: { output_index?: number; item_id?: string; call_id?: string }): CustomToolCallState | undefined => {
		const indexed = typeof event.output_index === "number" ? outputStates.get(event.output_index) : undefined;
		if (indexed?.kind === "custom_tool_call") return indexed;
		for (const state of outputStates.values()) {
			if (state.kind !== "custom_tool_call") continue;
			if (event.item_id && (event.item_id === state.itemId || event.item_id === state.sourceItemId)) return state;
			if (event.call_id && event.call_id === state.callId) return state;
		}
		return undefined;
	};


	const appendImageGenerationCall = (item: unknown, outputIndex: number): void => {
		const imageGenerationCall = sanitizeImageGenerationCallItem(item);
		if (!imageGenerationCall || imageGenerationCallIds.has(imageGenerationCall.id)) return;
		imageGenerationCallIds.add(imageGenerationCall.id);
		pushResponseBlock({
			type: "image_generation_call",
			item: imageGenerationCall,
		}, outputIndex);
	};

	const appendNativeCompaction = (item: unknown, outputIndex: number): void => {
		if (!item || typeof item !== "object") return;
		const type = (item as { type?: unknown }).type;
		if (type !== "compaction" && type !== "context_compaction") return;
		const signature = JSON.stringify(item);
		if (nativeCompactionSignatures.has(signature)) return;
		nativeCompactionSignatures.add(signature);
		pushResponseBlock({
			type: "thinking",
			thinking: "",
			thinkingSignature: signature,
			redacted: true,
		} as AssistantMessage["content"][number], outputIndex);
	};

	return { blockIndex, outputStates, webSearchCitationSources, historicalCitationSources, registerWebSearchCitationSources, pushResponseBlock, normalizeResponseBlockOrder, customItemId, findCustomToolCallState, appendImageGenerationCall, appendNativeCompaction };
}
