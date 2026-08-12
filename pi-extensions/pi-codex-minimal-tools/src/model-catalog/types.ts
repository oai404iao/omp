export type ResponsesEndpoint = "auto" | "openai" | "codex";
export type ResponsesMode = "standard" | "lite";
export type ResponsesTransport = "sse" | "websocket" | "websocket-cached" | "auto";
export type SystemPromptPlacement = "instructions" | "developer";
export type PatchTransport = "function" | "custom";
export type WebSearchContentType = "text" | "image";
export type NativeCompactionMode = "pi" | "responses" | "responses-compact";

export interface ModelIdentityLike {
	provider?: string;
	id?: string;
	name?: string;
	api?: string;
}

export interface ResponsesProfilePatch {
	providerShim?: boolean;
	endpoint?: ResponsesEndpoint;
	mode?: ResponsesMode;
	systemPromptPlacement?: SystemPromptPlacement;
	transport?: ResponsesTransport;
	websocketPrewarm?: boolean;
}

export interface WebSearchProfile {
	implementation: "hosted" | "standalone";
	contentTypes?: WebSearchContentType[];
}

export interface ModelToolsProfilePatch {
	parallelCalls?: boolean;
	applyPatch?: false | PatchTransport;
	webSearch?: false | WebSearchProfile;
	imageGeneration?: false | "hosted" | "standalone";
	viewImage?: boolean;
}

export interface FastModeProfile {
	serviceTier: string;
	costMultiplier?: number;
}

export interface ModelProfilePatch {
	id: string;
	extends?: string;
	enabled?: boolean;
	responses?: ResponsesProfilePatch;
	tools?: ModelToolsProfilePatch;
	compaction?: NativeCompactionMode;
	fast?: false | FastModeProfile;
}

export interface ModelCatalogFile {
	$schema?: string;
	version: 1;
	models: ModelProfilePatch[];
}

export interface EffectiveResponsesProfile {
	providerShim: boolean;
	endpoint: ResponsesEndpoint;
	mode: ResponsesMode;
	systemPromptPlacement: SystemPromptPlacement;
	transport: ResponsesTransport;
	websocketPrewarm: boolean;
}

export interface EffectiveModelToolsProfile {
	parallelCalls: boolean;
	applyPatch: false | PatchTransport;
	webSearch: false | WebSearchProfile;
	imageGeneration: false | "hosted" | "standalone";
	viewImage: boolean;
}

export interface EffectiveModelProfile {
	enabled: boolean;
	responses: EffectiveResponsesProfile;
	tools: EffectiveModelToolsProfile;
	compaction: NativeCompactionMode;
	fast: false | FastModeProfile;
}

export type ModelProfileSource = "bundled" | "user" | "legacy";

export interface ResolvedModelProfile {
	id: string;
	sources: ModelProfileSource[];
	profileHash: string;
	effective: EffectiveModelProfile;
	diagnostics: string[];
}
