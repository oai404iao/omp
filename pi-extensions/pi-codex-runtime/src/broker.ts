import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import type { PackageToolName } from "./capabilities.js";
import type { ProviderPresentation } from "./extension/provider-presentation.js";

export const CODEX_BROKER_CHANNEL = "@oai404iao/pi-codex:broker";
export const CODEX_RUNTIME_VERSION: string = createRequire(import.meta.url)("../package.json").version;
const CACHE = Symbol.for("@oai404iao/pi-codex/broker/v1");

export interface InstalledTool {
	register(): void;
	registered: boolean;
}

export interface CodexBroker {
	readonly version: 1;
	readonly runtimeVersion: string;
	readonly closed: boolean;
	readonly tools: Map<PackageToolName, InstalledTool>;
	coreEnabled: boolean;
	claim(name: string): boolean;
	addPresentation(name: string, presentation: ProviderPresentation): void;
	presentation: ProviderPresentation;
}

function createBroker(): CodexBroker & { close(): void } {
	const claims = new Set<string>();
	const tools = new Map<PackageToolName, InstalledTool>();
	const presentations = new Map<string, ProviderPresentation>();
	const rendered = new Set<string>();
	let closed = false;
	const ordered = () => [...presentations].sort(([a], [b]) => a.localeCompare(b));
	return {
		version: 1,
		runtimeVersion: CODEX_RUNTIME_VERSION,
		get closed() { return closed; },
		coreEnabled: false,
		tools,
		claim(name) {
			if (closed) throw new Error("Codex broker belongs to a closed session");
			if (claims.has(name)) return false;
			claims.add(name);
			return true;
		},
		addPresentation(name, presentation) {
			if (closed) throw new Error("Codex broker belongs to a closed session");
			if (presentations.has(name)) throw new Error(`Duplicate Codex presentation: ${name}`);
			presentations.set(name, presentation);
		},
		presentation: {
			clear() { for (const [, p] of ordered()) p.clear(); },
			flush() { for (const [, p] of ordered()) p.flush(); },
			scheduleFlush() { for (const [, p] of ordered()) p.scheduleFlush(); },
			registerRenderers() {
				for (const [name, p] of ordered()) {
					if (rendered.has(name)) continue;
					p.registerRenderers();
					rendered.add(name);
				}
			},
			streamEffects() {
				// Capture contributions and their session-owned sinks before I/O.
				const effects = ordered().map(([, p]) => p.streamEffects());
				return {
					createEventObserver(context) {
						const observers = effects.map(p => p.createEventObserver?.(context)).filter(
							(observer): observer is NonNullable<typeof observer> => !!observer,
						);
						return async event => { for (const observe of observers) await observe(event); };
					},
				};
			},
		},
		close() { closed = true; },
	};
}

function isCompatible(candidate: CodexBroker): boolean {
	return candidate?.version === 1 && candidate.runtimeVersion === CODEX_RUNTIME_VERSION
		&& typeof candidate.claim === "function"
		&& typeof candidate.addPresentation === "function"
		&& typeof candidate.tools?.get === "function"
		&& typeof candidate.tools?.set === "function"
		&& typeof candidate.closed === "boolean"
		&& typeof candidate.coreEnabled === "boolean"
		&& ["clear", "flush", "scheduleFlush", "registerRenderers", "streamEffects"].every(
			name => typeof (candidate.presentation as unknown as Record<string, unknown>)?.[name] === "function",
		);
}

function incompatibleBroker(): Error {
	return new Error(`Incompatible or duplicate Codex capability broker: requires ABI v1 and runtime ${CODEX_RUNTIME_VERSION}`);
}

/**
 * Pi gives each extension a separate API/module root. Synchronous event-bus
 * discovery shares the v1 service across those roots; no module-global registry
 * or equality of pi.events wrapper objects is assumed. The cached property is
 * only a fast path (and supports minimal ExtensionAPI test doubles).
 */
export function getCodexBroker(pi: ExtensionAPI): CodexBroker {
	const api = pi as ExtensionAPI & { [CACHE]?: CodexBroker };
	const cached = api[CACHE];
	if (cached && cached.closed !== true) {
		// Different runtime copies can receive the same API object.
		if (!isCompatible(cached)) throw incompatibleBroker();
		return cached;
	}
	let found: CodexBroker | undefined;
	let incompatible = false;
	pi.events?.emit(CODEX_BROKER_CHANNEL, {
		version: 1,
		accept(candidate: CodexBroker) {
			if (!isCompatible(candidate)) incompatible = true;
			else if (!candidate.closed) {
				if (found && found !== candidate) incompatible = true;
				found = candidate;
			}
		},
	});
	if (incompatible) throw incompatibleBroker();
	if (found) return (api[CACHE] = found);
	const broker = createBroker();
	const unsubscribe = pi.events?.on(CODEX_BROKER_CHANNEL, value => {
		const request = value as { accept?: (broker: CodexBroker) => void } | undefined;
		if (!broker.closed && typeof request?.accept === "function") request.accept(broker);
	});
	pi.on("session_shutdown", () => {
		broker.close();
		unsubscribe?.();
	});
	return (api[CACHE] = broker);
}
