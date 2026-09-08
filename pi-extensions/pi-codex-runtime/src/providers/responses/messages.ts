import { type Api, type Context, type Model } from "@earendil-works/pi-ai";
import { type ResponseInput } from "openai/resources/responses/responses.js";
import { transformMessages } from "./history.js";
import { isImageGenerationCallBlock, sanitizeImageGenerationCallItem } from "./items.js";
import { decodeWebSearchActivityTextSignature, isWebSearchActivityTextSignature, parseTextSignature } from "./signatures.js";
import { sanitizeSurrogates, shortHash } from "./text.js";
import { wireToolIdentity } from "./tool-identity.js";
import { type ConvertResponsesMessagesOptions, type InternalAssistantContent, type Message } from "./types.js";

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];
	const normalizeIdPart = (part: string) => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};
	const buildForeignResponsesItemId = (itemId: string, prefix: "fc_" | "ctc_") => {
		const normalized = `${prefix}${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};
	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: Extract<Message, { role: "assistant" }>) => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		const itemPrefix = itemId?.startsWith("ctc_") ? "ctc_" : "fc_";
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId ?? "", itemPrefix) : normalizeIdPart(itemId ?? "");
		if (!normalizedItemId.startsWith(itemPrefix)) normalizedItemId = normalizeIdPart(`${itemPrefix}${normalizedItemId}`);
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model as Model<Api>, normalizeToolCallId as never);
	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	if (includeSystemPrompt && context.systemPrompt) {
		messages.push({ role: model.reasoning ? "developer" : "system", content: sanitizeSurrogates(context.systemPrompt) });
	}

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({ role: "user", content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }] });
			} else {
				const content = msg.content.map((item) =>
					item.type === "text"
						? { type: "input_text" as const, text: sanitizeSurrogates(item.text) }
						: { type: "input_image" as const, detail: "auto" as const, image_url: `data:${item.mimeType};base64,${item.data}` },
				);
				if (content.length > 0) messages.push({ role: "user", content });
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const isSameModel = msg.model === model.id && msg.provider === model.provider && msg.api === model.api;
			const isDifferentModel = msg.model !== model.id && msg.provider === model.provider && msg.api === model.api;
			let assistantBlockIndex = 0;
			for (const block of msg.content as InternalAssistantContent[]) {
				if (isImageGenerationCallBlock(block)) {
					const imageGenerationCall = sanitizeImageGenerationCallItem(block.item);
					if (imageGenerationCall) output.push(imageGenerationCall as ResponseInput[number]);
				} else if (block.type === "thinking") {
					if (block.thinkingSignature) output.push(JSON.parse(block.thinkingSignature));
				} else if (block.type === "text") {
					if (isWebSearchActivityTextSignature(block.textSignature)) {
						const webSearchItem = isSameModel
							? decodeWebSearchActivityTextSignature(block.textSignature)
							: undefined;
						if (webSearchItem) output.push(webSearchItem as unknown as ResponseInput[number]);
						continue;
					}
					const parsedSignature = parseTextSignature(block.textSignature);
					if (isSameModel && parsedSignature?.item) {
						output.push(parsedSignature.item as ResponseInput[number]);
						assistantBlockIndex++;
						continue;
					}
					let msgId = parsedSignature?.id ?? `msg_${msgIndex}_${assistantBlockIndex}`;
					if (msgId.length > 64) msgId = `msg_${shortHash(msgId)}`;
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
						status: "completed",
						id: msgId,
						...(parsedSignature?.phase ? { phase: parsedSignature.phase } : {}),
					});
					assistantBlockIndex++;
				} else if (block.type === "toolCall") {
					const [callId, itemIdRaw] = block.id.split("|");
					const custom = itemIdRaw?.startsWith("ctc_") === true;
					let itemId: string | undefined = itemIdRaw;
					if (isDifferentModel && (itemId?.startsWith("fc_") || itemId?.startsWith("ctc_"))) itemId = undefined;
					const wireIdentity = wireToolIdentity(block.name, block.thoughtSignature);
					if (custom) {
						output.push({
							type: "custom_tool_call",
							...(itemId ? { id: itemId } : {}),
							call_id: callId,
							name: wireIdentity.name,
							...(wireIdentity.namespace ? { namespace: wireIdentity.namespace } : {}),
							input: typeof block.arguments.input === "string" ? block.arguments.input : "",
						} as ResponseInput[number]);
					} else {
						output.push({
							type: "function_call",
							...(itemId ? { id: itemId } : {}),
							call_id: callId,
							name: wireIdentity.name,
							...(wireIdentity.namespace ? { namespace: wireIdentity.namespace } : {}),
							arguments: JSON.stringify(block.arguments),
						} as ResponseInput[number]);
					}
				}
			}
			if (output.length > 0) messages.push(...output);
		} else if (msg.role === "toolResult") {
			const textResult = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
			const hasImages = msg.content.some((c) => c.type === "image");
			const hasText = textResult.length > 0;
			const [callId, itemId] = msg.toolCallId.split("|");
			const supportsToolResultImages = hasImages && model.input.includes("image");
			let originalCallUsesContentItems = false;
			for (let index = msgIndex - 1; index >= 0; index--) {
				const previous = context.messages[index];
				if (previous?.role !== "assistant") continue;
				const originalCall = previous.content.find((block) =>
					block.type === "toolCall" && block.id.split("|")[0] === callId);
				if (originalCall?.type === "toolCall") {
					originalCallUsesContentItems = wireToolIdentity(
						originalCall.name,
						originalCall.thoughtSignature,
					).namespace === "web";
					break;
				}
			}
			const usesContentItems = supportsToolResultImages || originalCallUsesContentItems;
			const output = usesContentItems
				? [
						...(hasText ? [{ type: "input_text" as const, text: sanitizeSurrogates(textResult) }] : []),
						...(supportsToolResultImages
							? msg.content
									.filter((block) => block.type === "image")
									.map((block) => ({
										type: "input_image" as const,
										detail: "auto" as const,
										image_url: `data:${block.mimeType};base64,${block.data}`,
									}))
							: []),
						...(!hasText && !supportsToolResultImages
							? [{ type: "input_text" as const, text: "(see attached image)" }]
							: []),
					]
				: sanitizeSurrogates(hasText ? textResult : "(see attached image)");
			messages.push({
				type: itemId?.startsWith("ctc_") ? "custom_tool_call_output" : "function_call_output",
				call_id: callId,
				output,
			} as ResponseInput[number]);
		}
		msgIndex++;
	}

	return messages;
}
