import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const [, , flag, repository, ...rest] = process.argv;
assert(flag === "--repo" && repository && !rest.length, "usage: node scripts/build-code-mode-host.mjs --repo /path/to/openai/codex");
assert(process.platform === "linux" && process.arch === "x64", "This recipe builds a local Linux x64 GNU artifact, not musl");
const source = "be2951ea34f0d295ed0becf97079f92fa5f6950e";
const patch = "aaa2cabfbcb8d9997ce67e166f796f46d5b72342";
const patchSha256 = "4002429516d3048b8d19687f8c8016cd4e04a7cac4a24101e5fd57341456ba3d";
const sourceLockSha256 = "81eb29f6276d5b3d1b39f1588a26059dadfbba717952247efeb8a575f271f569";
const repairedLockSha256 = "df88a71b82843c6f092610fb07589f7a40032ddc25f50718354546ca541eb9b7";
const v8ManifestSha256 = "6774b42c9424c098c72a805c08d4e94be17c591cf02b1dc2633060255a8a61be";
const v8Assets = {
  "librusty_v8_ptrcomp_sandbox_release_x86_64-unknown-linux-gnu.a.gz": "a35c75d1f26e6a983885a45b33490a4ebe54f05050568b32b89cfb421b30b583",
  "src_binding_ptrcomp_sandbox_release_x86_64-unknown-linux-gnu.rs": "7727826ae479bdb645e807239fb12d1f8e2e23de7a6cf16f5ee592690d1d8506",
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const parent = join(homedir(), ".local/state/agents/tmp");
mkdirSync(parent, { recursive: true, mode: 0o700 });
const task = mkdtempSync(join(parent, "code-mode-patched-build-"));
chmodSync(task, 0o700);
console.log(`Retained build directory: ${task}`);
const env = {
  ...process.env, TMPDIR: join(task, "tmp"), CARGO_TARGET_DIR: join(task, "target"),
  CARGO_INCREMENTAL: "0", CARGO_PROFILE_RELEASE_DEBUG: "0",
  CARGO_PROFILE_RELEASE_LTO: "false", CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
  CARGO_PROFILE_RELEASE_STRIP: "symbols",
};
for (const key of ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"]) delete env[key];
mkdirSync(env.TMPDIR);
const tree = join(task, "source");
mkdirSync(tree);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { env, maxBuffer: 256 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${command} failed (${result.signal ?? result.error ?? result.status}); see retained build output`);
  return result.stdout;
}
const repo = resolve(repository);
const archive = run("git", ["-C", repo, "archive", source]);
run("tar", ["-x", "-C", tree], { input: archive });
const changes = run("git", ["-C", repo, "show", "--format=", "--binary", patch]);
assert.equal(hash(changes), patchSha256);
writeFileSync(join(task, "v8-workaround.patch"), changes, { mode: 0o600 });
run("git", ["-C", tree, "apply", "--check", "-"], { input: changes });
run("git", ["-C", tree, "apply", "-"], { input: changes });
const cwd = join(tree, "codex-rs");
const regressionPath = join(cwd, "code-mode-runtime/tests/array_sort.rs");
const regression = readFileSync(regressionPath, "utf8");
assert(regression.includes("let service = InProcessCodeModeSession::new();"));
assert(regression.includes("            Arc::new(NoopCodeModeSessionDelegate),\n"));
// The stable branch takes its delegate at construction, not per execute.
const adaptedRegression = regression
  .replace("let service = InProcessCodeModeSession::new();",
    "let service = InProcessCodeModeSession::with_delegate(Arc::new(NoopCodeModeSessionDelegate));")
  .replace("            Arc::new(NoopCodeModeSessionDelegate),\n", "");
writeFileSync(regressionPath, adaptedRegression);
const v8Directory = join(task, "v8");
mkdirSync(v8Directory);
const manifestName = "rusty_v8_ptrcomp_sandbox_release_x86_64-unknown-linux-gnu.sha256";
for (const [name, digest] of Object.entries({ [manifestName]: v8ManifestSha256, ...v8Assets })) {
  const file = join(v8Directory, name);
  run("curl", ["--fail", "--location", "--silent", "--show-error", "--connect-timeout", "20", "--max-time", "180",
    `https://github.com/openai/codex/releases/download/rusty-v8-v150.4.0/${name}`, "--output", file]);
  assert.equal(hash(readFileSync(file)), digest, `V8 identity mismatch: ${name}`);
}
env.RUSTY_V8_ARCHIVE = join(v8Directory, Object.keys(v8Assets)[0]);
env.RUSTY_V8_SRC_BINDING_PATH = join(v8Directory, Object.keys(v8Assets)[1]);
const lockPath = join(cwd, "Cargo.lock");
const lock = readFileSync(lockPath, "utf8");
assert.equal(hash(lock), sourceLockSha256);
// Release tags change workspace versions but retain 0.0.0 in the upstream lock.
// Repair only source-less workspace entries; no external dependency resolution.
const repaired = lock.split("[[package]]").map((part) => /^source = /m.test(part)
  ? part : part.replace(/^version = "0\.0\.0"$/m, 'version = "0.155.1"')).join("[[package]]");
assert.equal(hash(repaired), repairedLockSha256);
writeFileSync(lockPath, repaired);
const rust = run("rustc", ["+1.95.0", "-vV"], { cwd, encoding: "utf8" });
assert.match(rust, /host: x86_64-unknown-linux-gnu/);
const startedAt = new Date().toISOString();
run("cargo", ["+1.95.0", "build", "--locked", "--release", "-j", "2", "-p", "codex-code-mode-host"], { cwd, stdio: "inherit" });
run("cargo", ["+1.95.0", "test", "--locked", "--release", "-j", "2", "-p", "codex-code-mode-runtime", "--test", "array_sort"], { cwd, stdio: "inherit" });
const binary = join(env.CARGO_TARGET_DIR, "release/codex-code-mode-host");
const bytes = readFileSync(binary);
const provenance = {
  release: "rust-v0.155.1+pi-v8-sort.1", source, patch, patchSha256,
  sourceLockSha256, repairedLockSha256, v8ManifestSha256, v8Assets,
  regressionSourceSha256: hash(adaptedRegression), rust, startedAt, completedAt: new Date().toISOString(),
  target: "x86_64-unknown-linux-gnu", profile: "release; debug=0,lto=false,codegen-units=16,strip=symbols",
  sha256: hash(bytes), bytes: bytes.length, binary,
  regression: "codex-code-mode-runtime --test array_sort passed",
};
writeFileSync(join(task, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(provenance, null, 2));
console.log("Candidate only: this script does not change the production manifest or authorize execution.");
