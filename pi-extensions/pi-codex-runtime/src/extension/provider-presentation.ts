import type { ProviderStreamEffects } from "../providers/openai-codex/stream-effects.js";

/** Lifecycle methods are synchronous; no resources start at factory load time. */
export interface ProviderPresentation {
	clear(): void;
	flush(): void;
	scheduleFlush(): void;
	registerRenderers(): void;
	/** Capture session ownership synchronously, before the request starts I/O. */
	streamEffects(): ProviderStreamEffects;
}
