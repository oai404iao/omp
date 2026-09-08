import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkArchitecture, findCycles, moduleReferences } from "./check-codex-architecture.mjs";

test("module references include type, dynamic and re-export edges, not comments or strings", () => {
  assert.deepEqual(moduleReferences(`
    import type { A } from "./a.js";
    export { b } from "./b.js";
    export * from "./all.js";
    type C = import("./c.js").C;
    const d = import("./d.js");
    const e = require("./e.js");
    import f = require("./f.js");
    // import bad from "./comment.js";
    const text = 'import bad from "./string.js"';
    const template = \`import bad from "./template.js"\`;
  `), ["./a.js", "./b.js", "./all.js", "./c.js", "./d.js", "./e.js", "./f.js"]);
});

test("cycle detection accepts diamonds and rejects cycles including self-imports", () => {
  assert.deepEqual(findCycles(new Map([
    ["a", ["b", "c"]], ["b", ["d"]], ["c", ["d"]], ["d", []],
  ])), []);
  assert.deepEqual(findCycles(new Map([["a", ["b"]], ["b", ["a"]]])), [["a", "b", "a"]]);
  assert.deepEqual(findCycles(new Map([["a", ["a"]]])), [["a", "a"]]);
});

function withSources(files, callback) {
  const directory = mkdtempSync(join(tmpdir(), "omp-architecture-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      const path = join(directory, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const policy = { maxLines: 3, exceptions: {}, facades: ["facade.ts"], forbidden: [] };

test("relative .js edges resolve to TS and cannot go back through facades", () => {
  withSources({
    "facade.ts": 'export { a } from "./impl/a.js";',
    "impl/a.ts": 'import type { A } from "../facade.js";\nexport const a = 1;',
  }, (directory) => {
    const { errors } = checkArchitecture(directory, policy);
    assert.ok(errors.some(e => e.includes("compatibility facade")));
    assert.ok(errors.some(e => e.includes("cycle:")));
  });
});

test("missing modules and forbidden layer edges fail closed", () => {
  withSources({
    "low/a.ts": 'import "../missing.js";\nimport "../high/b.js";',
    "high/b.ts": "export {};",
  }, (directory) => {
    const { errors } = checkArchitecture(directory, {
      ...policy, forbidden: [{ from: "low/", to: "high/" }],
    });
    assert.equal(errors.length, 2);
    assert.match(errors[0], /unresolved local module/);
    assert.match(errors[1], /forbidden dependency/);
  });
});

test("compatibility facades cannot accumulate implementation or singleton state", () => {
  withSources({ "facade.ts": "export const cache = new Map();\n" }, (directory) => {
    assert.ok(checkArchitecture(directory, policy).errors.some(e => e.includes("only re-exports")));
  });
});

test("line budgets reject growth, undocumented exceptions and obsolete exceptions", () => {
  withSources({ "a.ts": "// a\n// b\n// c\n// d\n" }, (directory) => {
    assert.match(checkArchitecture(directory, policy).errors[0], /4 lines exceeds 3/);
    assert.deepEqual(checkArchitecture(directory, {
      ...policy, exceptions: { "a.ts": { maxLines: 4, reason: "Existing state machine" } },
    }).errors, []);
    assert.ok(checkArchitecture(directory, {
      ...policy, exceptions: { "a.ts": { maxLines: 4 } },
    }).errors.some(e => e.includes("rationale")));
    assert.ok(checkArchitecture(directory, {
      ...policy, exceptions: { "missing.ts": { maxLines: 4, reason: "Removed" } },
    }).errors.some(e => e.includes("stale")));
  });
  withSources({ "a.ts": "export {};\n" }, (directory) => {
    assert.ok(checkArchitecture(directory, {
      ...policy, exceptions: { "a.ts": { maxLines: 4, reason: "Already reduced" } },
    }).errors.some(e => e.includes("unnecessary")));
  });
});
