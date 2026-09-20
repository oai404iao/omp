# Code Mode U0–U4 详细实施契约

状态：**U0–U4 已按顺序实施并验收**。用户明确选择
**0.155.1 + 上游 V8 规避补丁构建**。已本地合并至 `main@972d2c2c`；
仍 private/blocked，未发布或推送。后续仅提出
[工具互操作与协商设计](pi-code-mode-tool-interop.md)，尚未实施。
本文件细化 [v2 方案](pi-code-mode-v2.md)，不将未完成项标成已交付。
基线 `ac5c2e51`；实施分支 `feat/code-mode-u0-u4`。
各阶段分别提交；不自动合并 main、发布或替换正在运行的试用环境。

## 不变量

- independent/provider-neutral；Codex 只有可选 owner 协作，无私有包依赖。
- grants 只来自明确 CLI 或会话确认；config 不静默授予文件/进程/外部工具权限。
- unknown protocol、未知资源停止状态、未结算 side effects 均 fail closed。
- observation cancellation 不消费 output/usage，不冒充 cell termination。
- 每次真实效果执行都经过最终参数验证、适用 policy、审批和调度。
- opaque cell ID + runtime epoch；不重放代码，不持久化 store，不宣称回滚。
- 默认 JSON/mixed/单 cell；多 cell 是显式非权限配置，不能扩大 grants。
- 文档和测试区分 fixture、真实 Host、真实 provider；不使用真实账户做隐式 smoke。

## U0：补丁 Host 与输入/协议兼容

### 构建与身份

固定源 `be2951ea34f0d295ed0becf97079f92fa5f6950e`，回移上游
`aaa2cabfbcb8d9997ce67e166f796f46d5b72342`：
V8 初始化禁用受影响优化路径，并执行其 `array_sort` integration regression。
不能改 binary 字符串、使用 NODE_OPTIONS 或将官方 binary 冒称修复版。

产物标识 `rust-v0.155.1+pi-v8-sort.1`，不复用官方 release binary 的哈希。
构建记录 source、patch、Cargo.lock、Rust、target/profile 和实际 binary hash/size。
构建命令和源码补丁可复核；不是可复现构建/签名保证。
首个本机构建若采用 GNU target，须明确 Linux x64/glibc 依赖，不能仍称 musl。
不自动扩大到多个 target，不编造可下载的官方补丁版 URL。

生产单一 Host manifest 被 runtime、doctor、安装检查共享；
没有实际 build + sort regression + 完整 Host suite 通过，不写入未验证的 pin。
旧 S0 lock/audits 保留历史身份；新增当前 build provenance。

### 协议

- `hello`: V1，optional capability 精确请求
  `session-cell-execution-resource-limits`；重复/未知/非字符串 capabilities 拒绝。
- 协商成功后 `session/open.cellExecutionLimits.maxYieldTimeMs=250`。
  不发送虚假的 heap limit；cgroup 192 MiB 保持。
- 每次 Result/Yielded/Terminated 的 `code_mode_host_duration_ns` 若存在，
  必须是非负安全整数；缺省兼容；只计入 Host operation 时间。
- 顶层 null/undefined → `{}` → prepare → clone/freeze → object schema check。
  所有 owner schema 当前必须为 object；字段内 null 不变，required 仍验证。
  这是已记录的 prepare 输入行为变化，不引入宽松 recursive coercion。
- 保留 1 MiB client framing/有界 write queue；超时不继续复用可能乱序的连接。

### 验收

构建锁身份检查、upstream sort regression；bad capability/duration/参数测试；
完整真实 Host suite（含 OOM/watchdog、cells、effects、store、visibility）；
独立/Codex 两种 production tarball 安装、CI。已有 Pi wire 不变时不重复矩阵，
U3 的 owner/兼容变更统一再跑 floor/target。

## U1：配置、doctor、工具契约

用户配置 `<agentDir>/extensions/pi-code-mode/config.json`，strict version 1：

```json
{
  "version": 1,
  "hostPath": "/absolute/path/to/patched-host",
  "protocol": "auto",
  "visibility": "mixed",
  "maxCells": 1
}
```

`maxCells` 在 U4 启用，U1 不提前接受一个无效配置承诺。
优先级 defaults < user config < explicit CLI < runtime command。
Flag 注册不设会掩盖配置的默认值；reload/session_start 重读。
未知 key/type/version/range 报错；不读项目权限配置，不自动写回。

`/code-mode doctor`：静态检查 config source、Host regular-file/hash、平台、
systemd user manager/controllers、protocol selection、贡献 available/granted。
不启动 Host；`doctor host` 才启动受限 Host、hello 和纯计算，再确认收尾。
不下载、不授权、不将 doctor 结果当成 grants。

工具说明：

- 新 bounded renderer 将参数 schema 转成 TS 式签名；运行时校验仍用原 schema。
- 固定顺序，required/optional、const/enum、数组/object、union，有限展开 `$ref`。
  cycle/深度/节点/字节超限保守 `unknown` + 约束说明，不猜类型。
- outputSchema 为可选 metadata，预算/clone/freeze；内置 read/ls/write/bash
  明确返回类型，未声明 owner 返回 `unknown`。不能依照一次结果推断 schema。
- 目录 24 KiB 上限不变；移除 Host 丢弃的 wire schema 不削弱 bridge 校验。
- helper 描述明确 text/ALL_TOOLS/store/load/yield_control/exit；仅支持有测试的语义。

验收：配置 precedence/invalid/headless、doctor 零执行/显式 probe、
schema renderer 的约束/预算、tool prompt fixture、两种安装资源路径。

## U2：恢复边界、追踪与有证据的优化

### 结果

`Observation` 追加 backward-compatible metadata：
truncated/droppedBytes、runtimeReset、Host elapsed、wall elapsed、errorKind/error（停止原因）；
保留 `text/state/hasMoreOutput/usage`，不改变 max_tokens 四字节估算定义。

文本超预算保存 UTF-8 前缀、标记 truncated、停止新 dispatch 并终止/结算。
丢掉的数据不设 hasMoreOutput，避免永远 wait。
如果 Host 已完成，则无法撤销其 store commit；返回必须显示此边界。
非文本仍明确失败。script error 初期继续 reset/store loss。
MissingCell 只有能从本地 terminal/closed、delegate/effect 状态证实安全时才复用；
不能为了容错吞掉不可解释的 live-cell 消失。

### 追踪

每 call 有 queued/started/settled 时间与 state；origin outer call/cell/epoch，
不默认保存 input/result。每 cell 最多 32 calls，trace 字符串也要有上限。
observation 仅交付变更的 traces；取消 observation 不移动交付游标。
usage ledger exactly-once 保持。

completion observer 与安全 policy 分离：observer 无业务修改权限，异常只诊断；
after policy 失败仍拒绝，不提供 fail-open redaction。

### 性能

同一 workload 记录冷/暖 Host、read、并行 read、连续 cells、cancel：
样本数、P50/P95、RSS、目录磁盘占用、IPC/systemd 次数。先留基线。
只有证据支持才做 binary cache/stream copy/pump 调整；
不降低资源限制、移除 watchdog 或自动清理旧 runtime 目录。

## U3：审批与 owner visibility

### 审批协议

独立 versioned synchronous discovery；provider 记录 `{id, approve}`。
工具和 policy 可声明必需的 approval provider ID；缺失即拒绝调用。
审批与 5s before/after policy 超时分离，受 cell 总 deadline/AbortSignal 约束。
provider 返回明确批准/拒绝，异常/未知值/abort 一律拒绝。

单 session FIFO 审批队列，最多 16 pending；人工等待不占执行 worker。
顺序：归一化/freeze/schema → before policies → approvals → scheduler →
重新检查 abort/revision → invoke → after policies → accounting/observer。
批准绑定冻结参数、catalog snapshot、cell/epoch；不能改参后沿用批准。
刷新/注销/模型/tree/off/reload 取消旧 snapshot；过期批准不启动效果。
非协作 approval 被 abort 后，不让下一条提示与旧 UI 同时弹出；保留 blocked
诊断直到旧 provider settlement，不能仅 Promise.race 后就宣称提示关闭。

内置 `user` approval 使用 Pi UI confirm；headless 不隐式批准。
自定义 approval provider 通过公共 helper 注册，不假装触发 native tool_call。
正 yield 的 observation 遇到 outstanding approval 时延长至该审批结束或
cell/observer 取消（仍受总 deadline 约束），避免模型人为轮询；0 yield 不阻塞。
长参数预览 12000 字符，明确完整 JSON 字节数/hash 与“批准完整参数”语义。

### Codex owner

Code Mode 提供 optional direct-owner/v1 factory；shared runtime 用 structural
client 查询 binding/lease，不依赖 private Code Mode。注册时创建唯一 schema
引用并与 Pi public ToolInfo 对比，防止 first-registration-wins 把外部 owner
误认成自己；若将来的 Pi clone schema，则失去 cooperation，不能按名字认领。
core patch / standalone-search 的所有 owner activation 意图经过 binding；
model/thinking/autoEnable/dynamic registration 均保留，不改变 uninstalled capability。
仅对应已 grant 的有效贡献带 direct binding；hosted/image 无绑定。
dispose/replacement/reload 释放 lease；恢复合并 live active set，不复原旧全集。

验收：approval allow/deny/missing/throw/abort/expiry/queue/headless，
参数一致性、refresh 后 late approval、审批不占写 gate；
Codex 正反重复加载、model/thinking、动态注册与 hide/off/reload；
compatibility tests、完整 CI、Pi matrix、production tarball 组合。

## U4：共享 Host 的受控多 cell

`maxCells` 用户配置/CLI `--code-mode-max-cells`，1–4、默认 1；
首个 opt-in 可设 2。改变并行度不增加权限。
终态未收取 output/usage 的 cell 仍占 slot；达到上限返回现有 ID 列表。

- Session: Map<public ID, Cell>；单 runtime init promise，避免多个 exec 各开 Host。
- Runtime: Map<Host ID, Active>，delegate request ID 全局去重；
  execute/start ACK 入口串行化，解决 delegate 先于 ACK 时无法路由的竞争。
  Host 在异步 route 前 atomic 分配 ID，并不保证到达有序：使用4096个ID
  的 bounded reorder window + 永久拒绝低于窗口的ID，不在cell完成时遗忘
  replay protection，不使用不成立的“单调到达”假设。
- Wire: observer 上限按硬 maxCells 推导且有绝对上限；
  session/operation/delegate/cell ID 分别验证，不让未知 ID 绑定到最近 cell。
- 每 cell 一个 observer、deadline/usage/output/traces/catalog snapshot；
  shared session Scheduler 总 4 workers / 16 queue / exclusive FIFO gate。
  bridge.stop 只取消自己的 queued calls，不能误停兄弟；shared fault 才全停。
  shared fault 先关闭所有 scheduler admission，再逐cell abort；普通全停
  用短同步 pause 包住所有 abort，防止移除A的writer barrier时误启动B。
  Host已Result但仍settling的cell，必须在settlement/disarm后复查shared
  failure，并共享stop确认结果，不能返回伪terminated/丢失unconfirmed标志。
- session output aggregate <=4×32KiB、active calls <=4×32；非文本不绕过限额。
  单 Host 192MiB、cell 最长300s 不变；slot limits 不是 Host 的128默认。
- `/code-mode cells` 展示 live IDs；`terminate <id>` 精确终止；
  多个 cell 时裸 terminate 报错要求指定 ID，`terminate all` 显式全停。
  命令只请求取消不消费receipt；通过wait收取usage/output，不抢当前observer。
- 普通 user prompt/agent_end 保留 cells；agent interrupt 取消该 session live cells；
  model/tree/reload/refresh/off 全代失效，不串到新 epoch。
- wait 仍按 opaque ID，终态全部消费才删除；idle timer 只在全部 cells 消费后启动。

硬 watchdog 仍杀整个 Host cgroup。正常取消只 terminate 目标 cell；
未知停止、OOM、IPC failure、硬 deadline 触发共同失效并清空 store。
所有兄弟 cell 标明 collateral runtime failure；外部 effects 未结算则 session blocked。
不能将新 init race 与旧失效 runtime 混在一起，也不以多个 Host 偷换共享 store 语义。
store 为 snapshot/完成时已写键合并，同 key 按实际 commit 顺序，不承诺事务。

验收：A yield→B exec→独立 wait、默认1/上限4、并发初始化、delegate早到、
跨 cell read/write gate、取消 queued job、不误停兄弟、store不同/同key、
观察取消/usage once、terminal slots、模型/tree/reload、硬故障共同失效。
再跑 U0–U3 回归、真实 Host 和两个 production tarball probes。

## 完成追踪

| 阶段 | 状态 |
| --- | --- |
| 详细设计 | 已记录；随实现发现修订，但不得悄悄降低验收 |
| U0 | 已完成：补丁构建/回归、固定 pin、协议、真实 Host/CI/两类安装通过，见实施审计 |
| U1 | 已完成：非权限配置、doctor、schema/output hints、安装/Host 验证，见实施审计 |
| U2 | 已完成：output恢复/poison/增量追踪/observer/cache及实测，71 unit、40 Host、CI/安装通过 |
| U3 | 已完成：审批/owner cooperation，76 unit、43 Host cases累计覆盖、CI/Pi matrix/两类安装通过 |
| U4 | 已完成：默认1/可配1–4共享Host、全局调度/精确取消/故障共同失效；85 unit、52 Host、CI/两类安装通过 |
