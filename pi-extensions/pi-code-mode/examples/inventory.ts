import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Standalone author example: no Code Mode import, dependency or auto-grant. */
export default function inventory(pi: ExtensionAPI) {
	const parameters = Type.Object({ name: Type.String() }, { additionalProperties: false });
	const items = new Map([["sample", "example"]]);
	const lookup = (input: unknown, signal?: AbortSignal) => {
		signal?.throwIfAborted();
		if (!input || typeof input !== "object" || typeof (input as { name?: unknown }).name !== "string")
			throw new Error("Inventory lookup requires a name");
		const name = (input as { name: string }).name;
		return { name, value: items.get(name) ?? null };
	};
	pi.registerTool({
		name: "inventory_lookup", label: "Inventory lookup", description: "Look up an item in the example in-memory catalog.",
		parameters,
		async execute(_id, input, signal) {
			const value = lookup(input, signal);
			return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
		},
	});
	const registration = Object.freeze({ owner: "inventory", instanceId: randomUUID(), revision: 1 });
	let disposed = false;
	const generations = new Map<string, number>();
	const tool = { name: "lookup", description: "Query the example in-memory catalog; no filesystem or network access.",
		parameters, effect: "read", parallel: true,
		async invoke(input: unknown, context: { signal: AbortSignal }) {
			if (disposed) throw new Error("Inventory registration disposed");
			return { value: lookup(input, context.signal) };
		} };
	const change = (phase: string) => {
		const event = { protocol: 2, registration, kind: "execution", phase };
		pi.events.emit("@oai404iao/pi-code-mode:changed/v2", event);
		pi.events.emit("@oai404iao/pi-code-mode:changed/v1", { version: 1, change: event });
	};
	const off = pi.events.on("@oai404iao/pi-code-mode:discover/v2", (value) => {
		const request = value as { hello?: { protocol?: number; instanceId?: string; generation?: number; features?: unknown[] }; offer?: (offer: unknown) => unknown } | undefined;
		if (disposed || request?.hello?.protocol !== 2 || !Array.isArray(request.hello.features)
			|| request.hello.features.length > 32 || !request.hello.features.includes("json-result/1")
			|| !request.hello.instanceId || request.hello.instanceId.length > 128
			|| !Number.isSafeInteger(request.hello.generation) || request.hello.generation! < 1 || typeof request.offer !== "function") return;
		const previous = generations.get(request.hello.instanceId);
		if ((previous !== undefined && request.hello.generation! < previous) || (previous === undefined && generations.size >= 64)) return;
		generations.set(request.hello.instanceId, request.hello.generation!);
		request.offer({ kind: "provider", registration, requires: ["json-result/1"],
			availability: { state: "available" }, provider: { id: "inventory", tools: [tool] } });
	});
	change("ready");
	pi.on("session_shutdown", () => {
		if (disposed) return;
		disposed = true; off(); change("disposed");
	});
}
