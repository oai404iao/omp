import { type Api, type AssistantMessage, type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { type ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { backfillReasoningSignatures, encodeTextSignature } from "./signatures.js";
import { createResponsesStreamState } from "./stream-state.js";
import { createResponseTextRenderer } from "./text-renderer.js";
import { localToolName, parseStreamingJson } from "./text.js";
import { encodeToolNamespaceSignature } from "./tool-identity.js";
import type { CustomToolCallState, TextBlock, ThinkingBlock, ToolCallBlock } from "./types.js";
import { customArguments, updateCustomInput } from "./grammar.js";
import { type OpenAIResponsesStreamOptions } from "./types.js";
import { finalizeResponseUsage } from "./usage.js";

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	const { blockIndex, outputStates, webSearchCitationSources, historicalCitationSources, registerWebSearchCitationSources, pushResponseBlock, normalizeResponseBlockOrder, customItemId, findCustomToolCallState, appendImageGenerationCall, appendNativeCompaction } = createResponsesStreamState(output, options);
	const { renderMessageText } = createResponseTextRenderer(webSearchCitationSources, historicalCitationSources);

	let sawTerminalResponseEvent = false;

	const renderReasoningSummary = (summaryParts: Map<number, { text: string }>): string =>
		Array.from(summaryParts.entries())
			.sort(([a], [b]) => a - b)
			.map(([, part]) => part.text)
			.join("\n\n");

	const emitAppendedDelta = (
		eventType: "thinking_delta" | "text_delta",
		contentIndex: number,
		previous: string,
		next: string,
	) => {
		if (next.startsWith(previous)) {
			const delta = next.slice(previous.length);
			if (delta.length > 0) {
				stream.push({ type: eventType, contentIndex, delta, partial: output });
			}
		}
	};

	for await (const event of openaiStream) {
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			const item = event.item;
			const customItem = item as unknown as { type?: string; id?: string; call_id?: string; name?: string; namespace?: string; input?: string };
			if (item.type === "reasoning") {
				const currentBlock: ThinkingBlock = pushResponseBlock(
					{ type: "thinking", thinking: "" },
					event.output_index,
				);
				outputStates.set(event.output_index, {
					kind: "reasoning",
					blockIndex: blockIndex(),
					block: currentBlock,
					summaryParts: new Map(),
				});
				stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "message") {
				const currentBlock: TextBlock = pushResponseBlock(
					{ type: "text", text: "" },
					event.output_index,
				);
				outputStates.set(event.output_index, {
					kind: "message",
					blockIndex: blockIndex(),
					block: currentBlock,
					parts: new Map(),
				});
				stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "function_call") {
				const namespace = (item as { namespace?: unknown }).namespace;
				const thoughtSignature = encodeToolNamespaceSignature(namespace, item.name);
				const currentBlock: ToolCallBlock = {
					type: "toolCall",
					id: `${item.call_id}|${item.id}`,
					name: localToolName(namespace, item.name),
					arguments: {},
					...(thoughtSignature ? { thoughtSignature } : {}),
					partialJson: item.arguments || "",
				};
				pushResponseBlock(currentBlock, event.output_index);
				outputStates.set(event.output_index, {
					kind: "function_call",
					blockIndex: blockIndex(),
					block: currentBlock,
				});
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
			} else if (customItem.type === "custom_tool_call" && customItem.call_id && customItem.name) {
				const itemId = customItemId(customItem.id, customItem.call_id);
				const input = customItem.input ?? "";
				const thoughtSignature = encodeToolNamespaceSignature(customItem.namespace, customItem.name);
				const currentBlock: ToolCallBlock = {
					type: "toolCall",
					id: `${customItem.call_id}|${itemId}`,
					name: localToolName(customItem.namespace, customItem.name),
					arguments: customArguments(localToolName(customItem.namespace, customItem.name), input, options),
					...(thoughtSignature ? { thoughtSignature } : {}),
					partialInput: input,
				};
				pushResponseBlock(currentBlock, event.output_index);
				const state: CustomToolCallState = {
					kind: "custom_tool_call",
					blockIndex: blockIndex(),
					block: currentBlock,
					itemId,
					sourceItemId: customItem.id,
					callId: customItem.call_id,
					input,
				};
				outputStates.set(event.output_index, state);
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
				if (options?.grammarToolInputProperties?.has(currentBlock.name)) updateCustomInput(state, input, false, output, stream, options);
			}
		} else if (event.type === "response.reasoning_summary_part.added") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "reasoning") {
				state.summaryParts.set(event.summary_index, { text: event.part.text });
			}
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "reasoning") {
				const summaryPart = state.summaryParts.get(event.summary_index) ?? { text: "" };
				summaryPart.text += event.delta;
				state.summaryParts.set(event.summary_index, summaryPart);
				const previousThinking = state.block.thinking;
				const nextThinking = renderReasoningSummary(state.summaryParts);
				state.block.thinking = nextThinking;
				emitAppendedDelta("thinking_delta", state.blockIndex, previousThinking, nextThinking);
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "reasoning") {
				state.summaryParts.set(event.summary_index, { text: event.part.text });
				state.block.thinking = renderReasoningSummary(state.summaryParts);
			}
		} else if (event.type === "response.reasoning_text.delta") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "reasoning") {
				state.block.thinking += event.delta;
				stream.push({ type: "thinking_delta", contentIndex: state.blockIndex, delta: event.delta, partial: output });
			}
		} else if (event.type === "response.content_part.added") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "message" && (event.part.type === "output_text" || event.part.type === "refusal")) {
				const annotations = event.part.type === "output_text" && Array.isArray((event.part as { annotations?: unknown }).annotations)
					? (event.part as { annotations: unknown[] }).annotations
					: undefined;
				state.parts.set(event.content_index, {
					type: event.part.type,
					text: event.part.type === "output_text" ? event.part.text : event.part.refusal,
					...(annotations ? { annotations } : {}),
				});
			}
		} else if ((event as { type?: string }).type === "response.output_text.annotation.added") {
			const annotationEvent = event as unknown as { output_index: number; content_index: number; annotation?: unknown };
			const state = outputStates.get(annotationEvent.output_index);
			if (state?.kind === "message") {
				const messagePart = state.parts.get(annotationEvent.content_index) ?? { type: "output_text" as const, text: "", annotations: [] };
				if (messagePart.type === "output_text" && annotationEvent.annotation) {
					messagePart.annotations = [...(messagePart.annotations ?? []), annotationEvent.annotation];
					state.parts.set(annotationEvent.content_index, messagePart);
				}
			}
		} else if (event.type === "response.output_text.delta") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "message") {
				const messagePart = state.parts.get(event.content_index) ?? { type: "output_text" as const, text: "" };
				if (messagePart.type === "output_text") {
					messagePart.text += event.delta;
					state.parts.set(event.content_index, messagePart);
					const previousText = state.block.text;
					const nextText = renderMessageText(state.parts);
					state.block.text = nextText;
					emitAppendedDelta("text_delta", state.blockIndex, previousText, nextText);
				}
			}
		} else if (event.type === "response.refusal.delta") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "message") {
				const messagePart = state.parts.get(event.content_index) ?? { type: "refusal" as const, text: "" };
				if (messagePart.type === "refusal") {
					messagePart.text += event.delta;
					state.parts.set(event.content_index, messagePart);
					const previousText = state.block.text;
					const nextText = renderMessageText(state.parts);
					state.block.text = nextText;
					emitAppendedDelta("text_delta", state.blockIndex, previousText, nextText);
				}
			}
		} else if ((event as { type?: string }).type === "response.custom_tool_call_input.delta") {
			const customEvent = event as unknown as { output_index?: number; item_id?: string; call_id?: string; delta?: string };
			const state = findCustomToolCallState(customEvent);
			if (state && typeof customEvent.delta === "string") {
				updateCustomInput(state, state.input + customEvent.delta, false, output, stream, options);
			}
		} else if ((event as { type?: string }).type === "response.custom_tool_call_input.done") {
			const customEvent = event as unknown as { output_index?: number; item_id?: string; call_id?: string; input?: string };
			const state = findCustomToolCallState(customEvent);
			if (state && typeof customEvent.input === "string") updateCustomInput(state, customEvent.input, true, output, stream, options);
		} else if (event.type === "response.function_call_arguments.delta") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "function_call") {
				state.block.partialJson = (state.block.partialJson ?? "") + event.delta;
				state.block.arguments = parseStreamingJson(state.block.partialJson ?? "");
				stream.push({ type: "toolcall_delta", contentIndex: state.blockIndex, delta: event.delta, partial: output });
			}
		} else if (event.type === "response.function_call_arguments.done") {
			const state = outputStates.get(event.output_index);
			if (state?.kind === "function_call") {
				const previousPartialJson = state.block.partialJson ?? "";
				state.block.partialJson = event.arguments;
				state.block.arguments = parseStreamingJson(state.block.partialJson ?? "");
				if (event.arguments.startsWith(previousPartialJson)) {
					const delta = event.arguments.slice(previousPartialJson.length);
					if (delta.length > 0) {
						stream.push({ type: "toolcall_delta", contentIndex: state.blockIndex, delta, partial: output });
					}
				}
			}
		} else if (event.type === "response.output_item.done") {
			const item = event.item;
			const customItem = item as unknown as { type?: string; id?: string; call_id?: string; name?: string; namespace?: string; input?: string };
			if (item.type === "reasoning") {
				let state = outputStates.get(event.output_index);
				if (!state || state.kind !== "reasoning") {
					const currentBlock: ThinkingBlock = pushResponseBlock(
						{ type: "thinking", thinking: "" },
						event.output_index,
					);
					state = { kind: "reasoning", blockIndex: blockIndex(), block: currentBlock, summaryParts: new Map() };
					outputStates.set(event.output_index, state);
				}
				const summaryText = item.summary?.map((summary) => summary.text).join("\n\n") || "";
				const contentText = (item as { content?: Array<{ text?: string }> }).content?.map((content) => content.text ?? "").filter(Boolean).join("\n\n") || "";
				state.block.thinking = summaryText || contentText || state.block.thinking;
				state.block.thinkingSignature = JSON.stringify(item);
				stream.push({ type: "thinking_end", contentIndex: state.blockIndex, content: state.block.thinking, partial: output });
				outputStates.delete(event.output_index);
			} else if (item.type === "message") {
				let state = outputStates.get(event.output_index);
				if (!state || state.kind !== "message") {
					const currentBlock: TextBlock = pushResponseBlock(
						{ type: "text", text: "" },
						event.output_index,
					);
					state = { kind: "message", blockIndex: blockIndex(), block: currentBlock, parts: new Map() };
					outputStates.set(event.output_index, state);
				}
				// Null-tolerant like the reasoning branch above: OpenAI-compatible streams
				// (e.g. vLLM) can emit an empty message item with content: null before a
				// function_call. Without the guard, item.content.map throws and the stream
				// aborts, silently dropping the tool call (earendil-works/pi#5819).
				const finalContent = item.content ?? [];
				if (finalContent.length > 0) {
					state.parts.clear();
					for (let contentIndex = 0; contentIndex < finalContent.length; contentIndex++) {
						const content = finalContent[contentIndex]!;
						const annotations = content.type === "output_text" && Array.isArray((content as { annotations?: unknown }).annotations)
							? (content as { annotations: unknown[] }).annotations
							: undefined;
						state.parts.set(contentIndex, {
							type: content.type === "output_text" ? "output_text" : "refusal",
							text: content.type === "output_text" ? content.text : content.refusal,
							...(annotations ? { annotations } : {}),
						});
					}
				}
				state.block.text = renderMessageText(state.parts, true);
				state.block.textSignature = encodeTextSignature(item, state.block.text);
				stream.push({ type: "text_end", contentIndex: state.blockIndex, content: state.block.text, partial: output });
				outputStates.delete(event.output_index);
			} else if (item.type === "function_call") {
				const state = outputStates.get(event.output_index);
				const namespace = (item as { namespace?: unknown }).namespace;
				const thoughtSignature = encodeToolNamespaceSignature(namespace, item.name);
				const args = state?.kind === "function_call" && state.block.partialJson
					? parseStreamingJson(state.block.partialJson)
					: parseStreamingJson(item.arguments || "{}");
				const toolCall = state?.kind === "function_call"
					? (() => {
						state.block.arguments = args;
						state.block.name = localToolName(namespace, item.name);
						if (thoughtSignature) state.block.thoughtSignature = thoughtSignature;
						delete state.block.partialJson;
						return state.block;
					})()
					: (() => {
						const fallbackToolCall: ToolCallBlock = {
							type: "toolCall",
							id: `${item.call_id}|${item.id}`,
							name: localToolName((item as { namespace?: unknown }).namespace, item.name),
							arguments: args,
							...(thoughtSignature ? { thoughtSignature } : {}),
						};
						pushResponseBlock(fallbackToolCall, event.output_index);
						return fallbackToolCall;
					})();
				const toolCallIndex = state?.kind === "function_call" ? state.blockIndex : blockIndex();
				stream.push({ type: "toolcall_end", contentIndex: toolCallIndex, toolCall, partial: output });
				outputStates.delete(event.output_index);
			} else if (customItem.type === "custom_tool_call" && customItem.call_id && customItem.name) {
				const state = findCustomToolCallState({
					output_index: event.output_index,
					item_id: customItem.id,
					call_id: customItem.call_id,
				});
				const input = typeof customItem.input === "string" ? customItem.input : state?.input ?? "";
				const thoughtSignature = encodeToolNamespaceSignature(customItem.namespace, customItem.name);
				const toolCall = state
					? (() => {
						state.block.name = localToolName(customItem.namespace, customItem.name);
						updateCustomInput(state, input, true, output, stream, options);
						if (thoughtSignature) state.block.thoughtSignature = thoughtSignature;
						delete state.block.partialInput;
						return state.block;
					})()
					: (() => {
						const fallbackToolCall: ToolCallBlock = {
							type: "toolCall",
							id: `${customItem.call_id}|${customItemId(customItem.id, customItem.call_id)}`,
							name: localToolName(customItem.namespace, customItem.name),
							arguments: customArguments(localToolName(customItem.namespace, customItem.name), input, options),
							...(thoughtSignature ? { thoughtSignature } : {}),
						};
						pushResponseBlock(fallbackToolCall, event.output_index);
						return fallbackToolCall;
					})();
				const toolCallIndex = state?.blockIndex ?? blockIndex();
				stream.push({ type: "toolcall_end", contentIndex: toolCallIndex, toolCall, partial: output });
				outputStates.delete(event.output_index);
			} else if (item.type === "web_search_call") {
				registerWebSearchCitationSources(item);
				outputStates.delete(event.output_index);
			} else if (item.type === "image_generation_call") {
				appendImageGenerationCall(item, event.output_index);
				outputStates.delete(event.output_index);
			} else if (
				(item as { type?: unknown }).type === "compaction"
				|| (item as { type?: unknown }).type === "context_compaction"
			) {
				appendNativeCompaction(item, event.output_index);
				outputStates.delete(event.output_index);
			}
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			sawTerminalResponseEvent = true;
			const response = event.response;
			const finalOutput = Array.isArray((response as { output?: unknown } | undefined)?.output)
				? ((response as unknown as { output: unknown[] }).output)
				: [];
			backfillReasoningSignatures(output, finalOutput);
			for (let outputIndex = 0; outputIndex < finalOutput.length; outputIndex++) {
				const item = finalOutput[outputIndex];
				if ((item as { type?: unknown } | undefined)?.type === "web_search_call") {
					registerWebSearchCitationSources(item);
				}
				if ((item as { type?: unknown } | undefined)?.type === "image_generation_call") {
					appendImageGenerationCall(item, outputIndex);
				}
				appendNativeCompaction(item, outputIndex);
			}
			// Some Responses-compatible transports only include compaction in the
			// terminal output array. Preserve its authoritative output_index instead
			// of appending it after an already-streamed tool call.
			normalizeResponseBlockOrder();
			if (response?.id) output.responseId = response.id;
			finalizeResponseUsage(response, model, output, options);
		} else if (event.type === "error") {
			const details = [event.code, event.message].filter(Boolean).join(": ");
			throw new Error(details || "Unknown error");
		} else if (event.type === "response.failed") {
			sawTerminalResponseEvent = true;
			const error = event.response?.error;
			const details = (event.response as { incomplete_details?: { reason?: string } } | undefined)?.incomplete_details;
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(msg);
		}
	}
	if (!sawTerminalResponseEvent) {
		throw new Error("OpenAI Responses stream ended before a terminal response event");
	}
}
