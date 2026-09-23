import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collect } from "../src/catalog.ts";
import { DiscoveryState } from "../src/discovery-state.ts";
import { DISCOVER_V2, FEATURES, type DiscoveryV2, type ConsumerHello, type DiscoveryOffer } from "../src/discovery.ts";
import { DISCOVER, CHANGED_V2, registerCodeModeTools, registerCodeModeObserver, registerCodeModePolicy, registerCodeModeApproval, type CodeModeTool } from "../src/contributions.ts";
import { ToolBridge } from "../src/bridge.ts";
import { isUnsettledEffect, unsettledEffect } from "../src/errors.ts";
import { registerCodeModeContribution } from "../../pi-codex-runtime/src/code-mode-contributions.ts";
import { CodeSession } from "../src/session.ts";
import { piSession } from "./helpers.ts";

const tool: CodeModeTool = { name: "lookup", description: "fixture", parameters: Type.Object({}), effect: "read",
	async invoke() { return { value: "ok" }; } };
function fixture() {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const pi = { events: createEventBus(), on(name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) {
		handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {};
	} } as unknown as ExtensionAPI;
	return { pi, emit: async (name: string) => {
		for (const fn of [...(handlers.get(name) ?? [])]) await fn({}, { cwd: "." } as ExtensionContext);
	} };
}
function hello(generation = 1): ConsumerHello {
	return { protocol: 2, instanceId: "consumer", generation, features: FEATURES,
		limits: { resultBytes: 65536, callsPerCell: 32, maxCells: 4 } };
}

test("v2: tool features, availability and required policies gate admission without granting", () => {
	const { pi } = fixture();
	const registration = registerCodeModeTools(pi, { id: "fixture", tools: [
		tool, { ...tool, name: "future", requires: ["future-feature/1"] },
		{ ...tool, name: "offline", availability: { state: "unavailable", reason: "backend-disabled" } },
		{ ...tool, name: "guarded", requiredPolicies: ["guard"] },
	] });
	let catalog = collect(pi);
	assert.deepEqual(catalog.tools.map((item) => item.name), ["fixture__lookup"]);
	assert(catalog.diagnostics?.some((item) => item.name === "fixture__future" && item.state === "incompatible"));
	assert(catalog.diagnostics?.some((item) => item.name === "fixture__guarded" && item.reason === "missing-policy:guard"));
	const stop = registerCodeModePolicy(pi, { id: "guard", before() {} });
	catalog = collect(pi);
	assert.deepEqual(catalog.tools.map((item) => item.name), ["fixture__lookup", "fixture__guarded"]);
	stop(); registration.dispose();
});

test("v2: provider availability changes use explicit revision refresh, not mutable declarations", () => {
	const { pi } = fixture();
	const state = new DiscoveryState();
	const registration = registerCodeModeTools(pi, { id: "fixture", tools: [tool], availability: { state: "not-ready" } });
	assert.equal(collect(pi, [], state).tools.length, 0);
	registration.refresh({ id: "fixture", tools: [tool], availability: { state: "available" } });
	assert.equal(collect(pi, [], state).tools.length, 1);
	assert.throws(() => registration.refresh({ id: "foreign", tools: [tool] }), /identity/);
});

test("v2: legacy and I0-only consumers cannot obtain newly mandatory tool closures", async () => {
	const { pi } = fixture();
	let effects = 0;
	registerCodeModeTools(pi, { id: "fixture", tools: [
		{ ...tool, requiredPolicies: ["guard"], invoke: async () => { effects++; return { value: null }; } },
	] });
	const legacy: unknown[] = [];
	pi.events.emit(DISCOVER, { version: 1, provider: (value: unknown) => legacy.push(value), policy() {} });
	assert.deepEqual(legacy, []);
	const offers: DiscoveryOffer[] = [];
	pi.events.emit(DISCOVER_V2, { hello: { ...hello(), features: ["approval/1"] }, offer(value: DiscoveryOffer) {
		offers.push(value); return { status: "compatible" };
	} });
	assert(!offers.some((offer) => offer.kind === "provider" && offer.provider.tools.length));
	assert.equal(effects, 0);
});

test("v2: consumer identity is stable across collections, fresh per instance, and revision rollback fails closed", () => {
	const { pi } = fixture();
	const state = new DiscoveryState();
	let revision = 2;
	let invoke = tool.invoke;
	const hellos: ConsumerHello[] = [];
	pi.events.on(DISCOVER_V2, (value) => {
		const request = value as DiscoveryV2; hellos.push(request.hello);
		request.offer({ kind: "provider", registration: { owner: "fixture", instanceId: "producer", revision },
			requires: [], provider: { id: "fixture", tools: [{ ...tool, invoke }] } });
	});
	collect(pi, [], state); collect(pi, [], state);
	assert.equal(hellos[0].instanceId, hellos[1].instanceId);
	assert.equal(hellos[0].generation, hellos[1].generation);
	assert.notEqual(hellos[0], hellos[1], "receipts are collection-local objects");
	state.advance(); collect(pi, [], state);
	assert(hellos[2].generation > hellos[1].generation);
	assert.notEqual(state.instanceId, new DiscoveryState().instanceId);
	revision = 1; assert.throws(() => collect(pi, [], state), /registration/);
	revision = 2; invoke = async () => ({ value: "replacement" });
	assert.throws(() => collect(pi, [], state), /registration/);
	revision = 3; assert.equal(collect(pi, [], state).tools.length, 1);
	state.withdraw("provider", { owner: "fixture", instanceId: "producer", revision: 3 });
	assert.throws(() => collect(pi, [], state), /registration/);
	revision = 4; assert.equal(collect(pi, [], state).tools.length, 1);
});

test("v2: unavailable and incompatible revisions still establish rollback high-water marks", () => {
	for (const unavailable of [true, false]) {
		const { pi } = fixture();
		const state = new DiscoveryState();
		let revision = 2, unavailableNow = false;
		pi.events.on(DISCOVER_V2, (value) => (value as DiscoveryV2).offer({
			kind: "provider", registration: { owner: "fixture", instanceId: "producer", revision },
			requires: unavailableNow && !unavailable ? ["future/1"] : [],
			availability: { state: unavailableNow && unavailable ? "unavailable" : "available" },
			provider: { id: "fixture", tools: [tool] },
		}));
		collect(pi, [], state);
		revision = 5; unavailableNow = true;
		assert.equal(collect(pi, [], state).tools.length, 0);
		revision = 3; unavailableNow = false;
		assert.throws(() => collect(pi, [], state), /registration/);
	}
});

test("v2: failed approval offers and oversized unavailable declarations never enter execution snapshots", () => {
	const { pi } = fixture();
	registerCodeModePolicy(pi, { id: "guard", approval: "permit" });
	pi.events.on(DISCOVER_V2, (value) => (value as DiscoveryV2).offer({
		kind: "approval", registration: { owner: "permit", instanceId: "approval", revision: 1 },
		requires: [], availability: { state: "failed" }, approval: { id: "permit", approve: () => true },
	}));
	assert.throws(() => collect(pi), /policy approval unavailable/);
	pi.events.on("@oai404iao/pi-code-mode:approvals/v1", (request) =>
		(request as { accept(value: unknown): void }).accept({ id: "permit", approve: () => true }));
	assert.throws(() => collect(pi), /Invalid/, "a failed v2 offer cannot downgrade through an unidentified legacy mirror");
	const other = fixture();
	other.pi.events.on(DISCOVER_V2, (value) => (value as DiscoveryV2).offer({
		kind: "provider", registration: { owner: "fixture", instanceId: "oversized", revision: 1 }, requires: [],
		provider: { id: "fixture", tools: Array.from({ length: 1000 }, (_, i) => ({ ...tool, name: `tool${i}`, availability: { state: "unavailable" } })) },
	}));
	assert.throws(() => collect(other.pi), /registration|budget/);
});

test("v2: withdrawn owners cannot reappear through a legacy-only listener", () => {
	const { pi } = fixture();
	const state = new DiscoveryState();
	const registration = { owner: "fixture", instanceId: "producer", revision: 2 };
	const off = pi.events.on(DISCOVER_V2, (value) => (value as DiscoveryV2).offer({
		kind: "provider", registration, requires: [], provider: { id: "fixture", tools: [tool] },
	}));
	collect(pi, [], state);
	state.withdraw("provider", registration); off();
	pi.events.on(DISCOVER, (value) => (value as { provider(value: unknown): void }).provider({ id: "fixture", tools: [tool] }));
	assert.throws(() => collect(pi, [], state), /Invalid/);
});

test("v2: explicit and implicit policy approval requirements compose", () => {
	const { pi } = fixture();
	registerCodeModeApproval(pi, { id: "permit", approve: () => true });
	registerCodeModePolicy(pi, { id: "guard", approval: "permit", requires: ["approval/1"] });
	assert.equal(collect(pi).policies[0].approval, "permit");
});

test("structural client rejects malformed features before offering and preserves unrelated providers", async () => {
	for (const feature of ["", "future", "Future/1", "future/0", "future/01", "future feature/1", "x".repeat(129) + "/1"]) {
		const f = fixture();
		registerCodeModeTools(f.pi, { id: "healthy", tools: [tool] });
		registerCodeModeContribution(f.pi, "invalid", () => [
			{ ...tool, name: "valid", effect: "read" },
			{ ...tool, effect: "read", requires: [feature] },
		]);
		await f.emit("session_start");
		const catalog = collect(f.pi);
		assert.deepEqual(catalog.tools.map((item) => item.name), ["healthy__lookup"], feature);
		assert(catalog.diagnostics?.some((item) => item.reason === "owner-not-ready"));
		const legacy: unknown[] = [];
		f.pi.events.emit(DISCOVER, { version: 1, provider: (value: unknown) => legacy.push(value), policy() {} });
		assert.equal(legacy.length, 1, "only the unrelated healthy provider may offer to legacy consumers");
		await f.emit("session_shutdown");
	}
});

test("structural client resolves inline executors once per revision, not once per discovery", async () => {
	const f = fixture();
	let resolutions = 0;
	registerCodeModeContribution(f.pi, "fixture", () => {
		resolutions++;
		return [{ ...tool, effect: "read", async invoke() { return { value: "inline" }; } }];
	});
	await f.emit("session_start");
	const state = new DiscoveryState();
	const first = collect(f.pi, [], state).tools[0];
	const second = collect(f.pi, [], state).tools[0];
	assert.equal(first.invoke, second.invoke);
	assert.equal(resolutions, 1);
	await f.emit("model_select");
	assert.notEqual(collect(f.pi, [], state).tools[0].invoke, first.invoke);
	assert.equal(resolutions, 2);
	await f.emit("session_shutdown");
});

for (const structural of [false, true]) test(`v2 conformance: generations, exact receipts and legacy mirrors (structural=${structural})`, async () => {
	const f = fixture();
	if (structural) {
		registerCodeModeContribution(f.pi, "fixture", () => [tool as never]);
		await f.emit("session_start");
	} else registerCodeModeTools(f.pi, { id: "fixture", tools: [tool] });
	const offers: DiscoveryOffer[] = [];
	const current = hello(2);
	const negotiate = (consumer: ConsumerHello) => {
		f.pi.events.emit(DISCOVER_V2, { hello: consumer, offer(offer: DiscoveryOffer) {
			offers.push(offer); return { status: "compatible" };
		} });
	};
	negotiate(current);
	assert.equal(offers.length, 1);
	negotiate(hello(1)); assert.equal(offers.length, 1, "old generation cannot rediscover closures");
	const legacy: unknown[] = [];
	f.pi.events.emit(DISCOVER, { version: 1, consumer: hello(1), provider: (p: unknown) => legacy.push(p), policy() {} });
	assert.equal(legacy.length, 0, "stale v2 hello cannot downgrade via the legacy mirror");
	const receipt = { consumer: current, registration: offers[0].registration };
	f.pi.events.emit(DISCOVER, { version: 1, consumer: current, receipts: [receipt], provider: (p: unknown) => legacy.push(p), policy() {} });
	assert.equal(legacy.length, 0);
	f.pi.events.emit(DISCOVER, { version: 1, consumer: current, receipts: [{ ...receipt, registration: { ...receipt.registration } }],
		provider: (p: unknown) => legacy.push(p), policy() {} });
	assert.equal(legacy.length, 1, "copied identities are not receipts");
	assert.equal(collect(f.pi).tools.length, 1, "v2+v1 does not duplicate the same registration");
	await f.emit("session_shutdown");
});

test("v2: public unsettled effect is structural and blocks queued work before it can start", async () => {
	assert(isUnsettledEffect(unsettledEffect()));
	assert(!isUnsettledEffect({ code: "PI_CODE_MODE_UNSETTLED_EFFECT", version: 2, message: "wrong ABI" }));
	assert(!isUnsettledEffect(new Error("PI_CODE_MODE_UNSETTLED_EFFECT")));
	assert(isUnsettledEffect({ code: "PI_CODE_MODE_UNSETTLED_EFFECT", version: 1, message: "x".repeat(2001) }));
	let effects = 0, fatal = 0;
	const abort = new AbortController();
	const bridge = new ToolBridge([
		{ ...tool, name: "bad", effect: "write", async invoke() {
			throw { code: "PI_CODE_MODE_UNSETTLED_EFFECT", version: 1, message: "different physical module".repeat(200) };
		} },
		{ ...tool, name: "queued", effect: "write", async invoke() { effects++; return { value: null }; } },
	], [], "cell", ".", abort.signal, () => undefined, () => {}, () => { fatal++; });
	const results = await Promise.allSettled([
		bridge.invoke("bad", {}, "first", abort.signal), bridge.invoke("queued", {}, "second", abort.signal),
	]);
	assert(results.every((result) => result.status === "rejected"));
	assert.equal(effects, 0); assert.equal(fatal, 1);
});

test("v2: classified refresh preserves runtime for diagnostics/presentation, coalesces execution and rejects false classification", async (t) => {
	let pi!: ExtensionAPI;
	let registration!: ReturnType<typeof registerCodeModeTools>;
	let invalidations = 0;
	const original = CodeSession.prototype.invalidate;
	t.mock.method(CodeSession.prototype, "invalidate", function (this: CodeSession) {
		invalidations++;
		return original.call(this);
	});
	const f = await piSession(t, { grant: true, host: "/not-started", factoryFirst: true, factory(api) {
		pi = api;
		registration = registerCodeModeTools(api, { id: "fixture", tools: [tool] });
	} });
	const baseline = invalidations;
	const notifications: unknown[] = [];
	pi.events.on(CHANGED_V2, (value) => notifications.push(value));
	const stop = registerCodeModeObserver(pi, { id: "diagnostic", complete() {} });
	stop();
	registration.refresh([{ ...tool, description: "new display" }], "presentation");
	assert.equal(invalidations, baseline);
	assert.throws(() => registration.refresh([{ ...tool, invoke: async () => ({ value: null }) }], "presentation"), /executable/);
	registration.refresh([{ ...tool, description: "execution refresh" }]);
	assert.equal(invalidations, baseline + 1, "withdrawn/ready and v2/v1 mirrors share teardown");
	await f.session.prompt("/code-mode protocol json");
	const settled = invalidations;
	for (const notification of [...notifications]) pi.events.emit(CHANGED_V2, structuredClone(notification));
	assert.equal(invalidations, settled, "cloned notifications remain duplicates after teardown settles");
	assert.deepEqual(f.errors, []);
});

test("v2: diagnostic collection cannot replace the revocation baseline for already-admitted authority", async (t) => {
	let pi!: ExtensionAPI;
	let revision = 1, current = tool;
	let invalidations = 0;
	const original = CodeSession.prototype.invalidate;
	t.mock.method(CodeSession.prototype, "invalidate", function (this: CodeSession) { invalidations++; return original.call(this); });
	const f = await piSession(t, { grant: true, host: "/not-started", factoryFirst: true, factory(api) {
		pi = api;
		api.events.on(DISCOVER_V2, (value) => (value as DiscoveryV2).offer({
			kind: "provider", registration: { owner: "fixture", instanceId: "manual", revision }, requires: [],
			provider: { id: "fixture", tools: [current] },
		}));
	} });
	const baseline = invalidations;
	revision++;
	current = { ...tool, invoke: async () => ({ value: "changed executable" }) };
	await f.session.prompt("/code-mode tools");
	assert.equal(invalidations, baseline + 1, "discovery revokes before replacing an execution baseline");
	pi.events.emit(CHANGED_V2, { protocol: 2, kind: "presentation", phase: "ready",
		registration: { owner: "fixture", instanceId: "manual", revision } });
	await f.session.prompt("/code-mode protocol json");
	assert.equal(invalidations, baseline + 1);
});

test("v2: disposed diagnostic closures cannot receive late receipts", async () => {
	const { pi } = fixture();
	let notifications = 0;
	const stop = registerCodeModeObserver(pi, { id: "audit", complete() { notifications++; } });
	const observer = collect(pi).observers![0];
	stop();
	await observer.complete({ cellId: "cell", toolCallId: "call", name: "tool", state: "completed", queuedAt: 0, settledAt: 1 }, new AbortController().signal);
	assert.equal(notifications, 0);
});
