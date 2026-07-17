import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	DEFAULT_CODEX_REQUEST_PROFILE,
	resolveCodexRequestProfile,
} from "../src/codex-request-profile.js";

test("Codex request profile defaults to Standard Responses function tools", () => {
	assert.deepEqual(resolveCodexRequestProfile(), DEFAULT_CODEX_REQUEST_PROFILE);
	assert.equal(resolveCodexRequestProfile().patchTransport, "function");
});

test("Codex request profile applies supported explicit overrides", () => {
	assert.deepEqual(resolveCodexRequestProfile({
		responsesMode: "standard",
		patchTransport: "function",
		supportsHostedTools: false,
		supportsParallelTools: false,
	}), {
		responsesMode: "standard",
		patchTransport: "function",
		supportsHostedTools: false,
		supportsParallelTools: false,
	});
});

test("Responses Lite forces hosted and parallel tools off", () => {
	assert.deepEqual(resolveCodexRequestProfile({
		responsesMode: "lite",
		supportsHostedTools: true,
		supportsParallelTools: true,
	}), {
		responsesMode: "lite",
		patchTransport: "function",
		supportsHostedTools: false,
		supportsParallelTools: false,
	});
});

test("packaged apply_patch grammar matches the analyzed Codex grammar", () => {
	const grammar = readFileSync(new URL("../src/providers/codex-apply-patch.lark", import.meta.url), "utf8");
	assert.equal(grammar, `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`);
});