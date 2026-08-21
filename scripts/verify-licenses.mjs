import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readManifest, root, workspaces } from "./workspaces.mjs";

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

const codexRepository = "https://github.com/openai/codex";
const codexRevision = "eb9dceba1a2e658142a456c5898836774835616b";
const expectedCodexReservedToolSources = {
  LICENSE: {
    gitBlobSha: "4606e72e042564097e8780d66c1d4dcb611869bd",
    sha256: "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc",
  },
  NOTICE: {
    gitBlobSha: "2805899d56d0332d175cfc613c67d45d6f006db7",
    sha256: "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915",
  },
  "codex-rs/ext/web-search/web_run_description.md": {
    gitBlobSha: "77be9a0a03e6e2e2760651e903ead2dce9996a57",
    sha256: "1f3879b44690eb7aad9ba97351acda16c4d0c26847bcb4af2964d5989404407e",
  },
  "codex-rs/ext/web-search/src/tool.rs": {
    gitBlobSha: "9747b75eddd1052ee4d75e868a644de7fd4135c1",
    sha256: "6ce56d7705c4b29b91d9d39af5468788a04dd925b414c7b44de67014f3329cb3",
  },
  "codex-rs/ext/web-search/src/schema.rs": {
    gitBlobSha: "2f71f1595c3b75d21cf78f35877f75b9314a3737",
    sha256: "6371391751d2a5dddad546aa810a6c64f770498702cec8153df74d1d7dff6f9b",
  },
  "codex-rs/codex-api/src/search.rs": {
    gitBlobSha: "237e7a7ebff4a0eeaa6dbb7b94c457d23dfc09de",
    sha256: "a83fd7ddd41c86985cce2aa899a2907ca820c226d5e7337949cc7e47a35c5f4f",
  },
  "codex-rs/ext/image-generation/imagegen_description.md": {
    gitBlobSha: "368aa10ea8f1909f9171b7a7b701bba6321f6f89",
    sha256: "77a992a7c90e45fcd11623a1efa34bfd4c7870697e0aa54ce9b28f690877170e",
  },
  "codex-rs/ext/image-generation/src/lib.rs": {
    gitBlobSha: "fd9db419309e5b06acb944a553f5ef144c8a261d",
    sha256: "c710abe1967cd3f7faaf78c0a35de0f5e6cc5c461f130b79d2b25d27ba8df9de",
  },
  "codex-rs/ext/image-generation/src/tool.rs": {
    gitBlobSha: "ab973da74cec4de053cbe943171bb9ad5703bad6",
    sha256: "8b8abe637c63e1fa8f52340a4609d96f37a5089364c4d82f0e695fd6731b2206",
  },
  "codex-rs/tools/src/responses_api.rs": {
    gitBlobSha: "e450dcf35f93ab4af7bf3f34956755066114ccae",
    sha256: "7af0354e43c3fa7f052d86df5ae0c6ce276569243af6f6ea5fe00abcb15bd244",
  },
  "codex-rs/tools/src/tool_spec.rs": {
    gitBlobSha: "530da1be164ce3c6aa4b128ccb878bda7025e217",
    sha256: "af8b5286fb6d2eb3574c484b25076f515bca2d4350ecb5059e436966ecdd519d",
  },
  "codex-rs/core/src/client.rs": {
    gitBlobSha: "da3b6dad382fd4520026ac447c270e5cc11fa887",
    sha256: "4b4d00234a7fb649525fdcc913ffe288e4ef3348a916acbd265c22607fd8652d",
  },
  "codex-rs/Cargo.toml": {
    gitBlobSha: "f23232e3d0b8246330d2409fc7fe9690062075c2",
    sha256: "2e8122fdd528a4d648d9417865153827dc5f7b45ee3afd86bfb129a1e01dcdb8",
  },
  "codex-rs/Cargo.lock": {
    gitBlobSha: "a67d1f3d7b062424d881a612f4cfd8b14e0ac630",
    sha256: "3a4a5361f289227c1ce09dc072811a1e7d1c7b599c58dd91dce6758d187c993d",
  },
};
const expectedCodexReservedToolFingerprints = {
  web_search: {
    namespace: "web",
    function: "run",
    descriptionSource: "codex-rs/ext/web-search/web_run_description.md",
    descriptionSha256: "1f3879b44690eb7aad9ba97351acda16c4d0c26847bcb4af2964d5989404407e",
    parametersSha256: "de3be87e7abfe9b67ba757f27804d4206b51c2a8de9e9799fa7db9ef4abe3539",
    namespaceSha256: "f67597d3df3f3a77cb517646508e7305804ea029c6f8b1c1c1f241f0de0b214f",
  },
  image_generation: {
    namespace: "image_gen",
    function: "imagegen",
    descriptionSource: "codex-rs/ext/image-generation/imagegen_description.md",
    descriptionSha256: "77a992a7c90e45fcd11623a1efa34bfd4c7870697e0aa54ce9b28f690877170e",
    parametersSha256: "b4fea7c38ae74635e0072643ac2030899db242657071271e13cdd192a7377a27",
    namespaceSha256: "ccc508cff0a216bbdf368be8c98be94134a1aed0479cddd28c77d8e004f5b73e",
  },
};

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
const codexReservedTools = text(`${codexDirectory}/src/codex-reserved-tools.ts`);
const codexReservedProvenancePath =
  `${codexDirectory}/provenance/openai-codex-eb9dceba-reserved-tools.json`;
const codexReservedProvenance = JSON.parse(text(codexReservedProvenancePath));
const codexWorkspace = workspaces.find(({ name }) => name === "@oai404iao/pi-codex-minimal-tools");
check(
  codexManifest.private !== true,
  "pi-codex-minimal-tools must be non-private for its approved npm bootstrap",
);
check(
  codexWorkspace?.releaseStatus === "bootstrap",
  "pi-codex-minimal-tools must remain on the local-only bootstrap release track",
);
check(codexManifest.license === "SEE LICENSE IN LICENSE", "pi-codex-minimal-tools must use its composite LICENSE");
check(codexLicense.includes("Copyright (c) 2026 oai404iao"), "pi-codex-minimal-tools LICENSE lacks project copyright");
check(
  codexManifest.files?.includes("provenance/"),
  "pi-codex-minimal-tools must package its Codex provenance record",
);
check(
  codexNotice.includes(codexRevision),
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
  codexReservedTools.includes("SPDX-License-Identifier: Apache-2.0")
    && codexReservedTools.includes("Modified TypeScript compatibility serialization"),
  "pi-codex-minimal-tools reserved-tool serialization lacks its Apache modification notice",
);
check(
  codexNotice.includes("Modified namespace-tool compatibility serialization")
    && codexNotice.includes("internal Responses Lite path")
    && /one-time manual npm\s+bootstrap/.test(codexNotice),
  "pi-codex-minimal-tools notice must retain its source map, Lite warning, and bootstrap guard",
);
check(
  codexReservedProvenance.upstream?.repository === codexRepository
    && codexReservedProvenance.upstream?.revision === codexRevision
    && codexReservedProvenance.upstream?.commitUrl === `${codexRepository}/commit/${codexRevision}`
    && codexReservedProvenance.upstream?.license === "Apache-2.0",
  "pi-codex-minimal-tools provenance must identify the pinned Apache-2.0 Codex source",
);
for (const [path, expected] of Object.entries(expectedCodexReservedToolSources)) {
  const actual = codexReservedProvenance.files?.[path];
  const expectedRawUrl = `https://raw.githubusercontent.com/openai/codex/${codexRevision}/${path}`;
  check(
    actual?.gitBlobSha === expected.gitBlobSha
      && actual?.sha256 === expected.sha256
      && actual?.rawUrl === expectedRawUrl,
    `pi-codex-minimal-tools provenance must retain verified identifiers for ${path}`,
  );
}
for (const [name, expected] of Object.entries(expectedCodexReservedToolFingerprints)) {
  const actual = codexReservedProvenance.localCompatibilitySerialization?.namespaces?.[name];
  check(
    actual?.namespace === expected.namespace
      && actual?.function === expected.function
      && actual?.description?.sourcePath === expected.descriptionSource
      && actual?.description?.sha256 === expected.descriptionSha256
      && actual?.parameters?.canonicalJsonSha256 === expected.parametersSha256
      && actual?.canonicalJsonSha256 === expected.namespaceSha256,
    `pi-codex-minimal-tools provenance must retain the ${name} compatibility fingerprint`,
  );
}

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
console.log("✓ private packages retain their publication guards");
