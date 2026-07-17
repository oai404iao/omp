export interface CodexRequestProfile {
	responsesMode: "standard" | "lite";
	systemPromptPlacement: "instructions" | "developer";
	patchTransport: "function" | "custom";
	supportsHostedTools: boolean;
	supportsParallelTools: boolean;
}

/**
 * Only modes implemented by the current provider shim are configurable.
 * Custom transport remains unavailable until its complete wire parser lands.
 */
export interface CodexRequestProfileOverride {
	responsesMode?: "standard" | "lite";
	systemPromptPlacement?: "instructions" | "developer";
	patchTransport?: "function" | "custom";
	supportsHostedTools?: boolean;
	supportsParallelTools?: boolean;
}

export const DEFAULT_CODEX_REQUEST_PROFILE: CodexRequestProfile = {
	responsesMode: "standard",
	systemPromptPlacement: "instructions",
	patchTransport: "function",
	supportsHostedTools: true,
	supportsParallelTools: true,
};

export function resolveCodexRequestProfile(override: CodexRequestProfileOverride = {}): CodexRequestProfile {
	const responsesMode = override.responsesMode ?? DEFAULT_CODEX_REQUEST_PROFILE.responsesMode;
	return {
		responsesMode,
		systemPromptPlacement: responsesMode === "lite" ? "developer" : override.systemPromptPlacement ?? DEFAULT_CODEX_REQUEST_PROFILE.systemPromptPlacement,
		patchTransport: override.patchTransport ?? DEFAULT_CODEX_REQUEST_PROFILE.patchTransport,
		supportsHostedTools: responsesMode === "lite" ? false : override.supportsHostedTools ?? DEFAULT_CODEX_REQUEST_PROFILE.supportsHostedTools,
		supportsParallelTools: responsesMode === "lite" ? false : override.supportsParallelTools ?? DEFAULT_CODEX_REQUEST_PROFILE.supportsParallelTools,
	};
}
