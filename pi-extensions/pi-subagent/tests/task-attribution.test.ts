import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inboxEnvelope, persistTaskAttribution, taskMessage } from "../src/task-attribution.ts";
import { MESSAGE_CUSTOM_TYPE } from "../src/store.ts";
import type { MailMessage } from "../src/types.ts";

test("task attribution is synchronously captured and detached from the caller snapshot", () => {
	const cause = { parentTurnId: "parent", rootTurnId: "root" };
	const pi = { events: { emit(name: string, request: any) {
		assert.equal(name, "@oai404iao/pi-codex:turn-attribution:v1");
		assert.equal(request.sessionId, "caller-session");
		request.accept(cause);
	} } } as unknown as ExtensionAPI;
	const message = taskMessage(pi, "/root/sender", "/root/worker", "work", "caller-session");
	cause.parentTurnId = "later";
	assert.deepEqual(message.codexTurnAttribution, { parentTurnId: "parent", rootTurnId: "root" });
	assert.equal(message.kind, "task");
});

test("missing Codex integration keeps task delivery functional", () => {
	const pi = { events: { emit() {} } } as unknown as ExtensionAPI;
	assert.equal(taskMessage(pi, "/root", "/root/worker", "work", "session").codexTurnAttribution, undefined);
});

test("FIFO task attribution ignores ordinary mail and clears an older cause when absent", () => {
	const session = SessionManager.inMemory();
	const message = (id: string, kind: MailMessage["kind"], parentTurnId?: string): MailMessage => ({
		id, kind, from: "/root", to: "/root/worker", text: id, createdAt: "fixture",
		...(parentTurnId ? { codexTurnAttribution: { parentTurnId } } : {}),
	});
	const messages = [message("context", "message", "ignored"), message("first", "task", "first"),
		message("second", "task", "second")];
	persistTaskAttribution(session, messages);
	assertEntry(session, { version: 1, parentTurnId: "first" });
	const envelope = inboxEnvelope("tree", messages);
	assert.equal(envelope.customType, MESSAGE_CUSTOM_TYPE);
	assert.deepEqual(envelope.details.codexTurnAttribution, { parentTurnId: "first" });
	assert.deepEqual(envelope.details.messageIds, ["context", "first", "second"]);
	persistTaskAttribution(session, [message("new", "task"), message("later", "task", "ignored")]);
	assertEntry(session, { version: 1 });
});

function assertEntry(session: SessionManager, data: unknown) {
	const entry = session.getEntries().at(-1);
	assert.equal(entry?.type, "custom");
	if (entry?.type === "custom") {
		assert.equal(entry.customType, "pi-codex/turn-attribution");
		assert.deepEqual(entry.data, data);
	}
}
