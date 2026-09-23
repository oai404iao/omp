import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, getCurrentTools, type SystemMessage } from "@earendil-works/pi-ai";
import { piSession } from "./helpers.ts";
import { grammarResponse } from "./grammar-fixtures.ts";

const systemMessages = (messages: readonly { role: string }[]) =>
	messages.filter((message): message is SystemMessage => message.role === "system");

for (const factoryFirst of [false, true]) {
	test(`Code Mode contributes a stable section and respects forced prompts (other factory first: ${factoryFirst})`, async (t) => {
		const originalFetch = globalThis.fetch;
		const requests: string[] = [];
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			assert.equal(new URL(request.url).origin, "https://s1-fixture.invalid");
			requests.push(await request.text());
			return grammarResponse("openai-completions");
		};
		t.after(() => { globalThis.fetch = originalFetch; });
		let force = false;
		const f = await piSession(t, {
			grant: true, host: "/not-started", factoryFirst,
			factory(pi) {
				pi.on("before_agent_start", (event) => {
					event.systemPromptOptions.sections.other = "OTHER_SECTION";
					if (force) return { systemPrompt: "EXACT_FORCED_PROMPT" };
				});
			},
		});
		await f.session.prompt("First");
		const first = systemMessages(f.session.messages);
		const section = first[0]!.sections?.code_mode;
		assert.match(section!, /^<code_mode>\nCode Mode local root:/);
		assert.doesNotMatch(section!, /cells: \[/);
		assert.match(requests[0]!, /Code Mode local root/);
		assert.match(requests[0]!, /OTHER_SECTION/);
		await f.session.prompt("Second");
		assert.equal(systemMessages(f.session.messages).length, first.length, "stable instructions do not create prompt patches");
		force = true;
		await f.session.prompt("Forced");
		assert.match(requests.at(-1)!, /EXACT_FORCED_PROMPT/);
		assert.doesNotMatch(requests.at(-1)!, /Code Mode local root|OTHER_SECTION/);
		assert.match(getCurrentSystemPrompt(f.session.messages), /Code Mode local root/);
		force = false;
		await f.session.prompt("/code-mode off");
		await f.session.prompt("Disabled");
		const patch = systemMessages(f.session.messages).at(-1)!;
		assert.equal(patch.sections?.code_mode, null);
		assert.match(getCurrentSystemPrompt(f.session.messages), /OTHER_SECTION/);
		assert.doesNotMatch(getCurrentSystemPrompt(f.session.messages), /Code Mode local root/);
		assert(!getCurrentTools(f.session.messages).some((tool) => tool.name === "exec"));
		assert.deepEqual(f.errors, []);
	});
}

for (const automatic of [false, true]) test(`Code Mode section survives ${automatic ? "automatic" : "manual"} compaction and grammar/JSON changes`, async (t) => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		assert.equal(new URL(new Request(input, init).url).origin, "https://s1-fixture.invalid");
		return grammarResponse("openai-responses");
	};
	t.after(() => { globalThis.fetch = originalFetch; });
	let pi!: ExtensionAPI;
	const compactions: string[] = [];
	const f = await piSession(t, {
		grant: true, host: "/not-started", api: "openai-responses", grammar: true, protocol: "auto",
		factory(api) {
			pi = api;
			api.on("session_before_compact", (event) => {
				compactions.push(event.reason);
				return { compaction: { summary: "Fixture summary", firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore } };
			});
		},
	});
	await f.session.prompt("First");
	const prompt = getCurrentSystemPrompt(f.session.messages);
	assert.match(prompt, /<code_mode>/);
	await f.session.prompt("/code-mode protocol json");
	await f.session.prompt("JSON");
	assert.equal(systemMessages(f.session.messages).filter((message) => message.sections?.code_mode).length, 1);
	assert.equal(getCurrentTools(f.session.messages).find((tool) => tool.name === "exec")?.constrainedSampling, false);
	f.session.settingsManager.applyOverrides({ compaction: { enabled: automatic, keepRecentTokens: 1, reserveTokens: 0 } });
	if (automatic) {
		await f.session.setModel({ ...f.session.model!, contextWindow: 1 });
		await f.session.prompt("Trigger automatic compaction");
	} else await f.session.compact();
	assert(compactions.includes(automatic ? "threshold" : "manual"));
	f.session.settingsManager.applyOverrides({ compaction: { enabled: false } });
	assert.match(getCurrentSystemPrompt(f.session.messages), /<code_mode>/);
	assert(getCurrentTools(f.session.messages).some((tool) => tool.name === "exec"));
	await f.session.prompt("/code-mode protocol auto");
	await f.session.prompt("Grammar again");
	assert(getCurrentTools(f.session.messages).find((tool) => tool.name === "exec")?.constrainedSampling);
	pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "exec"));
	await f.session.prompt("/code-mode off");
	await f.session.prompt("No authority from history");
	assert.doesNotMatch(getCurrentSystemPrompt(f.session.messages), /<code_mode>/);
	assert(!getCurrentTools(f.session.messages).some((tool) => tool.name === "exec"));
	assert.deepEqual(f.errors, []);
});

test("unavailable grammar and a fresh resumed instance without grants remove the historical section", async (t) => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		assert.equal(new URL(new Request(input, init).url).origin, "https://s1-fixture.invalid");
		return grammarResponse("openai-completions");
	};
	t.after(() => { globalThis.fetch = originalFetch; });
	const first = await piSession(t, { grant: true, host: "/not-started" });
	await first.session.prompt("Authorized");
	const entries = structuredClone(first.session.sessionManager.getEntries());
	assert.match(getCurrentSystemPrompt(first.session.messages), /<code_mode>/);
	await first.session.prompt("/code-mode protocol grammar");
	await first.session.prompt("Grammar unavailable");
	assert.doesNotMatch(getCurrentSystemPrompt(first.session.messages), /<code_mode>/);

	const resumed = await piSession(t, {
		cwd: first.cwd,
		sessionManager: SessionManager.inMemory(first.cwd, {}, entries),
	});
	assert.match(getCurrentSystemPrompt(resumed.session.messages), /<code_mode>/, "fixture restores historical model context");
	assert(!resumed.session.getAllTools().some((tool) => tool.name === "exec"));
	await resumed.session.prompt("History cannot authorize this instance");
	assert.doesNotMatch(getCurrentSystemPrompt(resumed.session.messages), /<code_mode>/);
	assert(!getCurrentTools(resumed.session.messages).some((tool) => tool.name === "exec"));
	assert.deepEqual([...first.errors, ...resumed.errors], []);
});
