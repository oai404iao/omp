const TOOL_NAMESPACE_SIGNATURE_PREFIX = "pi:codex-tool-namespace:";

export function encodeToolNamespaceSignature(namespace: unknown, name: string): string | undefined {
	if (typeof namespace !== "string" || !namespace) return undefined;
	return `${TOOL_NAMESPACE_SIGNATURE_PREFIX}${JSON.stringify({ namespace, name })}`;
}

export function wireToolIdentity(
	name: string,
	thoughtSignature: string | undefined,
): { name: string; namespace?: string } {
	if (!thoughtSignature?.startsWith(TOOL_NAMESPACE_SIGNATURE_PREFIX)) return { name };
	try {
		const value = JSON.parse(thoughtSignature.slice(TOOL_NAMESPACE_SIGNATURE_PREFIX.length)) as {
			namespace?: unknown;
			name?: unknown;
		};
		if (typeof value.namespace === "string" && value.namespace && typeof value.name === "string" && value.name) {
			return { namespace: value.namespace, name: value.name };
		}
	} catch {
		// Ignore malformed local metadata and replay the Pi-visible tool name.
	}
	return { name };
}
