import { type CodexRequestProfile } from "../../codex-request-profile.js";
import { WS_RESPONSES_LITE_CLIENT_METADATA_KEY } from "./constants.js";

export function stripResponsesLiteImageDetails(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) stripResponsesLiteImageDetails(item);
		return;
	}
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (record.type === "input_image") delete record.detail;
	for (const entry of Object.values(record)) stripResponsesLiteImageDetails(entry);
}

export function withResponsesLiteWebSocketMetadata<T extends { client_metadata?: Record<string, string> }>(body: T, responsesMode: CodexRequestProfile["responsesMode"]): T {
	if (responsesMode !== "lite") return body;
	return {
		...body,
		client_metadata: {
			...body.client_metadata,
			[WS_RESPONSES_LITE_CLIENT_METADATA_KEY]: "true",
		},
	};
}
