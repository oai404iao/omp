import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_SETTINGS,
	configDir,
	getSettingsSource,
	loadSettings,
	type CodexMinimalToolsSettings,
} from "../settings.js";
import { resolveCodexRequestProfile } from "../codex-request-profile.js";
import type {
	EffectiveModelProfile,
	FastModeProfile,
	ModelCatalogFile,
	ModelIdentityLike,
	ModelProfilePatch,
	ModelProfileSource,
	NativeCompactionMode,
	ResolvedModelProfile,
	ResponsesEndpoint,
	ResponsesMode,
	ResponsesProfilePatch,
	ResponsesTransport,
	SystemPromptPlacement,
	WebSearchContentType,
	WebSearchProfile,
} from "./types.js";

export const MODELS_FILE_NAME = "models.json";

type JsonRecord = Record<string, unknown>;

interface CatalogEntry {
	patch: ModelProfilePatch;
	sources: ModelProfileSource[];
}

interface LoadedCatalog {
	entries: Map<string, CatalogEntry>;
	resolved: Map<string, ModelProfilePatch>;
	diagnostics: string[];
}

const SAFE_PROFILE: EffectiveModelProfile = {
	enabled: true,
	responses: {
		providerShim: false,
		endpoint: "auto",
		mode: "standard",
		systemPromptPlacement: "instructions",
		transport: "sse",
		websocketPrewarm: false,
	},
	tools: {
		parallelCalls: true,
		applyPatch: false,
		webSearch: false,
		imageGeneration: false,
		viewImage: false,
	},
	compaction: "pi",
	fast: false,
};

const BUNDLED_CATALOG = parseBundledCatalog();

function isRecord(value: unknown): value is JsonRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function diagnoseUnknownKeys(
	value: JsonRecord,
	allowed: readonly string[],
	path: string,
	diagnostics: string[],
): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) diagnostics.push(`${path}: unknown property ${key}`);
	}
}

function normalizeId(value: string): string {
	return value.trim().toLowerCase();
}

function validModelId(value: unknown): value is string {
	return typeof value === "string" && /^[^\s/]+\/\S+$/.test(value.trim());
}

function stringEnum<T extends string>(value: unknown, values: readonly T[]): T | undefined {
	return typeof value === "string" && values.includes(value as T) ? value as T : undefined;
}

function sanitizeContentTypes(
	value: unknown,
	path: string,
	diagnostics: string[],
): WebSearchContentType[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		diagnostics.push(`${path}: contentTypes must be an array`);
		return undefined;
	}
	const result: WebSearchContentType[] = [];
	for (const item of value) {
		if (item !== "text" && item !== "image") {
			diagnostics.push(`${path}: unsupported content type ${JSON.stringify(item)}`);
			continue;
		}
		if (!result.includes(item)) result.push(item);
	}
	if (result.length === 0) {
		diagnostics.push(`${path}: contentTypes must contain text and/or image`);
		return undefined;
	}
	return result;
}

function sanitizeWebSearch(
	value: unknown,
	path: string,
	diagnostics: string[],
): false | WebSearchProfile | undefined {
	if (value === undefined || value === false) return value;
	if (!isRecord(value)) {
		diagnostics.push(`${path}: webSearch must be false or an object`);
		return undefined;
	}
	diagnoseUnknownKeys(value, ["implementation", "contentTypes"], `${path}.tools.webSearch`, diagnostics);
	const implementation = stringEnum(value.implementation, ["hosted", "standalone"] as const);
	if (!implementation) {
		diagnostics.push(`${path}: webSearch.implementation must be hosted or standalone`);
		return undefined;
	}
	const contentTypes = sanitizeContentTypes(value.contentTypes, path, diagnostics);
	if (value.contentTypes !== undefined && !contentTypes) return false;
	return {
		implementation,
		...(contentTypes ? { contentTypes } : {}),
	};
}

function sanitizeResponses(
	value: unknown,
	path: string,
	diagnostics: string[],
): ResponsesProfilePatch | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		diagnostics.push(`${path}: responses must be an object`);
		return undefined;
	}
	diagnoseUnknownKeys(
		value,
		["providerShim", "endpoint", "mode", "systemPromptPlacement", "transport", "websocketPrewarm"],
		`${path}.responses`,
		diagnostics,
	);
	const result: ResponsesProfilePatch = {};
	if (typeof value.providerShim === "boolean") result.providerShim = value.providerShim;
	else if (value.providerShim !== undefined) diagnostics.push(`${path}: responses.providerShim must be boolean`);
	const endpoint = stringEnum<ResponsesEndpoint>(value.endpoint, ["auto", "openai", "codex"]);
	if (endpoint) result.endpoint = endpoint;
	else if (value.endpoint !== undefined) diagnostics.push(`${path}: invalid responses.endpoint`);
	const mode = stringEnum<ResponsesMode>(value.mode, ["standard", "lite"]);
	if (mode) result.mode = mode;
	else if (value.mode !== undefined) diagnostics.push(`${path}: invalid responses.mode`);
	const placement = stringEnum<SystemPromptPlacement>(value.systemPromptPlacement, ["instructions", "developer"]);
	if (placement) result.systemPromptPlacement = placement;
	else if (value.systemPromptPlacement !== undefined) diagnostics.push(`${path}: invalid responses.systemPromptPlacement`);
	const transport = stringEnum<ResponsesTransport>(value.transport, ["sse", "websocket", "websocket-cached", "auto"]);
	if (transport) result.transport = transport;
	else if (value.transport !== undefined) diagnostics.push(`${path}: invalid responses.transport`);
	if (typeof value.websocketPrewarm === "boolean") result.websocketPrewarm = value.websocketPrewarm;
	else if (value.websocketPrewarm !== undefined) diagnostics.push(`${path}: responses.websocketPrewarm must be boolean`);
	return result;
}

function sanitizeFast(
	value: unknown,
	path: string,
	diagnostics: string[],
): false | FastModeProfile | undefined {
	if (value === undefined || value === false) return value;
	if (!isRecord(value) || typeof value.serviceTier !== "string" || !value.serviceTier.trim()) {
		diagnostics.push(`${path}: fast must be false or an object with serviceTier`);
		return undefined;
	}
	diagnoseUnknownKeys(value, ["serviceTier", "costMultiplier"], `${path}.fast`, diagnostics);
	const result: FastModeProfile = { serviceTier: value.serviceTier.trim() };
	if (value.costMultiplier !== undefined) {
		if (typeof value.costMultiplier === "number" && Number.isFinite(value.costMultiplier) && value.costMultiplier > 0) {
			result.costMultiplier = value.costMultiplier;
		} else {
			diagnostics.push(`${path}: fast.costMultiplier must be a positive number`);
		}
	}
	return result;
}

function sanitizeProfile(
	value: unknown,
	path: string,
	diagnostics: string[],
): ModelProfilePatch | undefined {
	if (!isRecord(value)) {
		diagnostics.push(`${path}: model entry must be an object`);
		return undefined;
	}
	diagnoseUnknownKeys(
		value,
		["id", "extends", "enabled", "responses", "tools", "compaction", "fast"],
		path,
		diagnostics,
	);
	if (!validModelId(value.id)) {
		diagnostics.push(`${path}: id must be an exact provider/model id`);
		return undefined;
	}
	const id = value.id.trim();
	const result: ModelProfilePatch = { id };
	if (value.extends !== undefined) {
		if (validModelId(value.extends)) result.extends = value.extends.trim();
		else diagnostics.push(`${path}: extends must be an exact provider/model id`);
	}
	if (typeof value.enabled === "boolean") result.enabled = value.enabled;
	else if (value.enabled !== undefined) diagnostics.push(`${path}: enabled must be boolean`);
	const responses = sanitizeResponses(value.responses, path, diagnostics);
	if (responses) result.responses = responses;
	if (value.tools !== undefined) {
		if (!isRecord(value.tools)) {
			diagnostics.push(`${path}: tools must be an object`);
		} else {
			diagnoseUnknownKeys(
				value.tools,
				["parallelCalls", "applyPatch", "webSearch", "imageGeneration", "viewImage"],
				`${path}.tools`,
				diagnostics,
			);
			const tools: NonNullable<ModelProfilePatch["tools"]> = {};
			if (typeof value.tools.parallelCalls === "boolean") tools.parallelCalls = value.tools.parallelCalls;
			else if (value.tools.parallelCalls !== undefined) diagnostics.push(`${path}: tools.parallelCalls must be boolean`);
			if (value.tools.applyPatch === false || value.tools.applyPatch === "function" || value.tools.applyPatch === "custom") {
				tools.applyPatch = value.tools.applyPatch;
			} else if (value.tools.applyPatch !== undefined) {
				diagnostics.push(`${path}: tools.applyPatch must be false, function, or custom`);
			}
			const webSearch = sanitizeWebSearch(value.tools.webSearch, path, diagnostics);
			if (webSearch !== undefined) tools.webSearch = webSearch;
			if (
				value.tools.imageGeneration === false
				|| value.tools.imageGeneration === "hosted"
				|| value.tools.imageGeneration === "standalone"
			) {
				tools.imageGeneration = value.tools.imageGeneration;
			} else if (value.tools.imageGeneration !== undefined) {
				diagnostics.push(`${path}: tools.imageGeneration must be false, hosted, or standalone`);
			}
			if (typeof value.tools.viewImage === "boolean") tools.viewImage = value.tools.viewImage;
			else if (value.tools.viewImage !== undefined) diagnostics.push(`${path}: tools.viewImage must be boolean`);
			result.tools = tools;
		}
	}
	const compaction = stringEnum<NativeCompactionMode>(value.compaction, ["pi", "responses", "responses-compact"]);
	if (compaction) result.compaction = compaction;
	else if (value.compaction !== undefined) diagnostics.push(`${path}: invalid compaction mode`);
	const fast = sanitizeFast(value.fast, path, diagnostics);
	if (fast !== undefined) result.fast = fast;
	return result;
}

function parseCatalog(value: unknown, path: string): { models: ModelProfilePatch[]; diagnostics: string[] } {
	const diagnostics: string[] = [];
	if (!isRecord(value)) return { models: [], diagnostics: [`${path}: root value must be an object`] };
	diagnoseUnknownKeys(value, ["$schema", "version", "models"], path, diagnostics);
	if (value.version !== 1) return { models: [], diagnostics: [`${path}: version must be 1`] };
	if (!Array.isArray(value.models)) return { models: [], diagnostics: [...diagnostics, `${path}: models must be an array`] };
	const models: ModelProfilePatch[] = [];
	const seen = new Set<string>();
	for (const [index, candidate] of value.models.entries()) {
		const profile = sanitizeProfile(candidate, `${path}: models[${index}]`, diagnostics);
		if (!profile) continue;
		const key = normalizeId(profile.id);
		if (seen.has(key)) {
			diagnostics.push(`${path}: duplicate model id ${profile.id}`);
			continue;
		}
		seen.add(key);
		models.push(profile);
	}
	return { models, diagnostics };
}

function parseBundledCatalog(): ModelProfilePatch[] {
	const path = new URL("./default-models.json", import.meta.url);
	const parsed = JSON.parse(readFileSync(path, "utf8")) as ModelCatalogFile;
	const result = parseCatalog(parsed, "bundled model catalog");
	if (result.diagnostics.length > 0) {
		throw new Error(result.diagnostics.join("\n"));
	}
	return result.models;
}

function deepMerge<T>(base: T, patch: unknown): T {
	if (!isRecord(base) || !isRecord(patch)) return patch as T;
	const output: JsonRecord = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		const current = output[key];
		output[key] = isRecord(current) && isRecord(value)
			? deepMerge(current, value)
			: value;
	}
	return output as T;
}

export function modelsPath(agentDir?: string): string {
	return join(configDir(agentDir), MODELS_FILE_NAME);
}

function loadUserCatalog(): { models: ModelProfilePatch[]; diagnostics: string[] } {
	const path = modelsPath();
	if (!existsSync(path)) {
		return { models: [], diagnostics: [] };
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parseCatalog(parsed, path);
	} catch (error) {
		const diagnostics = [`${path}: ${error instanceof Error ? error.message : String(error)}`];
		return { models: [], diagnostics };
	}
}

function buildCatalog(): LoadedCatalog {
	const entries = new Map<string, CatalogEntry>();
	for (const patch of BUNDLED_CATALOG) {
		entries.set(normalizeId(patch.id), { patch, sources: ["bundled"] });
	}
	const user = loadUserCatalog();
	for (const patch of user.models) {
		const key = normalizeId(patch.id);
		const existing = entries.get(key);
		entries.set(key, {
			patch: existing ? deepMerge(existing.patch, patch) : patch,
			sources: existing ? ["bundled", "user"] : ["user"],
		});
	}

	const diagnostics = [...user.diagnostics];
	const resolved = new Map<string, ModelProfilePatch>();
	const resolving: string[] = [];
	const invalid = new Set<string>();
	const resolveEntry = (key: string): ModelProfilePatch | undefined => {
		if (resolved.has(key)) return resolved.get(key);
		if (invalid.has(key)) return undefined;
		const entry = entries.get(key);
		if (!entry) return undefined;
		const cycleIndex = resolving.indexOf(key);
		if (cycleIndex >= 0) {
			const cycle = [...resolving.slice(cycleIndex), key]
				.map((item) => entries.get(item)?.patch.id ?? item)
				.join(" -> ");
			diagnostics.push(`model catalog: cyclic extends: ${cycle}`);
			for (const item of resolving.slice(cycleIndex)) invalid.add(item);
			return undefined;
		}
		resolving.push(key);
		let patch = entry.patch;
		if (patch.extends) {
			const parentKey = normalizeId(patch.extends);
			const parent = resolveEntry(parentKey);
			if (!parent) {
				if (!invalid.has(key)) diagnostics.push(`model catalog: ${patch.id} extends missing or invalid profile ${patch.extends}`);
				invalid.add(key);
				resolving.pop();
				return undefined;
			}
			patch = {
				...deepMerge(parent, patch),
				id: entry.patch.id,
				extends: entry.patch.extends,
			};
		}
		resolving.pop();
		if (!invalid.has(key)) resolved.set(key, patch);
		return invalid.has(key) ? undefined : patch;
	};
	for (const key of entries.keys()) resolveEntry(key);
	return { entries, resolved, diagnostics };
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, stableValue(item)]),
	);
}

function profileHash(profile: EffectiveModelProfile): string {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(profile)))
		.digest("hex")
		.slice(0, 16);
}

function normalizeProfile(
	patch: ModelProfilePatch,
	diagnostics: string[],
): EffectiveModelProfile {
	const effective: EffectiveModelProfile = {
		enabled: patch.enabled ?? SAFE_PROFILE.enabled,
		responses: deepMerge(SAFE_PROFILE.responses, patch.responses ?? {}),
		tools: deepMerge(SAFE_PROFILE.tools, patch.tools ?? {}),
		compaction: patch.compaction ?? SAFE_PROFILE.compaction,
		fast: patch.fast ?? SAFE_PROFILE.fast,
	};

	if (effective.responses.mode === "lite") {
		effective.responses.systemPromptPlacement = "developer";
		effective.tools.parallelCalls = false;
		if (effective.tools.webSearch && effective.tools.webSearch.implementation === "hosted") {
			diagnostics.push(`${patch.id}: Responses Lite cannot use hosted web search; webSearch was disabled`);
			effective.tools.webSearch = false;
		}
		if (effective.tools.imageGeneration === "hosted") {
			diagnostics.push(`${patch.id}: Responses Lite cannot use hosted image generation; imageGeneration was disabled`);
			effective.tools.imageGeneration = false;
		}
	}
	if (!effective.responses.providerShim) {
		if (effective.tools.applyPatch === "custom") {
			diagnostics.push(`${patch.id}: custom apply_patch requires responses.providerShim; applyPatch was disabled`);
			effective.tools.applyPatch = false;
		}
		if (effective.tools.webSearch && effective.tools.webSearch.implementation === "hosted") {
			diagnostics.push(`${patch.id}: hosted web search requires responses.providerShim; webSearch was disabled`);
			effective.tools.webSearch = false;
		}
		if (effective.tools.imageGeneration === "hosted") {
			diagnostics.push(`${patch.id}: hosted image generation requires responses.providerShim; imageGeneration was disabled`);
			effective.tools.imageGeneration = false;
		}
		if (effective.compaction !== "pi") {
			diagnostics.push(`${patch.id}: native compaction requires responses.providerShim; compaction was reset to pi`);
			effective.compaction = "pi";
		}
		if (effective.fast) {
			diagnostics.push(`${patch.id}: Fast service tiers require responses.providerShim; fast was disabled`);
			effective.fast = false;
		}
	}
	return effective;
}

function modelId(model: ModelIdentityLike | undefined): string | undefined {
	const provider = model?.provider?.trim();
	const id = model?.id?.trim() || model?.name?.trim();
	return provider && id ? `${provider}/${id}` : undefined;
}

function valuesDiffer(left: unknown, right: unknown): boolean {
	return JSON.stringify(stableValue(left)) !== JSON.stringify(stableValue(right));
}

function legacySettingsRecord(settings: CodexMinimalToolsSettings): JsonRecord {
	const source = getSettingsSource(settings);
	if (source) return source;
	const record: JsonRecord = {};
	for (const key of [
		"nativeProviderTools",
		"openaiTransport",
		"openaiWebSocketPrewarm",
		"compactionMode",
		"requestProfile",
		"apiKeyMode",
		"imageGeneration",
		"webSearchEnabled",
		"viewImage",
		"applyPatchEnabled",
		"additionalModelIds",
	] as const) {
		if (valuesDiffer(settings[key], DEFAULT_SETTINGS[key])) record[key] = settings[key];
	}
	return record;
}

function nativeProvider(model: ModelIdentityLike | undefined): boolean {
	return model?.provider === "openai" || model?.provider === "openai-codex";
}

function legacyProfilePatch(
	model: ModelIdentityLike,
	settings: CodexMinimalToolsSettings,
	existing: ModelProfilePatch | undefined,
): ModelProfilePatch | undefined {
	const id = modelId(model);
	if (!id) return undefined;
	const raw = legacySettingsRecord(settings);
	const additional = Array.isArray(raw.additionalModelIds)
		&& raw.additionalModelIds.some((candidate) => typeof candidate === "string" && normalizeId(candidate) === normalizeId(id));
	if (!existing && !additional) return undefined;
	const legacyKeys = [
		"nativeProviderTools",
		"openaiTransport",
		"openaiWebSocketPrewarm",
		"compactionMode",
		"requestProfile",
		"apiKeyMode",
		"imageGeneration",
		"webSearchEnabled",
		"viewImage",
		"applyPatchEnabled",
		"additionalModelIds",
	];
	const legacyMode = additional || legacyKeys.some((key) => Object.hasOwn(raw, key));
	if (!legacyMode) return undefined;

	const fullId = normalizeId(id);
	const oldExtendedToolModel = /^openai\/gpt-5(?:$|[.-])/.test(fullId) || additional;
	const requestProfile = resolveCodexRequestProfile(settings.requestProfile);
	const rawRequestProfile = isRecord(raw.requestProfile) ? raw.requestProfile : undefined;
	const explicitPatchTransport = rawRequestProfile?.patchTransport === "function"
		|| rawRequestProfile?.patchTransport === "custom";
	const patchSupportedByCatalog = existing?.tools?.applyPatch !== false
		&& existing?.tools?.applyPatch !== undefined;
	const hostedTools = settings.nativeProviderTools
		&& requestProfile.supportsHostedTools
		&& nativeProvider(model);
	const existingWebSearch = existing?.tools?.webSearch;
	const contentTypes: WebSearchContentType[] = existingWebSearch
		? existingWebSearch.contentTypes ?? ["text"]
		: ["text"];

	return {
		id,
		enabled: true,
		responses: {
			providerShim: nativeProvider(model) || existing?.responses?.providerShim === true,
			endpoint: model.provider === "openai" || settings.apiKeyMode ? "openai" : "codex",
			mode: requestProfile.responsesMode,
			systemPromptPlacement: requestProfile.systemPromptPlacement,
			transport: settings.openaiTransport,
			websocketPrewarm: settings.openaiWebSocketPrewarm,
		},
		tools: {
			parallelCalls: requestProfile.supportsParallelTools,
			applyPatch: settings.applyPatchEnabled
				&& (oldExtendedToolModel || (explicitPatchTransport && patchSupportedByCatalog))
				? requestProfile.patchTransport
				: false,
			webSearch: settings.webSearchEnabled && hostedTools && oldExtendedToolModel
				? { implementation: "hosted", contentTypes: [...contentTypes] }
				: false,
			imageGeneration: settings.imageGeneration && hostedTools
				? "hosted"
				: false,
			viewImage: settings.viewImage,
		},
		compaction: settings.compactionMode,
		fast: existing?.fast ?? false,
	};
}

export function resolveModelProfile(
	model: ModelIdentityLike | undefined,
	options: { settings?: CodexMinimalToolsSettings } = {},
): ResolvedModelProfile | undefined {
	const id = modelId(model);
	if (!id || !model) return undefined;
	const catalog = buildCatalog();
	const key = normalizeId(id);
	const catalogPatch = catalog.resolved.get(key);
	const settings = options.settings ?? loadSettings();
	const legacy = legacyProfilePatch(model, settings, catalogPatch);
	if (!catalogPatch && !legacy) return undefined;
	const patch = legacy
		? deepMerge(catalogPatch ?? { id }, legacy)
		: catalogPatch as ModelProfilePatch;
	const diagnostics = [...catalog.diagnostics];
	const effective = normalizeProfile(patch, diagnostics);
	const sources = [...(catalog.entries.get(key)?.sources ?? []), ...(legacy ? ["legacy" as const] : [])];
	return {
		id,
		sources: [...new Set(sources)],
		profileHash: profileHash(effective),
		effective,
		diagnostics,
	};
}

export function listResolvedModelProfiles(
	options: { settings?: CodexMinimalToolsSettings } = {},
): ResolvedModelProfile[] {
	const catalog = buildCatalog();
	const settings = options.settings ?? loadSettings();
	const profiles: ResolvedModelProfile[] = [];
	for (const entry of catalog.resolved.values()) {
		const slash = entry.id.indexOf("/");
		const provider = entry.id.slice(0, slash);
		const id = entry.id.slice(slash + 1);
		const resolved = resolveModelProfile({ provider, id }, { settings });
		if (resolved) profiles.push(resolved);
	}
	for (const additional of settings.additionalModelIds) {
		if (profiles.some((profile) => normalizeId(profile.id) === normalizeId(additional))) continue;
		const slash = additional.indexOf("/");
		const resolved = resolveModelProfile({
			provider: additional.slice(0, slash),
			id: additional.slice(slash + 1),
		}, { settings });
		if (resolved) profiles.push(resolved);
	}
	return profiles;
}

export function modelCatalogDiagnostics(): string[] {
	return buildCatalog().diagnostics;
}
