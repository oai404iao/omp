export type ToolImplementation = "hosted" | "standalone";
export type EndpointCompaction = "responses" | "responses-compact";
export interface EndpointConfig {
	provider: string;
	baseUrl: string;
	webSearch?: ToolImplementation[];
	imageGeneration?: ToolImplementation[];
	compaction?: EndpointCompaction[];
}
export type EndpointCapability =
	| `webSearch.${ToolImplementation}` | `imageGeneration.${ToolImplementation}` | `compaction.${EndpointCompaction}`;
export interface EndpointIdentity { provider?: string; baseUrl?: string; id?: string }

export function endpointKey(model: EndpointIdentity): string | undefined {
	if (!model.provider || !model.baseUrl) return undefined;
	return JSON.stringify([model.provider, model.baseUrl.trim().replace(/\/+$/, "")]);
}

export function parseEndpointConfig(raw: unknown): { entries: EndpointConfig[]; diagnostics: string[] } {
	const entries: EndpointConfig[] = [];
	const diagnostics: string[] = [];
	if (raw === undefined) return { entries, diagnostics };
	if (!Array.isArray(raw)) return { entries, diagnostics: ["endpoint_config must be an array."] };
	const keys = new Set<string>();
	for (const [index, value] of raw.entries()) {
		const label = `endpoint_config[${index}]`;
		if (!value || typeof value !== "object" || Array.isArray(value)
			|| typeof value.provider !== "string" || !value.provider.trim()
			|| typeof value.baseUrl !== "string" || !/^https?:\/\//.test(value.baseUrl)) {
			diagnostics.push(`${label}: provider and an HTTP(S) baseUrl are required.`);
			continue;
		}
		const entry: EndpointConfig = { provider: value.provider.trim(), baseUrl: value.baseUrl.trim().replace(/\/+$/, "") };
		try {
			const url = new URL(entry.baseUrl);
			if (url.username || url.password || url.search || url.hash) throw new Error();
		} catch {
			diagnostics.push(`${label}: baseUrl must be a valid URL without credentials, query or fragment.`);
			continue;
		}
		for (const field of ["webSearch", "imageGeneration", "compaction"] as const) {
			if (value[field] === undefined) continue;
			const allowed = field === "compaction" ? ["responses", "responses-compact"] : ["hosted", "standalone"];
			const values = value[field];
			if (!Array.isArray(values) || values.some(item => !allowed.includes(item))) {
				diagnostics.push(`${label}.${field}: invalid capability list; this capability is disabled.`);
				entry[field] = [];
			} else {
				Object.assign(entry, { [field]: [...new Set(values)] });
			}
		}
		const key = endpointKey(entry)!;
		if (keys.has(key)) {
			diagnostics.push(`${label}: duplicate endpoint; the first declaration is used.`);
			continue;
		}
		keys.add(key);
		entries.push(entry);
	}
	return { entries, diagnostics };
}

export function endpointDeclares(
	entries: readonly EndpointConfig[], model: EndpointIdentity, capability: EndpointCapability,
): boolean {
	const key = endpointKey(model);
	const entry = key && entries.find(item => endpointKey(item) === key);
	if (!entry) return true;
	const [field, mode] = capability.split(".") as [keyof Pick<EndpointConfig, "webSearch" | "imageGeneration" | "compaction">, string];
	return entry[field] === undefined || (entry[field] as string[]).includes(mode);
}
