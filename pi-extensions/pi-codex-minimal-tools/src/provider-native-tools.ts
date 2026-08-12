export interface NativeToolRewriteResult<T = unknown> {
	payload: T;
	rewritten: string[];
}

export interface NativeToolRewriteOptions {
	imageModel?: string;
	imageGeneration?: boolean | "hosted" | "standalone";
	webSearch?: boolean | {
		implementation?: "hosted" | "standalone";
		contentTypes?: readonly ("text" | "image")[];
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolName(tool: Record<string, unknown>): string | undefined {
	if (typeof tool.name === "string") return tool.name;
	const nested = isRecord(tool.function) ? tool.function : undefined;
	return typeof nested?.name === "string" ? nested.name : undefined;
}

function imageToolConfig(tool: Record<string, unknown>, options: NativeToolRewriteOptions): Record<string, unknown> {
	const parameters = isRecord(tool.parameters) ? tool.parameters : isRecord(isRecord(tool.function) ? tool.function.parameters : undefined) ? (tool.function as Record<string, unknown>).parameters as Record<string, unknown> : {};
	const config: Record<string, unknown> = { type: "image_generation" };
	if (typeof options.imageModel === "string" && options.imageModel.trim()) config.model = options.imageModel.trim();
	for (const key of ["size", "quality", "background", "output_format"]) {
		const value = parameters[key];
		if (typeof value === "string") config[key] = value;
	}
	if (!config.output_format) config.output_format = "png";
	if (!config.action) config.action = "auto";
	return config;
}

function functionToolConfig(
	tool: Record<string, unknown>,
	name: string,
): Record<string, unknown> {
	const nested = isRecord(tool.function) ? tool.function : undefined;
	return {
		type: "function",
		name,
		description: typeof tool.description === "string"
			? tool.description
			: typeof nested?.description === "string"
				? nested.description
				: "",
		parameters: isRecord(tool.parameters)
			? tool.parameters
			: isRecord(nested?.parameters)
				? nested.parameters
				: { type: "object", properties: {} },
		strict: typeof tool.strict === "boolean"
			? tool.strict
			: typeof nested?.strict === "boolean"
				? nested.strict
				: false,
	};
}

function namespaceTool(
	namespace: string,
	name: string,
	tool: Record<string, unknown>,
): Record<string, unknown> {
	return {
		type: "namespace",
		name: namespace,
		description: `Tools in the ${namespace} namespace.`,
		tools: [functionToolConfig(tool, name)],
	};
}

export function rewriteNativeOpenAiTools<T>(payload: T, options: NativeToolRewriteOptions = {}): NativeToolRewriteResult<T> {
	if (!isRecord(payload) || !Array.isArray(payload.tools)) return { payload, rewritten: [] };
	const rewritten: string[] = [];
	const tools = payload.tools.map((candidate) => {
		if (!isRecord(candidate)) return candidate;
		const name = toolName(candidate);
		if (name === "image_generation" && options.imageGeneration !== false) {
			rewritten.push(name);
			if (options.imageGeneration === "standalone") {
				return namespaceTool("image_gen", "imagegen", candidate);
			}
			return imageToolConfig(candidate, options);
		}
		if (name === "web_search" && options.webSearch) {
			rewritten.push(name);
			if (typeof options.webSearch === "object" && options.webSearch.implementation === "standalone") {
				return namespaceTool("web", "run", candidate);
			}
			const contentTypes = typeof options.webSearch === "object"
				? options.webSearch.contentTypes
				: undefined;
			return {
				type: "web_search",
				...(contentTypes && contentTypes.length > 0
					? { search_content_types: [...contentTypes] }
					: {}),
			};
		}
		return candidate;
	});
	return { payload: { ...payload, tools } as T, rewritten };
}
