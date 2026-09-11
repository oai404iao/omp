import assert from "node:assert/strict";
import test from "node:test";
import {
	descriptorTaskPath,
	numberedTaskName,
	resolveTaskPath,
	slugTaskName,
	taskPath,
	validateTaskName,
	validateTaskPath,
} from "../src/task-path.ts";


test("task paths validate canonical names and nested roots", () => {
	assert.equal(validateTaskName("review_auth-2"), "review_auth-2");
	assert.equal(taskPath("/root/review", "auth"), "/root/review/auth");
	assert.equal(validateTaskPath("/root/review/auth"), "/root/review/auth");
	assert.throws(() => validateTaskName("Review"), /lowercase ASCII/);
	assert.throws(() => validateTaskName("root"), /reserved/);
	assert.throws(() => validateTaskPath("/other/review"), /rooted at/);
	assert.throws(() => validateTaskPath("/root/review/"), /canonical/);
});

test("relative task references resolve without escaping root", () => {
	assert.equal(
		resolveTaskPath("/root/review", "auth"),
		"/root/review/auth",
	);
	assert.equal(
		resolveTaskPath("/root/review/auth", "../tests"),
		"/root/review/tests",
	);
	assert.equal(
		resolveTaskPath("/root/review", "/root/other"),
		"/root/other",
	);
	assert.throws(
		() => resolveTaskPath("/root", "../outside"),
		/cannot escape/,
	);
	assert.throws(
		() => resolveTaskPath("/root/review", "bad//path"),
		/empty segment/,
	);
});

test("generated task names are readable, bounded, and disambiguated", () => {
	assert.equal(slugTaskName("Inspect OAuth callback"), "inspect-oauth-callback");
	assert.equal(slugTaskName("你好"), "task");
	assert.equal(numberedTaskName("inspect-auth", 2), "inspect-auth-2");
	assert.equal(numberedTaskName("x".repeat(64), 12).length, 64);
});


