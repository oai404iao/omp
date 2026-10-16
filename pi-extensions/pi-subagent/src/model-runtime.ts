import type { AnyModel, CredentialStore, Provider } from "@earendil-works/pi-ai";
import { ModelRuntime, type ProviderConfig } from "@earendil-works/pi-coding-agent";

interface RuntimeCredentials extends CredentialStore {
	store: CredentialStore;
	overrides: Map<string, string>;
}

interface RuntimeState {
	credentials: RuntimeCredentials;
	config: { getProvider: Function };
	modelsPath: string | undefined;
	modelNetworkEnabled: boolean;
	defaultBuiltins: Map<string, Provider>;
	extensionProviders: Map<string, ProviderConfig>;
	nativeExtensionProviders: Map<string, Provider>;
	virtualModels: Map<string, Map<string, { model: object; route: Function }>>;
	rebuildProviders(): void;
}

const roots = new WeakMap<ModelRuntime, ModelRuntime>();

function runtimeState(runtime: ModelRuntime): RuntimeState {
	const state = runtime as unknown as RuntimeState;
	if (!state.credentials || !(state.credentials.overrides instanceof Map)
		|| typeof state.credentials.store?.read !== "function"
		|| typeof state.credentials.store?.list !== "function"
		|| typeof state.config?.getProvider !== "function"
		|| typeof state.modelNetworkEnabled !== "boolean"
		|| (state.modelsPath !== undefined && typeof state.modelsPath !== "string")
		|| ![state.defaultBuiltins, state.extensionProviders, state.nativeExtensionProviders, state.virtualModels]
			.every(value => value instanceof Map)
		|| typeof state.rebuildProviders !== "function") {
		throw new Error("pi-subagent requires Pi 1.2-compatible ModelRuntime isolation internals");
	}
	return state;
}

function snapshotCatalog<T>(read: () => readonly T[]): readonly T[] {
	try { return structuredClone(read()); }
	catch { return []; }
}

function snapshotProvider(provider: Provider): Provider {
	const models = snapshotCatalog(() => provider.getModels());
	const allModels = snapshotCatalog(() => provider.getAllModels?.() ?? models);
	// Remote/personalized builtin catalogs keep mutable state in refresh closures.
	// Children use the resolved root catalog, never refresh those shared wrappers.
	const snapshot: Provider = {
		...provider, id: provider.id, name: provider.name, auth: provider.auth,
		baseUrl: provider.baseUrl, headers: provider.headers && { ...provider.headers },
		getModels: () => models, getAllModels: () => allModels, refreshModels: undefined,
		stream: provider.stream.bind(provider), streamSimple: provider.streamSimple.bind(provider),
	};
	for (const name of ["filterModels", "filterAllModels", "fetchDeferred", "cancelDeferred", "generateImages", "classify"] as const) {
		const method = provider[name];
		if (method) Object.defineProperty(snapshot, name, { value: method.bind(provider), enumerable: true });
	}
	return snapshot;
}

function snapshotConfig(config: ProviderConfig, models: readonly AnyModel[]): ProviderConfig {
	return {
		...config,
		models: structuredClone(models.filter(model => model.api !== "pi-virtual")) as ProviderConfig["models"],
		refreshModels: undefined,
		...(config.headers ? { headers: { ...config.headers } } : {}),
		...(config.oauth ? { oauth: { ...config.oauth, modifyModels: undefined } } : {}),
		...(config.images ? { images: { ...config.images } } : {}),
		...(config.classifiers ? { classifiers: { ...config.classifiers } } : {}),
	};
}

/** Pi 1.2 has no public fork API for provider overlays, runtime keys or routers.
 * Keep this layout-checked constructor adaptation separate from SDK lifecycle.
 * Only the root baseline is inherited: intermediate callbacks may outlive their
 * extension runtime. Inherited extensions recreate child-local registrations.
 */
export function createChildModelRuntime(parent: ModelRuntime): ModelRuntime {
	const root = roots.get(parent) ?? parent;
	const source = runtimeState(root);
	const credentials = Reflect.construct(Object.getPrototypeOf(source.credentials).constructor, [source.credentials.store]) as RuntimeCredentials;
	credentials.overrides = new Map(source.credentials.overrides);
	const runtime = Reflect.construct(ModelRuntime, [
		credentials, source.config, source.modelsPath, undefined,
		[...source.defaultBuiltins.values()].map(snapshotProvider), source.modelNetworkEnabled,
	]) as ModelRuntime;
	const target = runtimeState(runtime);
	target.extensionProviders = new Map([...source.extensionProviders].map(([id, config]) => [id, snapshotConfig(config, root.getAllModels(id))]));
	target.nativeExtensionProviders = new Map([...source.nativeExtensionProviders].map(([id, provider]) => [id, snapshotProvider(provider)]));
	target.virtualModels = new Map([...source.virtualModels].map(([provider, entries]) => [provider,
		new Map([...entries].map(([id, entry]) => [id, { ...entry, model: structuredClone(entry.model) }])),
	]));
	target.rebuildProviders();
	roots.set(runtime, root);
	return runtime;
}
