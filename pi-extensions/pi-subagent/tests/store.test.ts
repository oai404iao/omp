import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { uuidv7 } from "@earendil-works/pi-ai";
import { TreeStore, MAX_PENDING_MESSAGES } from "../src/store.ts";
import { tempRoot } from "./support/fixture.ts";

test("atomic control snapshots survive reopen and failed mutations leave state unchanged", t => {
	const root = tempRoot(t);
	const id = uuidv7();
	const store = new TreeStore(root, id, "root-session");
	store.enqueue({ id: "one", from: "/root", to: "/root", kind: "message", text: "durable", createdAt: "now" });
	const before = readFileSync(join(store.directory, "state.json"), "utf8");
	assert.throws(() => store.update(state => { state.rootMailbox.length = 0; throw new Error("failed mutation"); }), /failed mutation/);
	assert.equal(readFileSync(join(store.directory, "state.json"), "utf8"), before);
	assert.equal(store.mailbox("/root").length, 1);
	const reopened = new TreeStore(root, id, "root-session");
	assert.deepEqual(reopened.snapshot, store.snapshot);
	assert.deepEqual(readdirSync(store.directory).sort(), ["sessions", "state.json"]);
	store.acknowledge("/root", new Set(["one"]));
	assert.equal(new TreeStore(root, id, "root-session").mailbox("/root").length, 0);
});

test("invalid versions and malformed persisted state are rejected", t => {
	const root = tempRoot(t);
	const id = uuidv7();
	const store = new TreeStore(root, id, "root-session");
	const file = join(store.directory, "state.json");
	for (const data of [{ ...store.snapshot, version: 0 }, { ...store.snapshot, rootSessionId: "different" }, { ...store.snapshot, agents: [] }]) {
		writeFileSync(file, JSON.stringify(data));
		assert.throws(() => new TreeStore(root, id, "root-session"), /unsupported or corrupt/);
	}
	assert.throws(() => new TreeStore(root, "../../escape", "root-session"), /identity/);
});

test("mailbox limits are byte-aware, FIFO and duplicate IDs are idempotent", t => {
	const root = tempRoot(t);
	const store = new TreeStore(root, uuidv7(), "root-session");
	const message = { id: "first", from: "/root", to: "/root", kind: "message" as const, text: "one", createdAt: "now" };
	store.enqueue(message);
	store.enqueue(message);
	assert.equal(store.mailbox("/root").length, 1);
	assert.throws(() => store.enqueue({ ...message, id: "oversized", text: "文".repeat(100000) }), /capacity/);
	store.update(state => {
		state.rootMailbox = Array.from({ length: MAX_PENDING_MESSAGES }, (_, n) => ({ ...message, id: String(n) }));
	});
	assert.throws(() => store.enqueue({ ...message, id: "overflow" }), /capacity/);
	assert.deepEqual(store.mailbox("/root").slice(0, 3).map(message => message.id), ["0", "1", "2"]);
});
