import type { ProviderHeaders } from "@earendil-works/pi-ai";

const suppressedHeaders = new WeakMap<Headers, Set<string>>();

function normalizedName(name: string): string {
	return name.trim().toLowerCase();
}

export function providerHeaderDirective(
	headers: ProviderHeaders | undefined,
	name: string,
): string | null | undefined {
	const target = normalizedName(name);
	let directive: string | null | undefined;
	for (const [candidate, value] of Object.entries(headers ?? {})) {
		if (normalizedName(candidate) === target) directive = value;
	}
	return directive;
}

export function mergeProviderHeaders(...layers: Array<ProviderHeaders | undefined>): Headers {
	const headers = new Headers();
	const suppressed = new Set<string>();
	for (const layer of layers) {
		for (const [name, value] of Object.entries(layer ?? {})) {
			const normalized = normalizedName(name);
			if (value === null) {
				headers.delete(name);
				suppressed.add(normalized);
			} else {
				headers.set(name, value);
				suppressed.delete(normalized);
			}
		}
	}
	suppressedHeaders.set(headers, suppressed);
	return headers;
}

export function isProviderHeaderSuppressed(headers: Headers, name: string): boolean {
	return suppressedHeaders.get(headers)?.has(normalizedName(name)) ?? false;
}

export function setProviderDefaultHeader(headers: Headers, name: string, value: string): boolean {
	if (isProviderHeaderSuppressed(headers, name) || headers.has(name)) return false;
	headers.set(name, value);
	return true;
}

export function setProviderGeneratedHeader(headers: Headers, name: string, value: string): boolean {
	if (isProviderHeaderSuppressed(headers, name)) return false;
	headers.set(name, value);
	return true;
}
