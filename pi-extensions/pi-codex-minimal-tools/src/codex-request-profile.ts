export interface CodexRequestProfile {
	responsesMode: "standard" | "lite";
	patchTransport: "function" | "custom";
	supportsHostedTools: boolean;
	supportsParallelTools: boolean;
}

/**
 * Only modes implemented by the current provider shim are configurable.
 * Lite and custom transport will be added with their complete wire parsers.
 */
export interface CodexRequestProfileOverride {
	responsesMode?: "standard";
	patchTransport?: "function";
	supportsHostedTools?: boolean;
	supportsParallelTools?: boolean;
}

export const DEFAULT_CODEX_REQUEST_PROFILE: CodexRequestProfile = {
	responsesMode: "standard",
	patchTransport: "function",
	supportsHostedTools: true,
	supportsParallelTools: true,
};

export function resolveCodexRequestProfile(override: CodexRequestProfileOverride = {}): CodexRequestProfile {
	return {
		responsesMode: override.responsesMode ?? DEFAULT_CODEX_REQUEST_PROFILE.responsesMode,
		patchTransport: override.patchTransport ?? DEFAULT_CODEX_REQUEST_PROFILE.patchTransport,
		supportsHostedTools: override.supportsHostedTools ?? DEFAULT_CODEX_REQUEST_PROFILE.supportsHostedTools,
		supportsParallelTools: override.supportsParallelTools ?? DEFAULT_CODEX_REQUEST_PROFILE.supportsParallelTools,
	};
}