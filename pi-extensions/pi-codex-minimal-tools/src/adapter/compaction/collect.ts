import { NonRetryableProviderError } from "../../providers/openai-codex/errors.js";
import { mapCodexEvents } from "../../providers/openai-codex/events.js";
import { parseSSE } from "../../providers/openai-codex/sse.js";
import { type StreamEventShape } from "../../providers/openai-codex/types.js";
import { isNativeCompactionItem } from "./checkpoint.js";

interface CodexCompactionStreamResult {
	item: unknown;
	responseId?: string;
	responseItems: unknown[];
}

export async function collectCodexCompactionStream(
	events: AsyncIterable<StreamEventShape>,
): Promise<CodexCompactionStreamResult> {
	let outputItemCount = 0;
	const compacted: unknown[] = [];
	const responseItems: unknown[] = [];
	let responseId: string | undefined;
	for await (const event of events) {
		if (event.type === "response.created" && event.response?.id) {
			responseId = event.response.id;
		}
		if (event.type === "response.output_item.done" && event.item) {
			outputItemCount++;
			responseItems.push(event.item);
			if (isNativeCompactionItem(event.item)) compacted.push(event.item);
		}
		if (
			(event.type === "response.completed" || event.type === "response.incomplete")
			&& event.response?.id
		) {
			responseId = event.response.id;
		}
	}
	if (compacted.length !== 1) {
		throw new NonRetryableProviderError(
			`OpenAI compaction trigger expected exactly one compaction item, received ${compacted.length} from ${outputItemCount} output items`,
		);
	}
	return {
		item: compacted[0],
		...(responseId ? { responseId } : {}),
		responseItems,
	};
}

export async function collectCodexCompactionOutput(response: Response, sessionKey?: string): Promise<unknown> {
	const result = await collectCodexCompactionStream(mapCodexEvents(parseSSE(response), sessionKey));
	return result.item;
}
