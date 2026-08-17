export const MUTATION_TOOL_GROUP = "$mutation";

const TOOL_GROUP_PREFIX = "$";
const MUTATION_TOOL_CANDIDATES = ["apply_patch", "edit", "write"] as const;

export interface ToolPolicyOptions {
	requested: readonly string[] | undefined;
	mandatory?: readonly string[];
	denied?: readonly string[];
}

export interface ResolvedToolPolicy {
	activeTools: string[];
	resolvedRequestedTools?: string[];
}

function unique(values: Iterable<string>): string[] {
	return [...new Set(values)];
}

export function assertSupportedToolReferences(tools: readonly string[], field = "tools"): void {
	const unsupported = tools.find(
		(tool) => tool.startsWith(TOOL_GROUP_PREFIX) && tool !== MUTATION_TOOL_GROUP,
	);
	if (unsupported) {
		throw new Error(
			`${field} contains unsupported logical tool "${unsupported}"; supported logical tools: ${MUTATION_TOOL_GROUP}`,
		);
	}
}

/**
 * Build Pi's hard tool registry ceiling before child extensions initialize.
 *
 * Logical groups expand to every implementation that an extension may choose.
 * The post-initialization resolver narrows this ceiling to the implementation
 * that the selected model and its extensions actually left active.
 */
export function buildToolCeiling(options: ToolPolicyOptions): string[] | undefined {
	if (options.requested === undefined) return undefined;
	assertSupportedToolReferences(options.requested);

	const denied = new Set(options.denied ?? []);
	const requestedDenied = options.requested.find((tool) => denied.has(tool));
	if (requestedDenied) {
		throw new Error(`tool "${requestedDenied}" is unavailable in this subagent mode`);
	}

	const ceiling: string[] = [];
	for (const tool of options.requested) {
		if (tool === MUTATION_TOOL_GROUP) {
			ceiling.push(...MUTATION_TOOL_CANDIDATES.filter((candidate) => !denied.has(candidate)));
		} else if (!denied.has(tool)) {
			ceiling.push(tool);
		}
	}
	for (const tool of options.mandatory ?? []) {
		if (!denied.has(tool)) ceiling.push(tool);
	}
	return unique(ceiling);
}

function resolveMutationTools(registered: Set<string>, active: Set<string>): string[] {
	if (registered.has("apply_patch") && active.has("apply_patch")) return ["apply_patch"];
	const native = MUTATION_TOOL_CANDIDATES
		.filter((tool) => tool !== "apply_patch")
		.filter((tool) => registered.has(tool) && active.has(tool));
	if (native.length > 0) return native;
	throw new Error(
		`${MUTATION_TOOL_GROUP} has no active implementation; apply_patch, edit, and write are unavailable for the selected model and child extensions`,
	);
}

/**
 * Apply the agent policy after extension `session_start` handlers have selected
 * model-specific tools. Explicit names may narrow that selection but never
 * reactivate a tool that an extension left inactive.
 */
export function resolveToolPolicy(
	options: ToolPolicyOptions & {
		registered: readonly string[];
		active: readonly string[];
	},
): ResolvedToolPolicy {
	assertSupportedToolReferences(options.requested ?? []);
	const registered = new Set(options.registered);
	const active = new Set(options.active);
	const mandatory = unique(options.mandatory ?? []);
	const mandatorySet = new Set(mandatory);
	const denied = new Set(options.denied ?? []);

	for (const tool of mandatory) {
		if (denied.has(tool)) throw new Error(`mandatory tool "${tool}" is denied by the runtime`);
		if (!registered.has(tool)) throw new Error(`mandatory tool "${tool}" is not registered`);
	}

	if (options.requested === undefined) {
		const selected = options.active.filter((tool) => !denied.has(tool));
		for (const tool of mandatory) {
			if (!selected.includes(tool)) selected.push(tool);
		}
		return { activeTools: unique(selected) };
	}

	const resolvedRequestedTools: string[] = [];
	for (const tool of options.requested) {
		if (denied.has(tool)) throw new Error(`tool "${tool}" is unavailable in this subagent mode`);
		if (tool === MUTATION_TOOL_GROUP) {
			resolvedRequestedTools.push(...resolveMutationTools(registered, active));
			continue;
		}
		if (!registered.has(tool)) {
			throw new Error(`requested tool "${tool}" is not registered by Pi or a loaded child extension`);
		}
		if (!active.has(tool) && !mandatorySet.has(tool)) {
			throw new Error(
				`requested tool "${tool}" is inactive for the selected model or child extension policy`,
			);
		}
		resolvedRequestedTools.push(tool);
	}

	const selected = unique(resolvedRequestedTools.filter((tool) => !denied.has(tool)));
	for (const tool of mandatory) {
		if (!selected.includes(tool)) selected.push(tool);
	}
	return {
		activeTools: selected,
		resolvedRequestedTools: unique(resolvedRequestedTools),
	};
}
