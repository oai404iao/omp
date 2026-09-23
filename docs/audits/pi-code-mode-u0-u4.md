# Code Mode U0–U4 实施记录

基线 `ac5c2e51`；分支 `feat/code-mode-u0-u4`。
用户授权完整 U0–U4，并明确选择 **0.155.1 + 上游 V8 规避补丁构建**。
详细接口与阶段验收见 [实施契约](../plans/pi-code-mode-u0-u4.md)。
不自动发布、合并 main 或修改现有试用实例。

证据目录：`/home/u/.local/state/agents/tmp/code-mode-u0-u4.hmIdxHI5/`。
环境：Linux x64、Pi 0.85.1、Node 24.13.0、systemd user/cgroup v2。

## U0：已完成

### 补丁构建

- Base: `be2951ea34f0d295ed0becf97079f92fa5f6950e`。
- Patch: `aaa2cabfbcb8d9997ce67e166f796f46d5b72342`；
  patch SHA-256 `4002429516d3048b8d19687f8c8016cd4e04a7cac4a24101e5fd57341456ba3d`。
- 标签 `rust-v0.155.1+pi-v8-sort.1`；**不是官方 release binary**。
- Rust `1.95.0 (59807616e 2026-04-14)`；release/debug=0/lto=false/
  codegen-units=16/strip=symbols，2 jobs。
- Linux GNU x64；ELF 要求 glibc >=2.39、OpenSSL3/libcrypto3、libgcc_s、
  libm/libc/动态 loader。相对旧 musl binary 有明确的可移植性收窄；
  当前只验证本地平台，不承诺 musl/static 或其他发行版。
- binary `host-target/release/codex-code-mode-host`，**65,707,032 bytes**，
  SHA-256 `4c5824da1cdf4652ce08e13ed572a7d488814d9fe0f9dd6ac0ce683422c27690`。
- 单一 production identity 为 `src/host-manifest.json`，安装包包含该 JSON。
  旧 S0 lock/审计未改；不混入新的官方 archive hash。

遇到并修正的构建问题：

1. 第一次 locked build 失败：官方 tag 的 Cargo.toml 是 0.155.1，而
   Cargo.lock 的 workspace packages 为 0.0.0。实际 `update --workspace`
   后独立验证**只有 source-less workspace version 变化**；没有外部依赖漂移。
   重用配方改为精确文本修正并校验前后 hash，后续 build/test 均 `--locked`。
2. 默认 denoland sandbox V8 下载 URL 为 404。遵循 upstream third_party/v8
   README，下载 Codex `rusty-v8-v150.4.0` 的 archive/binding，先验证 tag 固定
   的 manifest hash，再验证配对资产 hash。没有使用其他版本或关闭 V8 sandbox。
3. 上游补丁的测试依赖 main 新的 per-execute delegate API，在 stable 编译失败。
   仅将 fixture 调整为 constructor delegate；JS 回归与期望值不变。
   adapted test SHA-256：
   `e32bfb7645d8bca60121cc9675ef2f77e6df41628fbfa54fdb5c530e4ce2c7eb`。

构建分别由 task-specific systemd units 限制为 4GiB/2 CPU/128 tasks；
日志 `build.log`、`build2.log`、`build3.log` 为上述失败，
`build4.log` 为最终 **build + array_sort regression 1/1 PASS**。
源码和所有构建输出保留，不清理其他 cache/任务。
仓库 recipe 由这些实际步骤整理，已做语法检查；没有另开全新目录重复编译。
不是可复现构建、Sigstore 验证或通用安全认证。

### 协议与行为

- hello 精确请求 resource-limits capability；返回未知/重复值拒绝。
  协商成功后 maxYieldTimeMs=250，不发送未生效的 heap limit。
- Host operation duration 验证非负安全整数并累计到 observation。
- 顶层 null/undefined 归一化为 `{}` 后 prepare/schema/policy；字段 null 保持，
  required 输入不放松。真实 no-arg ls、undefined store 保留值均覆盖。
- 当前 executable hash/size、symlink/旧 size/同 size 篡改拒绝；
  平台不匹配在运行前失败。

### 实际验证

| 检查 | 结果 |
| --- | --- |
| `npm run check -w @oai404iao/pi-code-mode` | typecheck + **58/58** 常规测试通过 |
| `npm run ci`，`u0-ci-final.log` | 全仓通过，含 **308/308** Codex compatibility 与 **17** 个 production 组合 |
| 新 binary 的 `test:host`，`u0-host.log` | **34/34** 真实 Host/内核/Pi 集成通过，无 skip |
| 后增资产负向测试，`u0-asset-test.log` | **1/1**；另重跑 typecheck；共 **35** 个不同 Host 文件用例已验证 |
| standalone production install，`u0-install.log` | 通过；consumer `code-mode-s3-standalone-install-J4068a` |
| Codex production install，`u0-install-codex.log` | 通过；consumer `code-mode-s3-codex-install-nxs2xv` |
| focused U0 review | 无阻塞项；独立运行 protocol 2/2 与 recipe syntax check |

首轮 CI 只有新增测试的可选 assertion message 类型失败，修正后完整 CI 通过。
本阶段未修改 Pi/Codex transport 路由；Pi matrix 将随 U3 compatibility 改动运行，
不把未运行矩阵写成通过。Provider 为 HTTP fixtures，无真实账号请求。

## U1：已完成

- strict version-1 用户 config：hostPath/protocol/visibility；不接受 grants，
  defaults < config < 显式 CLI < 会话命令，reload 重新读取。
- doctor 静态模式不启动 Host；显式 host probe 独立受监督、无 nested tools。
  有单独取消 controller，terminate/off/context/shutdown 会取消；
  shutdown 等待其收尾，读取 cwd/signal 在 await 前完成。
- 稳定排序的 TS 式工具说明，支持 refs/union/必需字段、复杂度上限和
  `unknown` 回退；常见整数/长度/range/pattern/description 等约束仍有有界注释。
  outputSchema 可选、clone/freeze/8KiB；不替代实际 input/JSON-result 校验。
- Host 不使用的 wire schemas 不再发送；ALL_TOOLS、yield_control、exit/timer
  的实际行为补充提示词、文档和真实 Host 回归。

审查发现并修正：

1. 初版 renderer 把 pattern/数值范围简化成 string/number，模型看不到约束。
   已补约束注释与定向测试；超大/循环约束明确退回 unknown，不假装完整。
2. 初版 doctor 依赖 idle command 的 ctx.signal，且 Runtime.create 后读取
   可能过期的 cwd。已改独立 controller、上下文前置快照和确定的 finally；
   增加真实 Host 启动中取消/ctx 失效仍关闭的回归。

| 检查 | 结果 |
| --- | --- |
| `npm run ci`，`u1-ci.log` | 全仓通过，含 64 Code Mode 测试/17 production Codex 组合 |
| `test:host`，`u1-host.log` | 36/36；当时尚未追加 doctor 取消回归 |
| 审查修正后 `check -w pi-code-mode`，`u1-check-final.log` | typecheck + **64/64** |
| 审查修正后两个 doctor Host tests，`u1-doctor-final.log` | **2/2**，共37个不同 Host 文件用例覆盖，不将重跑叠加 |
| 两种安装，`u1-install.log`/`u1-install-codex.log` | 均通过 |
| renderer/doctor 修正后的 standalone install，`u1-install-final.log` | 配置路径、doctor、outputSchema、loader/reload/真实执行再次通过 |

没有宣称模型 token 降低比例；本阶段不是性能 benchmark。
源码变更后按影响重跑包检查/doctor/安装，未无条件重复所有其余工作区测试。

## U2：已完成

- 输出超预算保留 UTF-8 前缀，标记 truncated/droppedBytes，终止/结算而不一律
  reset。Host 已 Result 时明确 hostCompleted/store 可能提交；pending store
  经正常 terminate 丢弃。script/nontext/无法对账的协议故障仍 reset。
- typed runtime/不确认停止错误，初始化阶段还没有 bridge 时也会 poison。
  doctor 的独立 Host 出现同类错误也阻止继续启动。
- wall/Host time、origin/epoch、errorKind、增量 timed traces；trace pages 16KiB，
  hasMoreTraces 在收完前保留 cell ID，观察取消不消费游标。
- 独立 completion observers：最多16个，冻结无参数/结果的 receipt，5秒信号，
  不延迟/更改业务结果，异常仅有界计数/ID警告；不是权限/脱敏/副作用通道。
- streaming hash/copy + private content-addressed Host cache；每次启动仍验证
  source 和 cache。完整 candidate 用 hard link 原子发布，不覆盖既有 inode；
  mismatch/symlink/insecure directory 拒绝。只移除本次发布 candidate 的临时链接，
  不清扫任何旧 runtime/其他任务。

审查修正：

1. 原启动失败的 stop 未确认会丢失 bridge 前的 poison 信号。现用
   UnconfirmedRuntimeStop 穿过 create/session/cell，真实启动故障及 session
   fixture 验证失败后不能启动另一 Host。
2. “用户先 terminate，随后在途输出超限”原会被 userTerminated 标成成功。
   overflow 现在独立强制 failed，两个竞争方向都覆盖。
3. trace ID JSON 转义可扩大元数据；新增真正按字节分页，不以32条估算16KiB。
4. Host stop 失败不再被正常取消状态掩盖，effectsUnsettled/blocked 明确。

### 性能证据与取舍

`scripts/benchmark-code-mode.mts`，同一 Host/workload 各5样本，无 provider。
第一份探索日志 `u2-benchmark-before.log` 的 warmText 被前次立即取消造成的冷启动
污染；修正为显式预热后才测 warm，正式比较：
`u2-benchmark-baseline.log` 与 `u2-benchmark-after.log`。

| 指标 | 优化前 | cache/streaming 后 |
| --- | --- | --- |
| cold text P50/P95 ms | 279.55 / 460.23 | 348.41 / 587.58 |
| warm text P50/P95 ms | 36.68 / 38.03 | 35.10 / 35.29 |
| read P50 ms | 37.52 | 35.89 |
| 4 parallel reads P50 ms | 39.54 | 36.30 |
| 100ms delayed P50 ms | 136.58 | 134.07 |
| immediate cancel P50 ms | 41.30 | 38.87 |
| sampled Host peak RSS bytes | 31,367,168 | 30,789,632 |
| sampled Pi peak RSS bytes | 395,100,160 | 292,884,480 |
| retained runtime-state bytes | 657,070,320 | 65,707,032 |
| Host spawns / systemd calls / IPC frames / wait polls | 10 / 225 / 81 / 5 | 相同 |

本 workload 的磁盘保留量减少 **90%**，Node 采样峰值降低；代价是额外 hash
验证令 cold P50 增加约69ms。**不宣称整体更快**；小样本 P95 只是最大样本，
RSS 为25ms采样而不是内核峰值，几毫秒差异不作统计显著性结论。
不减少 watchdog/systemd 安全检查，也未根据这个结果改轮询时间。
以上比较在 cache 改动后完成；后续错误分类/边界回归没有另重复 benchmark。

### 验证

| 检查 | 结果 |
| --- | --- |
| 完整 CI，`u2-ci.log` | 通过；Code Mode **71/71**、Codex **308/308**、17生产组合 |
| 最终真实 Host suite，`u2-host-final.log` | **40/40**，含 cache竞争/篡改、overflow/store、启动不确认停止、此前生命周期/资源回归 |
| 两类 production install，`u2-install.log`/`u2-install-codex.log` | 通过；standalone probe 额外验证 public observer receipt 不含 input/value 且 origin 正确 |
| review | 两个发现已修正并回归，未跑真实 provider |

首轮 unit 只有旧 empty-catalog 深等值断言没包含新增 observers 字段，
更新契约断言后完整 CI 通过；不是生产能力退回。

## U3：审批与 owner cooperation

新增 approvals/v1 注册/发现、tool/policy approval ID、session FIFO（16），
冻结最终参数一致性、严格 true、缺失/异常/headless 拒绝。审批不占执行
worker；active abort 保留实际 UI slot 到 provider settlement。正 yield
观察等待当前审批，0 yield 保留非阻塞，取消观察不消耗结果。
内置 user 使用 public Pi confirm(signal)，不伪造 native hooks。

Code Mode direct-owner/v1 factory + Codex structural client，无反向 package
依赖。activation 分离 logical intent/physical projection，patch 被隐藏时
仍维持 native mutation suppression。审批注册/注销与 lifecycle 失效接通。

Review 发现首次按名字/sourceInfo 绑定可能认领 foreign first-registration
winner：改为注册时唯一 schema 引用证明，与 public ToolInfo 严格比对。
后续替换不重认领。若未来 Pi clone schema，cooperation fail closed。

验证：
- 完整 CI 通过，Code Mode **76/76**，Codex **308/308**，17生产组合。
- Pi matrix floor/target（均0.85.1）完整 CI 通过，日志
  `omp-pi-matrix-results-cc289Q/`。
- Host suite 首次 **42/43**；唯一失败是 fixture 禁止故意制造的 registry
  conflict，改为显式预期该 conflict 后 adapter suite **9/9**，累计43个
  Host cases 已覆盖通过（未声称最终整套重跑）。
- 两类 production tarball probe 通过。Codex probe 原来断言“无 owner
  cooperation”，更新为真实 hide/restore 后通过；standalone 不变。
- `u3-ci.log`、`u3-host.log`、`u3-adapters.log`、`u3-matrix.log`、
  `u3-install.log`、`u3-install-codex.log` 在本任务 scratch。

此前失败还包括架构 type-import cycle、composition fake 无 sourceInfo、
新增 catalog 字段旧断言；已修正并在完整 CI/matrix 回归。
未请求真实 provider/network、未发布/合并、未改用户配置。

## U4

### 实现

- 严格非权限配置 `maxCells:1–4` 与 CLI `--code-mode-max-cells`；默认1。
  Session public-ID Map、共享 init promise、Host-ID Map、串行 start ACK、
  独立 cell output/usage/trace/origin/deadline/observer。终态未读仍占slot。
- 单 Host 和 store：并发snapshot、只合并写入键、同key按实际commit顺序。
  四个并发首次exec只初始化一次，独立wait，不创建多个Host冒充共享store。
- session Scheduler 总4worker/16queue，read显式parallel才重叠，write/process
  exclusive FIFO。自己的取消只移除自己的排队调用；bulk取消暂停pump；
  shared fault在任何abort之前关闭全部admission。失败epoch未settle不能重开。
- `/code-mode cells`、`terminate <id>`、`terminate all`；裸terminate多cell拒绝。
  命令只请求取消，wait消费output/usage，不抢当前observer或伪造tool receipt。
- wire observer上限10；delegate IDs使用4096-ID bounded reorder window，
  过旧ID永远拒绝而非cell完成后遗忘。依据固定Host
  `code-mode-host/src/peer.rs`：atomic fetch_add先于async pending/route，
  所以不能假设到达单调。窗口外的极端乱序明确fail closed。
- 正常termination保持兄弟/store；script/IPC/OOM/硬watchdog共同失效。
  全局stop不确认时每个仍active的cell诊断unconfirmed，session保持blocked。
  idle只在全部ID消费后启动，model/tree/reload/refresh/off全代失效。

### Review 与回归

第一轮 review 复现并修复：
1. 移除A的queued writer时pump启动尚未abort的B：先关闭/暂停admission。
2. A已Host Result但仍settling，B失败时A错误返回普通terminated：
   settlement/disarm后复查shared failure，共享close确认结果。
3. cell结束后ID去重遗忘，重放ID让旧cancel命中B：持久有界window。

第二轮 review 继续复现“最终success检查后finally额外await settlement”
窗口与“pre-start cancellation绕过检查”：成功路径只settle一次，在最后
await后决定结果并同步退休；pre-start也走确认。均有单独counterexample
回归，包括shared stop failure、retired replay、乱序/过旧gap。
不是只以正常路径测试代替故障验证。

### 最终验证

| 检查 | 结果 |
| --- | --- |
| `npm run ci`，`u4-ci.log` | 通过；Code Mode **85/85**、Codex **308/308**、17生产组合 |
| 完整真实 Host suite，`u4-host-final.log` | **52/52**；包含此前U0–U3、8个新增multi-cell cases及真实Pi命令/双cell model/tree/reload |
| standalone production tarball，`u4-install.log` | 通过；config maxCells2、真实grammar下A→B→waitA，共享epoch，output/observer隔离，无Codex包 |
| Codex production tarball，`u4-install-codex.log` | 通过；默认single-cell兼容、真实patch/standalone-search、hide/restore |
| U3 Pi floor/target matrix | `omp-pi-matrix-results-cc289Q/`已通过；U4未变Codex owner代码或Pi baseline，不重复矩阵 |
| supervision收尾 | 最终只读查询 `pi-code-mode-*.service` / deadline timers：0 loaded units |

Host cases包含真正OS watchdog杀共享Host、实际kernel OOM的既有回归、
四cell首次初始化/usage一次交付、snapshot/merge、取消queued writer而不伤兄弟、
终态分页slot占用、共享故障及fresh epoch恢复。真实provider网络仍是HTTP
fixtures，不声称已访问真实账号；没有改当前用户配置、发布或合并main。

中途失败：旧single-cell测试直接注入private `cell`，按新Map改fixture；
config默认深等值新增maxCells；辅助函数Host参数TS窄化修正。最终check
及完整Host/CI/安装均通过。日志与scratch保留，未自动清理。
