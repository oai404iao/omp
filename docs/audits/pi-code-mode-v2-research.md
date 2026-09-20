# Pi Code Mode 第二轮研究记录

状态：**研究/设计，不是 0.155.1 全量升级验收**。
本仓库基线 `ac5c2e51`；方案见 [v2 计划](../plans/pi-code-mode-v2.md)。
本轮未修改 runtime pin、包版本、release lock 或试用 Pi 配置。

用户最新指定目标为 **rust-v0.155.1**。以下先保留已有 0.154.0 研究，
本轮重新获取资产、检查源码与执行探针的结果在
[0.155.1 复核](#01551-复核当前目标)；旧 smoke 不作为新版本验收。

## 前期 0.154.0 来源固定

- Codex tag `rust-v0.154.0`：
  `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`，通过 `git show/archive` 读取，
  未 checkout/修改研究仓库。
- Codex 本地 main `7498521d28` 与 tag 分开；tag 不是本地 main 的祖先。
- howaboua `4593f066d447925eae8e3106435f117236690f9e`，只读。
- 官方 [0.154.0 release](https://github.com/openai/codex/releases/tag/rust-v0.154.0)
  与 [GitHub release API](https://api.github.com/repos/openai/codex/releases/tags/rust-v0.154.0)。
  API 中 published_at 为 `2026-09-09T22:35:38Z`。
- 旧 `rust-v0.145.0` 正式 tag/commit 不在本地 Codex git objects 中；
  不拿 alpha tag 假冒精确旧版。既有旧版事实保留 S0–S4 provenance。

## 资产核验

官方 Linux x64 musl tar.gz asset：

| 项目 | 值 |
| --- | --- |
| 文件 | `codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz` |
| 字节数 | `25729904` |
| API SHA-256 | `a68df7cca23c6da7cde175677df7de61c73a234add1333a1254b86d641af01f7` |
| 缓存 archive 实算 SHA-256 | 同上 |
| archive 内容 | 单个 `codex-code-mode-host-x86_64-unknown-linux-musl` |
| 解出 binary 字节数 | `69431360` |
| 解出 binary SHA-256 | `0c57be435e73b70d9106c850d751cd259a7f04da958a453d7ef59090d82b70f1` |

缓存 archive 来自 `/home/u/.cache/yay/openai-codex-bin/`；本轮先从 GitHub API
独立取得 digest 再比较，不单凭 AUR PKGBUILD 信任缓存。解压写入新的研究目录，
没有替换系统程序。此举验证字节身份，**没有验证 Sigstore attestation 或
可复现构建**，也不是漏洞审计。

本机 `/usr/bin/codex-code-mode-host` 归属 `openai-codex-bin 0.154.0-1`：
同样大小，但哈希是
`80aa409ac82ad11037de447af2da0bbb9da54e3bc35bab9190a6c955237a2b71`。
这是另一个产物，不能把缓存 archive 中的原始 hash 错归给 `/usr/bin`。
本轮没有验证发行版重新打包为何改变字节。

## 实际有界探针

证据目录：
`/home/u/.local/state/agents/tmp/code-mode-v2-design.GXuKtbPk/`。

保留：

- `release-0.154.0.json`、`release-0.145.0.json`；
- 解出的官方 Host、`upstream-154/` 选定源码快照；
- `probe-host-154.mjs`、`probe.log`、`probe-results.json`；
- `limits.jsonl`、`units.jsonl`（S0 lab helper 的任务专属记录）。

探针复用项目已有 S0 lab client，而非放松 production 的 0.145 pin。
两次 Host 均由 systemd user transient service 启动：

- 192 MiB memory、swap 0、64 tasks、CPU 100%、20s 独立 RuntimeMax；
- 执行前检查 cgroup kernel 文件及 MainPID membership；
- 最后停止该任务专属 unit；无 credential/env 继承、无 shell/provider/network tool。

结束后检查 `systemctl --user list-units 'omp-code-mode-s0-*' --all --no-legend`，
输出为空。这里只检查/停止本实验单位，没有清理其他任务目录。

实际命令：

```sh
CODE_MODE_S0_DIR=/home/u/.local/state/agents/tmp/code-mode-v2-design.GXuKtbPk \
CODE_MODE_S0_HOST=/home/u/.local/state/agents/tmp/code-mode-v2-design.GXuKtbPk/codex-code-mode-host-x86_64-unknown-linux-musl \
TMPDIR=/home/u/.local/state/agents/tmp/code-mode-v2-design.GXuKtbPk \
node /home/u/.local/state/agents/tmp/code-mode-v2-design.GXuKtbPk/probe-host-154.mjs
```

结果 **PASS**：

1. protocol V1 + 空 required/optional capabilities 得到空 capabilities。
   旧式 open/execute 字段可用，不是升级后必然握手失败。
2. 授权的 synthetic echo 工具 delegate、文本输出完成；
   Result 带数字 `code_mode_host_duration_ns`。
3. ALL_TOOLS 列出 echo name/description；notify/yield_control/exit/image/audio
   globals 的 typeof 为 function。这里只验证存在，不是 Pi 支持全部语义。
4. A、B 两 cell 先各 yield，再分别 wait 结束；写不同 store key，
   后续 cell 读到 `[1,2]`。不是通过静态 128 上限推测多 cell。
5. 请求 `session-cell-execution-resource-limits` 后 Host 回应该 capability；
   `session/open.cellExecutionLimits.maxYieldTimeMs=50` 被接受。
   500ms JS timer、请求 1000ms yield，首次约 **55ms** 返回 Yielded；
   后续 wait 返回 done。这是单次 smoke 观测，不是性能基准。

## 已知风险与研究校正

- 0.154 runtime `service.rs` 接受 limits 后把 `max_heap_size_bytes` 设为 None；
  不能宣传 V8 heap limit 已生效。此项来自 tag 源码，本轮未再做分配压力测试。
- [后续 V8 规避补丁](https://github.com/openai/codex/commit/aaa2cabfbcb8d9997ce67e166f796f46d5b72342)
  `aaa2cabfbc` 不在 0.154.0 tag 内。未运行漏洞复现，不把普通 JS smoke 当修复证明。
- Pi 当前 `Runtime.delegate()` 会将 notify 拒绝编码成 delegate error，
  不应误报为“notify 立刻 wire.fail”；非文本输出与未捕获 script error
  才会触发现有 run catch/reset。
- Host 已提供 ALL_TOOLS，不应再通过源码前缀注入同名 helper。
- 输出预算、script error、IPC 错误、未知 cell 的恢复性必须分开设计。

## 没有运行的验证

- 未运行基于 0.154 的完整 `test:host`、package check、完整 CI/Pi matrix、
  production tarball 安装；生产 pin 未改，不能将 0.145 的历史通过结果套用。
- 未做新 Host OOM/watchdog fault injection、模型/树/reload全套回归。
- 未调用真实 provider、没有模型费用/搜索/patch/进程业务副作用。
- 未构建 Rust、验证签名、跑 V8 风险回归，未宣布 0.154 安全发布可用。

## 0.155.1 复核（当前目标）

### 范围与版本

开始时工作区已在 `docs/code-mode-v2-plan`，有未提交的 0.154.0 方案和本记录。
本轮沿用该设计分支、保留历史研究，只更新当前目标及新增证据。
原草案另备份在本轮 scratch；没有还原/覆盖无关代码。

研究仓库 `/home/u/dev/research/codex` 开始/结束均干净，main 保持
`5c5308fc9a`。执行：

```sh
git -C /home/u/dev/research/codex fetch origin \
  tag rust-v0.155.1 tag rust-v0.155.0 tag rust-v0.154.0
```

以 `git archive rust-v0.155.1` 提取选定源码到 scratch，不切换研究工作树。
当前目标精确 commit：
`be2951ea34f0d295ed0becf97079f92fa5f6950e`。

[官方 release](https://github.com/openai/codex/releases/tag/rust-v0.155.1)
与 [release API](https://api.github.com/repos/openai/codex/releases/tags/rust-v0.155.1)
均已核对；API `published_at=2026-09-18T20:03:04Z`。
release 的主要修复是 TUI reasoning-summary 默认值，并非 Code Mode 专项升级。
0.155.0→0.155.1 完整 tree diff 仅 Cargo.toml 与两份 TUI 文件。

### 官方资产身份

| 项目 | 值 |
| --- | --- |
| 文件 | `codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz` |
| GitHub asset ID | `573353494` |
| 压缩包字节数 | `25727325` |
| API 及本机实算 archive SHA-256 | `9fd083743af55be818aceb351d371fb5136f5b6aa3938f167087373d27067b2d` |
| 解出 binary 字节数 | `69423168` |
| 本机实算 binary SHA-256 | `210ab8ebaebf4bc1421d9e30339c858354ca35fa91e2f87f4c6204e5382f8a63` |

官方压缩包本轮独立下载，先验证 SHA-256、列出唯一 archive member，再解出。
未替换 `/usr/bin`、0.145 production pin 或旧试用配置。
release 另有 `.sigstore` asset，但本轮**未验证签名/构建 provenance**，
不能把 API digest + hash 一致说成供应链完全验证。

### 精确源码差分

`git diff rust-v0.154.0 rust-v0.155.1`：

- `code-mode-protocol/`、`code-mode-host/`、`code-mode/src/`、
  `tools/src/code_mode.rs` 没有差异。
- `code-mode-runtime/src/runtime/value.rs:296–303` 增加 undefined 提前返回
  None；对应测试 `storing_undefined_preserves_the_previous_value`。
- Codex core 才有更多集成变化：captured step settings、thread identity、
  executed-tool-calls recorder/result metadata/completeness。
  `core/src/tools/executed_tool_calls/{request_metadata,seen_ids}.rs` 是 bounded
  metadata 与历史 ID 完整性处理；不是 Host wire 自动赋予 Pi 的能力。
- nested gate/cancel、审批等待、多 cell/store 不是 0.155.1 新增；
  `code_mode_elicitation.rs` 在该区间未变。
- `service.rs:54,71` 仍把 `max_heap_size_bytes` 设为 None；
  `cell_actor/conversions.rs:30–31` 丢弃 input/output schema。
  我们的 cgroup 校验仍必要，wire schema 则存在可移除冗余。

### V8 风险没有因目标变化而消失

对 `aaa2cabfbcb8d9997ce67e166f796f46d5b72342` 执行 ancestry 检查，并核对
`v8_init.rs`、Cargo V8 固定版本及资产记录：

| 快照 | 包含 array-sort 优化器规避提交 |
| --- | --- |
| rust-v0.154.0 | 否 |
| rust-v0.155.0 | 否 |
| rust-v0.155.1 | **否** |
| rust-v0.155.0-alpha.9 | 是 |
| 本地 main 5c5308fc9a | 是 |

正式 0.155.1 仍固定 V8 150.4.0；不能用更晚的发布日期或包含补丁的 alpha
推断稳定版已经修复。上游补丁说明 comparator 改变 array element kinds 时
存在优化器问题，并禁用 Maglev/Turbolev/array builtin inlining 规避。
这是**源码及上游说明层面的风险依据**；本轮没有运行漏洞触发/利用代码、
没有证明本部署可利用，也不声称一个 cgroup 能消除此问题。
U0 需单独记录风险处置，private/blocked 不自动解除。

### 真实 Host 的有界探针

本轮证据目录：
`/home/u/.local/state/agents/tmp/code-mode-1551-design.g7L2vzfi/`。

保留：

- `release-0.155.1.json`、`host-0.155.1.tar.gz`、解出的官方 binary；
- `upstream-1551/` 选定 tag 源码、前期方案备份；
- `probe-host-1551.mjs`、`probe.log`、`probe-results.json`；
- `probe-bridge.mts`、`bridge-probe.log`；
- `limits.jsonl`、`units.jsonl`。

命令：

```sh
CODE_MODE_S0_DIR=/home/u/.local/state/agents/tmp/code-mode-1551-design.g7L2vzfi \
CODE_MODE_S0_HOST=/home/u/.local/state/agents/tmp/code-mode-1551-design.g7L2vzfi/codex-code-mode-host-x86_64-unknown-linux-musl \
TMPDIR=/home/u/.local/state/agents/tmp/code-mode-1551-design.g7L2vzfi \
node /home/u/.local/state/agents/tmp/code-mode-1551-design.g7L2vzfi/probe-host-1551.mjs
```

**PASS**，两次 Host 均由 S0 lab helper 监督：
192 MiB / swap 0 / 64 tasks / 1 CPU / 20s 独立 watchdog，执行前检查 kernel
controllers 和 PID membership；无凭据继承、无真实业务/network 工具。
本轮只运行简单、有限源码，没有分配压力或 JIT 风险测试。

结果：

1. 旧式 V1 空 capabilities 与协商 `session-cell-execution-resource-limits`
   两条握手均通过，`cellExecutionLimits.maxYieldTimeMs=50` 被接受。
2. 500ms timer + 1000ms 请求等待，约 **54ms** 返回 Yielded，随后正常完成；
   Result 带 `code_mode_host_duration_ns`。单次观察，不是 benchmark。
3. synthetic echo 的无参、undefined、null 都实际传成 wire `input:null`；
   `{}` 仍为 `{}`。协议上已无法区分前三者。
4. `store("keep",undefined)` 被 JS catch，原 `keep=7` 保持。
5. 两个 cell 分别 yielded、完成，不同 store keys 合并，后续读到 `[1,2]`。
6. 对已收取的 Host cell 再 wait，返回 `MissingCell.Result` 错误；随后执行
   仍能读到先前 store，并未破坏连接。
7. ALL_TOOLS 有 echo 信息；notify/yield_control/exit/image/audio 均存在。
   这不是声明 Pi 已支持这些输出/控制语义。

另外运行一次 **当前 production ToolBridge + ReadRoot/localTools** 探针：

```sh
TMPDIR=/home/u/.local/state/agents/tmp/code-mode-1551-design.g7L2vzfi \
node --import /home/u/dev/local/omp/node_modules/tsx/dist/loader.mjs \
  /home/u/.local/state/agents/tmp/code-mode-1551-design.g7L2vzfi/probe-bridge.mts
```

已复现：`bridge.invoke("ls",null,…)` 拒绝 Invalid nested tool arguments，
而 `{}` 调用成功。只读本次 scratch，未写业务文件。
因此“Host 空参数 → bridge object 校验”的兼容缺口有两端证据；
这仍**不是**改 pin 后通过了完整 production Pi+Host 集成。

结束后 `systemctl --user list-units 'omp-code-mode-s0-*' --all --no-legend`
为空，任务目录与证据保留。

### 尚未执行 / 没有交付的内容

- 未升级 production pin、实现 U0–U5，未重启现有试用 Pi。
- 未在 0.155.1 上跑完整 Host OOM/watchdog/effects/lifecycle suite、
  CI、Pi matrix、两类 production tarball 安装；这些是 U0 验收要求。
- 未调用真实 provider、执行真实 search/patch/process；未构建 Rust、
  验证 Sigstore 或跑 V8 优化器回归。
- 设计文档保留风险门禁，不宣称 0.155.1 已获安全部署认可。
