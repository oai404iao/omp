import type { EndpointCapability } from "./endpoint-config.js";
import { unsupportedEndpointCapabilities } from "./endpoint-state.js";

const MAX_RETRIES = 4;
const MAX_RETRY_DELAY_MS = 60_000;

function retryDeadline(headers: Headers): number | undefined {
	const value = headers.get("retry-after")?.trim();
	if (!value) return undefined;
	if (/^\d+$/.test(value)) {
		const milliseconds = Number(value) * 1000;
		return Number.isSafeInteger(milliseconds) ? Date.now() + milliseconds : Infinity;
	}
	if (!/^[a-z]{3},/i.test(value)) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? Math.max(Date.now(), parsed) : undefined;
}

function networkFailure(error: unknown): boolean {
	return error instanceof Error && (
		error.name === "TimeoutError"
		|| error instanceof TypeError && /fetch failed|network|load failed/i.test(error.message)
	);
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		};
		const abort = () => { cleanup(); reject(signal?.reason ?? new Error("Request was aborted")); };
		const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

/** Codex's neutral HTTP policy: four retries for 5xx/network errors, never 429. */
export async function fetchCodexJson(
	url: string,
	request: { headers: Headers; body: string; signal?: AbortSignal },
	capabilities: readonly EndpointCapability[] = [],
): Promise<Response> {
	const endpoint = new URL(url);
	if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("JSON requests require HTTP or HTTPS.");
	const headers = new Headers(request.headers);
	const { body, signal } = request;
	for (let attempt = 0; ; attempt++) {
		signal?.throwIfAborted();
		let response: Response | undefined;
		let deadline: number | undefined;
		try {
			response = await fetch(url, { method: "POST", headers, body, signal });
			signal?.throwIfAborted();
			if (response.status < 500 || response.status >= 600 || attempt === MAX_RETRIES) return response;
			deadline = retryDeadline(response.headers);
			const responseBody = await response.clone().text();
			signal?.throwIfAborted();
			if (unsupportedEndpointCapabilities(capabilities, { status: response.status, responseBody }).length) return response;
		} catch (error) {
			signal?.throwIfAborted();
			if (!networkFailure(error) || attempt === MAX_RETRIES) throw error;
		}
		const delay = deadline === undefined
			? Math.floor(200 * 2 ** attempt * (0.9 + Math.random() * 0.2))
			: Math.max(0, deadline - Date.now());
		// Never retry earlier than long server advice, or overflow Node's timer range.
		if (delay > MAX_RETRY_DELAY_MS && response) return response;
		await response?.body?.cancel();
		await wait(delay, signal);
	}
}
