import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A session-scoped lease for lifecycle hooks, including separately loaded SDK inline factories. */
export function claimSessionFeature(pi: ExtensionAPI, name: string): boolean {
	const key = Symbol.for(`@oai404iao/pi-codex/feature/${name}/v1`);
	const api = pi as unknown as Record<PropertyKey, unknown>;
	if (api[key]) return false;
	const channel = `@oai404iao/pi-codex:feature:${name}:v1`;
	let present = false;
	pi.events?.emit(channel, { accept() { present = true; } });
	if (present) return false;
	api[key] = true;
	const unsubscribe = pi.events?.on(channel, value => {
		const request = value as { accept?: () => void } | undefined;
		if (typeof request?.accept === "function") request.accept();
	});
	pi.on("session_shutdown", () => unsubscribe?.());
	return true;
}
