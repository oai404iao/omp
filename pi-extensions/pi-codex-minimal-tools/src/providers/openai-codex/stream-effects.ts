import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { StreamEventShape } from "./types.js";

export interface ProviderEventContext {
	cwd: string;
	requestPrompt?: string;
	signal?: AbortSignal;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
}

/**
 * A fresh observer is created for each response attempt. Events are normalized
 * and continuation items captured before observation; observation is awaited
 * before replay parsing. Observers must not mutate wire items or consume events.
 * Optional effects own their failure policy; uncaught errors fail the stream.
 */
export interface ProviderStreamEffects {
	createEventObserver?: (context: ProviderEventContext) =>
		(event: StreamEventShape) => void | Promise<void>;
}
