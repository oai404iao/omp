import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readManifest, root } from "./workspaces.mjs";

const expectedHashes = new Map([
  ["LICENSES/Apache-2.0.txt", "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc"],
  ["LICENSES/OpenAI-Codex-NOTICE.txt", "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915"],
  ["LICENSES/DeepSeek-Harness-MIT.txt", "ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be"],
  ["LICENSES/oh-my-pi-MIT.txt", "545636e19386d3d4e0ae6d77354527499999c3ebfbca61b9fa5aa4ead7c0b308"],
  [
    "pi-extensions/pi-codex-minimal-tools/src/providers/codex-apply-patch.lark",
    "d6367f4826ed608c424b0a308f3d6163527df63c22513d089b91863552f8bfeb",
  ],
]);

const errors = [];

function read(path) {
  return readFileSync(resolve(root, path));
}

function text(path) {
  return read(path).toString("utf8");
}

function check(condition, message) {
  if (!condition) errors.push(message);
}

for (const [path, expected] of expectedHashes) {
  const actual = createHash("sha256").update(read(path)).digest("hex");
  check(actual === expected, `${path}: expected sha256 ${expected}, found ${actual}`);
}

for (const filename of ["Apache-2.0.txt", "OpenAI-Codex-NOTICE.txt"]) {
  check(
    read(`LICENSES/${filename}`).equals(
      read(`pi-extensions/pi-codex-minimal-tools/LICENSES/${filename}`),
    ),
    `pi-codex-minimal-tools LICENSES/${filename} differs from the verified root copy`,
  );
}

check(
  read("LICENSES/DeepSeek-Harness-MIT.txt").equals(
    read("pi-extensions/pi-subagent/LICENSES/DeepSeek-Harness-MIT.txt"),
  ),
  "pi-subagent LICENSES/DeepSeek-Harness-MIT.txt differs from the verified root copy",
);

const projectLicense = read("LICENSE");
for (const name of [
  "pi-keep-defaults",
  "pi-subagent",
  "pi-telegram-notify",
  "pi-tree-continue",
]) {
  check(
    projectLicense.equals(read(`pi-extensions/${name}/LICENSE`)),
    `${name}: package LICENSE differs from the project MIT license`,
  );
  check(readManifest(`pi-extensions/${name}`).license === "MIT", `${name}: manifest license must be MIT`);
}

const codexDirectory = "pi-extensions/pi-codex-minimal-tools";
const codexManifest = readManifest(codexDirectory);
const codexLicense = text(`${codexDirectory}/LICENSE`);
const codexNotice = text(`${codexDirectory}/THIRD_PARTY_NOTICES.md`);
check(codexManifest.private === true, "pi-codex-minimal-tools must remain private while source review is incomplete");
check(codexManifest.license === "SEE LICENSE IN LICENSE", "pi-codex-minimal-tools must use its composite LICENSE");
check(codexLicense.includes("Copyright (c) 2026 oai404iao"), "pi-codex-minimal-tools LICENSE lacks project copyright");
check(
  codexNotice.includes("eb9dceba1a2e658142a456c5898836774835616b"),
  "pi-codex-minimal-tools notice lacks the analyzed Codex revision",
);
check(
  codexNotice.includes("03bb3b12367397e14a8facc2e018d645ff4d8e83"),
  "pi-codex-minimal-tools notice lacks the apply-patch compatibility revision",
);
for (const path of ["src/patch/parser.ts", "src/patch/apply.ts"]) {
  check(
    text(`${codexDirectory}/${path}`).includes("Substantially modified TypeScript adaptation"),
    `pi-codex-minimal-tools/${path} lacks its source modification notice`,
  );
}
check(
  codexNotice.includes("must not be published"),
  "pi-codex-minimal-tools notice must retain the unresolved publication warning",
);

const subagentNotice = text("pi-extensions/pi-subagent/THIRD_PARTY_NOTICES.md");
const subagentProvenance = JSON.parse(
  text("pi-extensions/pi-subagent/provenance/deepseek-harness-4d03472.json"),
);
check(
  subagentProvenance.upstream?.repository === "https://github.com/deepseek-ai/deepseek-harness",
  "pi-subagent provenance must name the DeepSeek Harness repository",
);
check(
  subagentProvenance.upstream?.revision === "4d03472cd098dc48a630e526ca620f4f37f18a0e",
  "pi-subagent provenance must name the analyzed DeepSeek Harness revision",
);
check(
  subagentProvenance.files?.LICENSE?.gitBlobSha === "c1f7a78e89e4e4dc7b86664c3b3c76eb5eee1785"
    && subagentProvenance.files?.LICENSE?.sha256 === "ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be"
    && subagentProvenance.files?.LICENSE?.rawUrl === "https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/4d03472cd098dc48a630e526ca620f4f37f18a0e/LICENSE",
  "pi-subagent provenance must retain the verified DeepSeek Harness LICENSE identifiers",
);
check(
  subagentProvenance.files?.["docs/subsystems/subagent.md"]?.gitBlobSha === "9a21cecce9144c3aa4c268d753c0aeff5f3ac178"
    && subagentProvenance.files?.["docs/subsystems/subagent.md"]?.sha256 === "f8210c06d7e21e3981946d84e1914a057728f07f9b291a5e2a4c2a62b645d685"
    && subagentProvenance.files?.["docs/subsystems/subagent.md"]?.rawUrl === "https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/4d03472cd098dc48a630e526ca620f4f37f18a0e/docs/subsystems/subagent.md",
  "pi-subagent provenance must retain the verified DeepSeek Harness subagent-document identifiers",
);
check(
  subagentNotice.includes("4d03472cd098dc48a630e526ca620f4f37f18a0e"),
  "pi-subagent notice lacks the mapped DeepSeek Harness revision",
);
check(
  subagentNotice.includes("No DeepSeek Harness source file is included"),
  "pi-subagent notice must distinguish the design reference from copied source",
);

const externalLicense = text("pi-extensions/external-thinking/LICENSE");
const externalNotice = text("pi-extensions/external-thinking/THIRD_PARTY_NOTICES.md");
const externalManifest = readManifest("pi-extensions/external-thinking");
check(externalManifest.license === "MIT", "external-thinking manifest license must be MIT");
for (const copyright of [
  "Copyright (c) 2025 Mario Zechner",
  "Copyright (c) 2025-2026 Can Bölük",
  "Copyright (c) 2026 oai404iao",
]) {
  check(externalLicense.includes(copyright), `external-thinking LICENSE lacks: ${copyright}`);
}
for (const revision of [
  "10fd42289c3a7dab9db803175e4e4db8321b93a2",
  "848f7fb0fd45b6f7a01a66e4b26ab568251a13a0",
]) {
  check(externalNotice.includes(revision), `external-thinking notice lacks revision ${revision}`);
}

if (errors.length > 0) {
  console.error("License verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("✓ project and package license files are present");
console.log("✓ verified third-party license snapshots and source hashes match");
console.log("✓ unresolved packages retain their private publication guards");
