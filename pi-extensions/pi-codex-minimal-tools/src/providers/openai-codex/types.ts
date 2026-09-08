import { type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { type ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { type CodexRequestIdentity } from "../../codex-wire-identity.js";

export interface WebSocketLike {
	readyState?: number;
	bufferedAmount?: number;
	send(data: string, callback?: (error?: Error) => void): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: (event: unknown) => void): void;
	removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface SessionWebSocketCacheEntry {
	socket: WebSocketLike;
	busy: boolean;
	waiters: WebSocketAcquireWaiter[];
	idleTimer?: ReturnType<typeof setTimeout>;
	continuation?: CachedWebSocketContinuationState;
}

export interface WebSocketAcquireWaiter {
	resolve: (acquired: AcquiredWebSocket) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export interface AcquiredWebSocket {
	socket: WebSocketLike;
	entry?: SessionWebSocketCacheEntry;
	reused: boolean;
	release: (options?: { keep?: boolean }) => void;
}

export interface CachedWebSocketContinuationState {
	lastRequestBody: ResponsesBody;
	lastResponseId: string;
	lastResponseItems: unknown[];
}

export interface WebSocketPrewarmRequest {
	url: string;
	headers: Headers;
	cacheKey: string;
	body: ResponsesBody;
	requestMetadata: WebSocketRequestMetadata;
	signal?: AbortSignal;
	connectTimeoutMs?: number;
}

export interface WebSocketRequestMetadata {
	/** Legacy Pi session lookup key used by exported test helpers. */
	sessionId?: string;
	threadId?: string;
	turnId: string;
	requestKind?: "turn" | "compaction" | "prewarm";
	identity?: CodexRequestIdentity;
}

export interface OpenAIResponsesProviderController {
	getCurrentTurnId(sessionId: string | undefined): string | undefined;
	getRequestIdentity?(
		sessionId: string | undefined,
		requestKind?: CodexRequestIdentity["requestKind"],
	): CodexRequestIdentity | undefined;
}

export interface ResponsesBody {
	model: string;
	store: boolean;
	stream: boolean;
	instructions?: string;
	previous_response_id?: string;
	input: unknown[];
	text: { verbosity: string };
	include: string[];
	prompt_cache_key?: string;
	tool_choice: "auto";
	parallel_tool_calls: boolean;
	temperature?: number;
	service_tier?: string;
	generate?: boolean;
	tools?: unknown[];
	reasoning?: {
		effort?: string;
		summary?: string;
		context?: "all_turns";
	};
	client_metadata?: Record<string, string>;
	[key: string]: unknown;
}

interface ResponseEnvelope {
	id?: string;
	status?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
		input_tokens_details?: { cached_tokens?: number };
	};
	service_tier?: string;
	error?: { message?: string };
	[key: string]: unknown;
}

export type ServiceTier = ResponseCreateParamsStreaming["service_tier"];

export type ProviderTransport = NonNullable<SimpleStreamOptions["transport"]>;

export interface NodeWebSocketModule {
	WebSocket: new (url: string, options?: Record<string, unknown>) => {
		readyState: number;
		bufferedAmount: number;
		send(data: string, callback?: (error?: Error) => void): void;
		close(code?: number, reason?: string): void;
		terminate?(): void;
		on(type: string, listener: (...args: any[]) => void): void;
		off(type: string, listener: (...args: any[]) => void): void;
	};
}

export interface StreamEventShape {
	type?: string;
	status?: number;
	status_code?: number;
	sequence_number?: number;
	error?: {
		type?: string;
		message?: string;
		code?: string;
		plan_type?: string;
		resets_at?: number;
		[key: string]: unknown;
	};
	response?: ResponseEnvelope;
	item_id?: string;
	output_index?: number;
	item?: {
		id?: string;
		type?: string;
		result?: string | null;
		output_format?: string;
		revised_prompt?: string;
		status?: string;
		[key: string]: unknown;
	};
	code?: string;
	message?: string;
	[key: string]: unknown;
}
