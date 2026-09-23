# Pi Code Mode 优化方案：对齐 Codex，保持 Pi 独立性

状态：**用户已授权的 U0–U4 已实施并验收**；U5 未实施。基线为初版合并提交 `ac5c2e51`。
详细接口、顺序、验收和进度见 [U0–U4 实施契约](pi-code-mode-u0-u4.md)。
用户选择基于 0.155.1 回移上游 V8 规避补丁；以下官方资产身份仅作源版本参考，
生产目标将是单独记录 hash/provenance 的 `0.155.1+pi-v8-sort.1`，不是官方 binary。
用户最终指定固定 Host 升级到 **rust-v0.155.1**（取代最初提及的 0.155.0）；
本方案将其作为 U0 的目标，不是扩大为任意 Host 版本兼容。
工作区既有 0.154.0 草案和探针保留为前期研究，不再是升级目标。
U0 现已将运行时代码固定到独立核验的补丁构建；以下官方版本资产保留为研究对照，
实际 pin 以 `src/host-manifest.json` 为准；未替换现有试用实例。

前序：[初版 S0–S4](pi-code-mode.md)；
本轮实证：[0.154.0 历史研究及 0.155.1 复核](../audits/pi-code-mode-v2-research.md)。

## 1. 结论

初版已经实现“可用且边界明确的独立编排执行层”，但不等于与 Codex 功能齐平。
下一轮应优先补齐 **版本治理、配置/提示词、结果与生命周期、owner 协作**，
然后再引入多 cell 和图片。不是把整个 Codex 产品层搬进 Pi。

需要保留的已有优势：

- 同一执行器服务 JSON/grammar 和不同 provider；无 Codex 依赖。
- 可选 Codex owner 贡献，明确授权，不按工具同名推测权限或执行语义。
- kernel-verified cgroup、独立 watchdog、未确认收尾即阻塞。
  Codex Host 的计数器和 isolate 不等价于这些 OS 资源限制。
- 保存历史不重写、代码不重放、usage 不重复计账。
- 可信扩展的合作协议不冒充安全沙箱、全局工具锁或 Pi 原生 hook 继承。

**最高优先级风险仍未消除**：正式 0.154.0、0.155.0、**0.155.1** tag 均不含 Codex
[`aaa2cabfbc`](https://github.com/openai/codex/commit/aaa2cabfbcb8d9997ce67e166f796f46d5b72342)
对 V8 sort 优化路径的规避补丁；它存在于 main 和部分 alpha 分支，不能按发布日期
推断已进入稳定版本。不能凭 smoke 成功就认定新 Host 可安全发布；
详细处理见 U0。本轮没有复现该缺陷，也不宣称已证明其在本部署中可被利用。

## 2. 比较基线与证据边界

| 对象 | 使用的快照 |
| --- | --- |
| 本仓库 | `ac5c2e51`，Pi 0.85.1 |
| Codex 功能比较 | `rust-v0.155.1` → `be2951ea34f0d295ed0becf97079f92fa5f6950e` |
| 前期研究比较点 | `rust-v0.154.0` → `6b9826e3aa83b1a5947db50f4332cb9c65f1b340` |
| Codex main 参考 | 本地 `5c5308fc9a`，**不是上述 tag**；仅 fetch 所需 tag，不切换工作树 |
| howaboua（沿用前期研究） | `4593f066d447925eae8e3106435f117236690f9e`，本轮未重新更新/执行 |
| 本轮执行探针 | 官方 0.155.1 Linux x64 musl Host；无 provider 请求 |

0.145.0 的完整 release commit 不在当前 Codex 研究树中。旧版结论采用已记录
的 S0–S4 证据与 vendor 快照，**不把 alpha.18 当正式版做精确迁移差分**。
0.155.1 字段、行为按精确 tag 源码及本轮二进制探针确认；main 新功能单独标注。

### 2.1 版本升级究竟带来什么

- **0.155.0 → 0.155.1 没有 Code Mode 源码差异**。release 的修复是 TUI
  reasoning summary 默认值；不能把它宣传成新的 Host 协议或沙箱修复。
- **0.154.0 → 0.155.1**：code-mode-protocol、code-mode-host 以及 helper
  描述源码相同；runtime 的功能差异是提前处理 JS `undefined`，
  避免其作为非 JSON 文本解析，并保留 `store(key,undefined)` 失败前的旧值。
- 更多变化在 **Codex core 而非 Host**：captured step settings、thread
  identity、bounded tool-result metadata、执行调用完整性与恢复后的 ID 处理。
  单换二进制不会让 Pi 自动获得这些能力。
- 已用新官方 binary 验证：旧式/协商式握手、无参输入、store undefined、
  两个 yielded cells、MissingCell 后继续使用 store、duration/yield clamp。
  这只是受监督 smoke，不是 U0 的全套集成/安全验收。

## 3. 差距矩阵

| 方面 | Codex 0.155.1 | 我们当前 | 决策 |
| --- | --- | --- | --- |
| Host | 新 runtime/protocol、可选 session limits、duration | 固定 0.145.0，空 capability 握手 | U0 固定升级，不引入多版本运行时 |
| 空参数 | 无参/undefined/null 经 wire 为 null，函数工具参数落成 `{}` | null 原样进入 object schema 校验，`tools.ls()` 失败 | U0 定义 object 参数归一化并回归 |
| 工具文档 | 有界 JSON Schema→TypeScript 声明、返回类型、不同曝光策略 | exec 内嵌完整 JSON Schema，总目录 24 KiB | U1 优化表达，校验仍用原 schema |
| 全局 helper | text/store/load、ALL_TOOLS、yield_control、exit、notify、图片/音频 | 同一 Host 有更多 globals，但只明确支持文本/JSON 路径 | 分清“存在”与“支持”，完善说明和错误契约 |
| 审批/hook | nested 进入核心工具分派；审批未完成时避免提前交还模型 | 独立 before/after policy；不继承 Pi native hooks | U3 显式 owner/审批协作，不伪造 native events |
| 并行工具 | 使用真实工具的 parallel gate | 4 worker、16 queue，read opt-in；写/进程独占 | 保留；多 cell 时改为 session 共享 gate |
| 多 cell | 可以跨轮保留多个 yielded cell；store 合并已写入键 | 单 cell，连终态未读输出也占位 | U4 opt-in 多 cell，默认仍 1 |
| 输出 | text/image/audio；输出预算与截断 | 文本 32 KiB 总预算；超量/非文本使 runtime reset | U2 分类处理，U5 图片 |
| 通知 | notify 可注入活动 turn 的输出 | notify 被 delegate error 拒绝 | U5 有界通知，不伪造 tool result |
| 可观测性 | nested 调用记录、origin、Host duration、bounded result metadata/completeness | 有 calls/peak/有限 traces；缺耗时和完整生命周期诊断 | U2 增量元数据与完成证明，不默认保存输入/结果 |
| 曝光 | Direct/Deferred/CodeModeOnly 等由核心掌控 | mixed / owner-cooperative hide-bridged | U3 对接自有 owners；strict only 继续不承诺 |
| 工具发现 | deferred/tool search + ALL_TOOLS | 显式授权、固定 cell catalog；无 deferred loading | 不急于引入动态发现，先解决目录表达 |
| 跨 provider | Codex 产品内以 freeform 为核心 | JSON 默认、能力与 stream 身份确认后 grammar | 保留，不能为“对齐”牺牲通用 provider |
| 资源 | Host 内部数量限制；heap 字段未实际生效 | cgroup + 独立 deadline + effect settlement | 不降级，不将 heap 字段当内存保护 |
| 安装/配置 | Codex 管理 Host 与工具配置 | 手动指定二进制、CLI grants、会话命令 | U1 非权限配置 + doctor；暂不自动下载 |

### 需要纠正的几种误读

1. **ALL_TOOLS 不是 Host 缺失**。0.154/0.155.1 探针已看到授权工具的 name/description；
   当前缺的是我们对 helper 的正式契约、提示词与覆盖，不应另注入一个同名数组。
2. **notify 拒绝不一定立刻损坏连接**。`Runtime.delegate()` 内部会返回
   delegate error；JS 可以捕获。未捕获的脚本错误才走现有 reset。
   非文本 content 则会直接让当前 pump 失败。两条路径不能混为一谈。
3. 当前 traces 已有 id/name/state，不能说“完全没有追踪”；缺的是 origin、
   耗时、取消原因、增量展示和有界会话诊断。
4. IPC 超时/未知 cell 并不总是普通业务错误。没有效果结算证明时，fail-closed
   是必要行为，不能以“提高可用性”为由一律吞掉错误、保留 runtime。
5. Codex 确有跨轮多 cell 集成用例，不只是 Host 的 128 上限；但不据此宣称
   一条模型消息里的多个 exec 同时进入执行，或直接采用 128 作为 Pi 默认值。
6. 我们的 public cell 是 UUID，且绑定 live cell 对象，不是可重用的 Host 顺序
   数字 ID。不能照搬 Codex 的 Bloom filter 当必要修复；应保留已有 epoch/
   stale-ID 防线，补足完成状态证据和回归即可。
7. 1 MiB 是我们的 IPC 接收上限，Host codec 自身是 64 MiB；不要将前者
   写成上游保证。当前 100ms 初次/250ms wait pump 也不同于 Codex 默认观察窗口，
   两者都不是模型侧 `yield_time_ms` 的总执行期限。

## 4. U0：固定升级 0.155.1 与协议基线

### 4.1 产物身份

目标平台先维持 Linux x64 musl。固定记录：

```text
release: rust-v0.155.1
source: be2951ea34f0d295ed0becf97079f92fa5f6950e
archive: codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz
archive bytes: 25727325
archive sha256: 9fd083743af55be818aceb351d371fb5136f5b6aa3938f167087373d27067b2d
executable bytes: 69423168
executable sha256: 210ab8ebaebf4bc1421d9e30339c858354ca35fa91e2f87f4c6204e5382f8a63
```

[官方 release](https://github.com/openai/codex/releases/tag/rust-v0.155.1)
及其 API asset digest 与本轮下载的压缩包匹配；可执行文件从该压缩包解出后
独立计算哈希。不是从 `/usr/bin` 的版本号推导。

前期 0.154 研究已发现系统包与官方压缩包内 binary 哈希不同，记录保留在 audit。
本轮不把那个旧系统包结论套到 0.155.1，也未更改 `/usr/bin`。
任何发行版变体均**不自动加入 allowlist，不放宽为 size/version-only**。

实施时：

- 当前 production pin 收敛到一个 machine-readable manifest，runtime 和
  新验证脚本读取同一记录；测试 README/notice 中当前版本与 manifest 一致。
- 同步包 README、外部 Host notice、当前安装验证与平台说明。
- 旧 S0 lock 与 S0–S4 审计是历史证据，保留 0.145.0，不全仓字符串替换。
  在入口标明历史/当前验证用途，新增当前 Host 兼容验证，不冒充历史重跑。
- 只支持 0.155.1；旧版本明确拒绝并提供迁移提示。回退通过既有源码分支和
  独立试用目录，而不是偷偷维护两个 runtime 协议栈。
- 暂不自动下载、不改系统 `/usr/bin`、不改变正在运行的试用 Pi。

### 4.2 协议适配

- protocol V1 保留；hello 请求已知 optional capability
  `session-cell-execution-resource-limits`，验证返回版本/列表/重复值。
  只在协商成功时发送 `session/open.cellExecutionLimits`。
- 不把“非空 capability”一律判不兼容，也不盲目启用任意未知 capability。
  未知项保守拒绝并诊断；未知 required capability 继续 fail closed。
- `maxYieldTimeMs` 是 **Host 观察等待的上限**，不是 cell 总期限。
  可用于约束内部 pump 取消响应；不能拿来替代独立 watchdog。
- `maxHeapSizeBytes` 在该 tag 的 runtime 构造路径中被置为 `None`，
  **不作为有效配置暴露**。192 MiB cgroup 继续真实核验。
- 读取 `code_mode_host_duration_ns`，验证安全整数/范围。它是 Host 某次
  execute/wait 操作耗时，不是纯 JS CPU 时间，也不是整个 cell 的墙钟耗时。
- 新 Host 的 stdio 默认入口仍可用；显式保留 stdio，不开启 gRPC/OTEL listener。
- 新增内容类型不能被静默丢弃；暂未支持的类型按 U2 的分类规则拒绝。

**必须随升级处理的输入兼容项**：

- 真实 0.155.1 探针确认 `tools.echo()`、`tools.echo(undefined)`、
  `tools.echo(null)` 的 wire input 都是 `null`，无法从现有协议还原区别。
  `tools.echo({})` 则仍为 `{}`。
- 当前贡献协议只接受顶层 object schema。拟将顶层空输入归一化为 `{}`，
  然后执行 prepare → clone/freeze → schema check → policy → invoke；
  required 参数仍必须验证，**不递归把字段内的 null 改成 `{}`**。
  明确告知 owner prepare 不再区分顶层 null/省略；通过 changeset 记录行为变化。
- 覆盖内置 ls、全部 optional 的贡献、required 参数、prepare、before policy、
  嵌套字段 null、数组/字符串拒绝。不要只测 Host echo 后宣称 Pi 已修复。
- store 的 `undefined` 拒绝/原值保留需真实 Host 回归，不能把它自动改为 null。

本轮探针已确认：空 capabilities 的旧握手仍被 0.155.1 接受，普通调用也成功。
所以“只改 pin 一定立即 wire 崩溃”不成立；但这不证明所有生命周期和资源测试
兼容，也不意味着可以跳过上述协议治理。

### 4.3 V8 已知问题：升级门禁

main 的 `aaa2cabfbc` 禁用了受 sort 问题影响的优化路径；正式 0.155.1 tag
仍不含该提交。`rust-v0.155.0-alpha.9` 含该补丁而正式 0.155.0/0.155.1
不含；已核对祖先关系、v8_init 源码及固定的 V8 150.4.0 资产记录，不能只看
版本号。Host CLI 也没有通用 V8 flags 参数。不能假定设 `NODE_OPTIONS`
就能修复 Rust 内嵌 V8，不能只测一次 `[3,1,2].sort()` 就宣布缺陷不存在。

U0 必须记录风险处置：

1. 以官方 0.155.1 为**固定兼容性目标**，上述哈希不变，不擅自改成 main/alpha。
2. 核对上游回归的触发条件、版本适用性和可执行的验证方法；本轮仅确认
   补丁缺失，未做漏洞复现。不要在普通 Pi 进程里执行 JIT 风险探针。
3. 风险未解除时保持 private/blocked，不把升级验收等价于安全发布。
   如需正式启用该版本，须明确记录用户接受已知风险的有限试用决定；
   或另行授权 backport 构建/更新版本。指定版本不自动等价于接受刚发现的风险。
4. backport 产物必须有独立 revision/hash/license/provenance，明确标为
   `0.155.1 + patch`，不能冒充上述官方固定产物；本轮不擅自改变版本目标。

### 4.4 验收

- 更新 pin 的身份检查：正确资产通过，旧版、系统包变体、符号链接、篡改拒绝。
- hello/open、execute/wait/terminate、delegate cancel、late response、
  duration、新旧 shape 异常、未知 capability 的协议测试。
- 无参/undefined/null 与 prepare/policy 顺序、store undefined 失败不覆盖旧值；
  顶层归一化与字段内 null 的区别可验证。
- 在新 binary 上运行真实 Host 全套：OOM、CPU/timeout/watchdog、store、
  跨轮/模型/tree/reload、write/process effects、S4 恢复。
- 两种 production tarball 安装（独立 / Codex），完整 CI；
  涉 Pi/transport 兼容变更执行 Pi floor/target matrix。
- 不放宽资源限制只为让新 Host 通过；启动 RSS 不够时先记录证据并评审。

## 5. U1：配置与模型使用体验

### 5.1 非权限配置持久化

拟新增用户级 `<agentDir>/extensions/pi-code-mode/config.json`：

```json
{
  "version": 1,
  "hostPath": "/absolute/path/to/verified/codex-code-mode-host",
  "protocol": "auto",
  "visibility": "mixed"
}
```

优先级：**内置默认 < 用户配置 < 显式 CLI < 当前会话命令**。
未配置时继续 JSON/mixed，不改变现有行为。CLI flag 注册不能让默认值盖掉
配置，必须区分“未传”与“显式传 json/mixed”。reload 重读配置/CLI；
session 命令仅临时修改，不悄悄写文件。

本阶段不读取项目级权限配置，不接受任意额外 keys，不存密钥/会话状态。
`readRoot/write/process/tools` **不在上述配置中**：继续 CLI 显式授权，
或 `/code-mode on` 的当前会话确认。保存 Host 路径不等于允许其执行代码。

拟增加 `/code-mode doctor`：

- 静态报告路径、资产身份、Pi/OS/systemd prerequisites、配置来源、
  协议选择原因、可用/已授权/当前不可用的 contribution。
- 默认不启动 Host、不自动下载、不修改权限；显式 `doctor host` 才执行
  有界 hello/最小纯计算检查，不调用外部工具。
- 错误区分 Host 缺失/错误产物、user manager 不可用、模型不支持、
  transport 无握手、owner 未安装/当前 profile 不支持。

### 5.2 紧凑、有界的工具契约

将 `tools.name + JSON.stringify(schema)` 优化成稳定排序的 TypeScript 式说明：

```ts
declare const tools: {
  read(args: { path: string; offset?: number; limit?: number }):
    Promise<{ text: string; nextOffset: number; truncated: boolean }>;
};
```

这是**拟议表达格式示意**，字段沿用当前 adapter；renderer 不能反向改变
实际返回值或运行时 schema 校验。

- 实际参数验证仍用原 schema；提示词 renderer 不是新的校验器。
- 先支持当前工具实际使用的 schema 子集；复杂/循环/local refs 必须有展开
  次数、深度和字节预算。无法忠实表达时保守 `unknown` + 简短约束说明，
  不把 optional 错写 required，不把宽 schema 假写窄类型。
- 仍保持 24 KiB 总目录上限。先压缩表达，不偷删已授权工具；超限时明确提示。
- 0.155.1 Host 转换链不使用工具 input/output schema，Codex core 在发送前
  就清空它们。Pi 当前仍把参数 schema 传进每次 execute：拟移除冗余 wire
  schema，但保留 bridge 校验的完整 schema，并对照 ALL_TOOLS/helper 探针。
  此优化不能代替模型可见的工具说明，IPC 与模型 prompt 字节分开测量。
- `outputSchema` 先为内置工具提供，再作为 owner 的可选声明讨论；没有声明
  就是 `unknown`，不能根据一次结果推断。新增字段需验证 clone/freeze/预算。
- 明确 text/store/load、await/Promise.all、setTimeout、ALL_TOOLS、exit、
  yield_control 的可用语义；对拟支持 helper 用真实 Host 测试后再写入提示词。
- 解释 `text` 是输出、函数返回值不自动输出，cell 每次新 JS 环境，
  shell session ID 不等于 Code Mode cell ID。错误 ID 不自动转去 write_stdin。
- Codex 的 `max_output_tokens` 与我们的 `max_tokens` 不暗中互换；
  先保持现有 public schema/history，若需别名另做冲突与双协议迁移测试。

**验收**：当前所有工具 schema 的快照/语义测试；复杂 schema 预算用例；
对比目录字节和真实 provider fixture payload。没有实际测量不宣称 token
减少多少，也不为本阶段引入 tool-search/MCP/动态源码注入。

## 6. U2：结果容错、可观测性和有证据的性能优化

### 6.1 将错误分类，而不是统一 reset 或统一忽略

| 情况 | 目标处理 |
| --- | --- |
| 已授权工具的 schema/业务/policy 拒绝 | 保持 JS 可捕获错误，不损坏连接 |
| notify 尚未支持 | 明确 delegate error；允许 catch，不伪造已发送 |
| 非文本输出尚未支持 | 明确 cell 错误并收尾，不静默丢弃或当文本返回 |
| 文本超业务预算 | 保留有界前缀及 truncated 原因，停止新增 dispatch，终止/结算该 cell |
| 已确认 terminal 且无遗留 effects | 可按明确状态规则保留 runtime；不能从“UI 已显示失败”推断 |
| script error | 初期保留现有 reset/store-loss 策略，避免悄悄改变失败提交语义 |
| MissingCell / closed 通知 | 与本地生命周期、pending delegates 对账；未知状态仍 reset/blocked |
| IPC oversized/malformed、ID/session 错乱、超时无法确认 | fail closed；必要时关闭 Host，阻塞未结算 effects |

输出超量是失败/终止，不包装为成功。`truncated`/`droppedBytes` 与
`hasMoreOutput` 分开：已经丢弃的字节不能让模型无限 wait。单帧 1 MiB、
Node 待发缓冲、Host 内存和 deadline 限制不因为 UI 截断而放宽。

保留旧 store 仅限能证明安全的路径：**已终止** cell 可丢弃 pending writes；
若 Host Result 已完成，store commit 可能已发生，不能承诺撤销它。
外部写入永不因输出错误而自动回滚。新增分类要在 details 中明确 runtime
是否重置、epoch 是否变化、effects 是否仍未确认。

不立即实现“IPC timeout 后继续复用连接”：stdio late response、未知 operation
和取消竞争尚未解决前，保留现有保守策略。

0.155.1 对已收取的 Host cell 返回 `MissingCell.Result`，连接及 store 仍可用，
本轮探针已验证；当前 Pi 内部 pump 则视其为异常并 reset。**外部无效 public ID**
本来已在 `CodeSession.wait` 拒绝，不应误说随便输错 ID 就会清空 store。
U2 要解决的是内部本来应 live 的 cell 消失时如何对账；有未结算 delegates
就不允许继续复用。U4 中也必须明确兄弟 cell/store 的共同失效范围。

### 6.2 诊断与追踪

- 有界记录 `cellId`、originating outer tool call、epoch、工具 owner/name、
  state、queue/execute/settle/observe 时间、停止原因。
- duration 区分 wall/Host-operation/adapter，不称为完整 CPU 或收费账单。
- 借鉴 0.155 的 bounded tool-result metadata，但 completion 依据来自本地
  runtime terminal + effects settled + output/usage receipts，不依据历史文本。
  不导入 Codex 为可重用顺序 ID 增加的 Bloom filter，也不伪造 provider 的
  `executed_tool_calls` metadata。保留 opaque public ID 与 epoch 检查。
- 区分 cell 创建时 origin、nested invoke 当时上下文、observer 当前模型。
  0.155 Codex core 使用 captured step settings；Pi 需先固定等价契约再扩展
  多 cell，不能把 getContext 的最新状态默认为所有旧调用的身份。
- traces 按 ID 增量展示，避免每次 wait 重复整个列表；对模型可见 metadata
  设置独立总预算，不以“max_tokens 只管业务文本”为由无限增加。
- 不默认记录 nested 参数、结果、密钥或正文；需审计的敏感数据仍经显式政策。
  诊断 observer 不获得修改业务返回值的权限。
- 现有 `after` 是安全脱敏，失败继续 fail closed。新增可选 completion
  observer 才是只观察、失败不替换结果；两者不能混用。
- 保持 usage exactly-once，取消 observation 不消耗输出或 usage。

### 6.3 性能先测量再修改

建立固定本地 workload：冷启动、小文本、授权 read、并行 read、延迟工具、
连续多 cell、取消。记录样本数、P50/P95、Host RSS、磁盘增长、systemd 调用数、
IPC poll 次数和模型目录字节，不把一次 smoke 当 benchmark。

候选优化：

1. verified、content-addressed binary cache，减少每个 runtime 保留一份
   69 MB 副本。采用私有目录、原子创建/锁、拒绝 symlink、启动前复核身份；
   缓存不是“上次 hash 通过就永远信任”。不自动删除已有 runtime 目录。
2. stream hash/copy 取代一次读入整个 binary，控制 Node 峰值内存。
3. pump 等待根据工作状态调节，但保留取消响应上限和单独 watchdog；
   不直接照搬 howaboua 的 5s–1800s 等待到当前 5min cell deadline。
4. 不先取消 per-exec timer 来省开销。任何 timer amortization 必须证明
   parent 卡死、re-arm 竞争、cell 交接时仍有独立硬期限。

**验收**：故障注入 + 真实 Host store/effects/usage 回归；性能前后相同 workload，
禁止以牺牲停止证明、权限校验或资源上限换吞吐。

## 7. U3：owner 协作、审批与自有 Codex hide-bridged

Codex 可以进入统一 ToolRegistry；Pi 0.85.1 的公开扩展 API没有等价的通用
嵌套执行入口。此差距需要显式桥接，不能靠私有 registry 或发送同名 event 假装解决。

- 保留 contribution v1 + 快速 policy before/after。
- 拟增加独立的、versioned approval 协作能力：owner/policy adapter 可声明
  required approval provider；缺失时该能力不可调用，并给出解释。
- 人工审批不能塞进当前 5 秒 policyWork 超时。审批使用独立 pending 状态、
  cell 总 deadline、AbortSignal 和单会话提示队列；headless 无明确授权则拒绝。
- 审批绑定冻结的最终参数、owner/policy revision、cell/epoch。
  排队后执行前复查有效性，模型/tree/reload/refresh/取消后旧批准不可复用。
- 人工等待不要长期占有写入执行槽；执行前必须再次进入正确的共享调度 gate。
- 审批未完成时不能不断诱导模型再发 exec。先验证 Pi UI/agent-turn 行为，
  设计 bounded waiting 状态；不要照搬 Codex elicitation 私有实现。
- UI 必须显示哪些 owner 有等价审批/脱敏，哪些只是当前显式 grants；
  不承诺第三方权限扩展自动适配。

在这个阶段将**自有 Codex patch/standalone-search 的 activation** 接入
S4 lease 协议，才允许 `hide-bridged` 真正隐藏它们的 direct counterparts：

- 保留所有原 model/thinking/autoEnable 意图；不可用、撤权、off、reload、
  失败恢复时重新评估并释放 lease。
- 不给 Codex 包增加对私有 Code Mode 的依赖。双方使用 versioned structural
  bus；若当前 helper 公共契约不足，先定义协议，不复制一套不兼容 helper。
- hosted search、image_generation、view_image 不因为同名而自动隐藏。
- 不 monkey-patch Pi setActiveTools/registerTool；不新增严格 only。

**验收**：拒绝/修改后审批/过期/双提示/cancel/headless、观察器故障与脱敏故障；
正反重复加载、model/thinking、动态注册、off/reload、owner replacement；
Codex owner 改动须完整 compatibility tests、matrix 和生产组合测试。

## 8. U4：受控多 cell，而不是简单删掉 busy 判断

目的：让一个已 yield 的长任务不阻塞第二个独立任务；不是取消所有串行约束。

- 默认仍 `maxCells=1`；首个 opt-in 目标 2，上限初拟 4，实际内存测量后定。
  不使用 Host 的 128 作为产品默认。终态未读输出也占有限 slot。
- `Session.cells` 管多个 cell；Host-cell/public-cell/operation/delegate ID
  明确映射。新 `/code-mode cells` 列表，terminate 指定 ID 或显式 all。
  单 observer 限制变为每 cell 一个，收取终态后 ID 消费语义保留。
- 所有 cell 共享 session worker/queue/exclusive barrier 与总预算。
  禁止每 cell 各开 4 worker、16 queue，意外把预算乘 N。
- 每 cell 快照 catalog/policies/grants；delegates 使用对应 snapshot，
  不采用后来一轮模型的隐式身份/权限。refresh/model/tree/off 仍使旧代失效。
- store 采用 Host 的 snapshot + 已写键完成时合并。不同 key 可并行合并，
  同 key 以实际 commit 顺序为准，不宣称事务、线性化读或确定性。
- 未读输出、usage、traces、完成 cell 数量都需 session aggregate budget。

**最关键的安全冲突**：现有 per-cell 硬 watchdog 杀的是整个 Host cgroup。
共享 Host 的多 cell 不是独立故障域。设计采用：

1. 正常 timeout/terminate 先只终止目标 cell、停止其新 dispatch、结算 effects。
2. 无法确认时，硬 watchdog 仍允许杀整个 Host；所有受影响 cell 标记明确的
   collateral failure，store 失效，未结算 effects 保持 blocked。
3. 不为了“不影响其他 cell”删除 watchdog；也不暗中分成多 Host，因为那会
   改变 store 和内存治理。独立 Host/store 属另一个设计，不在 U4 中顺带做。

**验收**：A yield→B exec→分别 wait；store 不同/同键冲突；单 cell cancel、
多 cell 共享写 gate、取消排队、Host OOM/硬 watchdog 导致的共同失效；
各 cell usage 恰好一次，old ID/epoch 不串线；相同预算下无乘法放大。

## 9. U5：图片与有界通知（后续可选）

图片比音频更适合先做：Pi 原生 tool result 已有 image block，但当前 Code Mode
bridge/value/public-output 契约只有 JSON/text，不能只删除非文本检查。

- 定义独立 versioned result/content 扩展；v1 仍只接受 `{value,usage?}`。
  新 owner 不得让旧消费者静默忽略 image/control 字段。
- 参数/JSON 与多媒体传输分离；避免把多 MB base64 塞进 64 KiB JSON result。
  评估有界资源 handle 的寿命、cell 隔离和消费计数，再定最终 API。
- 限定 MIME、来源、数量、单项/整 cell/整 session bytes；禁止任意 URL 抓取，
  不把文件路径当作隐式读取授权，不允许扩大根目录。
- data URL/图片 metadata 走 policy/usage/cancel 规则；provider 不支持时明确
  报错，不静默文本化、不换 provider。
- notify 先只做当前 cell 的有界进度 UI，不自动唤醒模型。是否成为后续
  context message 必须另定义来源、预算、去重和 replay 规则。
- 不伪造 tool_call_output、不把过期 cell 通知注入新 session；
  不通过 notify 无限扩大 cell 输出预算。

音频、generatedImage 特殊控制、完整 hosted image 路径暂不纳入该阶段。
与 U4 可独立评审，但不能绕过 U2 的预算/收尾和 U3 的权限契约。

## 10. 阶段顺序与完成标准

| 阶段 | 推荐范围 | 完成标志 |
| --- | --- | --- |
| U0 | 0.155.1 pin、空参数兼容、协议、来源/已知风险门禁 | 完整新 Host 兼容证据，风险处置有记录；不是只改常量 |
| U1 | 非权限 config、doctor、紧凑工具文档 | 用户不用手写长 launcher 才能找到问题；授权边界不变 |
| U2 | 错误分类、有限追踪、性能基线与必要优化 | 输出/业务错误不被误作安全故障，安全故障不被误作可恢复 |
| U3 | 可选审批协作、自有 Codex visibility binding | 对接 owners 的语义可验证，不夸大第三方 hook 覆盖 |
| U4 | opt-in 多 cell | 共享调度/预算/故障域正确，默认单 cell 无回归 |
| U5 | 图片/通知 | 新能力有明确协议、预算、授权与 provider 验证 |

推荐先授权 **U0–U2**，形成一次可用性提升；U3 涉 owner 协议应独立评审，
U4/U5 是能力扩展，不作为升级 Host 的前置依赖。

每个实现阶段：

- scoped branch + Conventional Commit + 按改动风险测试；修改包则 changeset，
  recursive consumers 用 changeset:sync；不手动 bump release lock。
- 完整 CI；新 Host/生命周期走真实 Host；涉及 Pi/Codex compatibility 跑 matrix；
  新的安装/依赖/资源路径走 production tarball 验证。
- Fixture 与真实账号证据分开。fixture 成功不证明真实网关接受 grammar；
  真账号 smoke 需单独授权，避免把初始化验证变成有费用/外部副作用的请求。
- 文档列出完成、未完成、失败修正与实际运行命令；private/blocked 不自动解除。

## 11. 明确不做

- 不接管 provider/auth/model catalog，不强制 Codex provider，不更名现有 exec/wait。
- 不自动包装所有 Pi 工具，不绕过 native hooks 后宣称等价。
- 不做 Host 自动下载/自动升级、不采用任意系统包 hash，不提供 unsafe fallback。
- 不为了省 token 静默删工具/丢结果；不修改模型 JS 源码伪造 ALL_TOOLS。
- 不把 store 改成持久化数据库或通过代码重放恢复；不承诺副作用回滚。
- 不搬 Deno Notebook、gRPC 远程 Host、全套 OTEL、严格 only 或多平台支持。
- 不假定 cgroup 能修复 V8 正确性/内存安全问题。

## 12. 代码证据索引

本仓库（`ac5c2e51`）：

- `src/{asset,limits,supervisor,wire,runtime}.ts`：固定资产、资源、握手/异常路径。
- `src/{session,cell,scheduler,bridge}.ts`：单 cell、输出、全调用预算、policy/usage。
- `src/{catalog,contributions,protocol,extension,visibility,direct-binding}.ts`：
  目录、公开贡献、历史投影、CLI/可见性。
- 上述路径均相对 `pi-extensions/pi-code-mode/`；测试与 S0–S4 audits 为已有证据。

Codex（路径均相对 `codex-rs/`，除特别标注均为 0.155.1 tag）：

- `code-mode-protocol/src/host/{mod,payload,message}.rs`：capability/limits/duration。
- `code-mode-host/src/lib.rs`：hello 协商和 Host 计数器；
  `code-mode-runtime/src/{service.rs,runtime/mod.rs}`：yield clamp、heap 未执行。
- `code-mode-protocol/src/{description,json_schema_types}.rs`：helper 文档/有界 TS；
  `tools/src/code_mode.rs`：direct 工具描述增强。
- `core/src/tools/code_mode/{mod,execute_handler,wait_handler,delegate}.rs`：
  nested 分派、审批等待、通知；`core/src/tools/registry.rs`：真正 hooks。
- `core/src/tools/spec_plan.rs`：exposure/direct-only/CodeModeOnly；
  `core/src/tools/executed_tool_calls.rs` 及其 `request_metadata.rs`、
  `seen_ids.rs`：有界调用记录与完整性；区分可重用 Host ID 与 Pi UUID。
- `code-mode-runtime/src/runtime/value.rs:296`、`service_tests.rs` 的
  `storing_undefined_preserves_the_previous_value`：本轮 runtime 功能差分；
  `core/src/tools/code_mode/mod.rs` 的 `serialize_function_tool_arguments`：
  空输入在核心分派时成为 `{}`。
- `core/tests/suite/code_mode.rs` 的 `code_mode_can_run_multiple_yielded_sessions`、
  `code_mode_concurrent_cells_merge_only_the_stored_values_they_write`；
  `core/tests/suite/code_mode_elicitation.rs`：多 cell/store/审批行为证据。
- **仅部分 alpha/main，不含当前目标稳定版**：`aaa2cabfbc` /
  `code-mode-runtime/src/v8_init.rs` 与 `tests/array_sort.rs` 的优化器规避。

howaboua（`packages/pi-codex-conversion/src/tools/code-mode/`）：

- 参考 `preflight-protocol.ts` 的显式协作、`nested-tool-completion.ts` 的只读
  observer 区分、`install-host.ts` 的锁/原子安装、`trace-store.ts` 的上限思想。
- 不照搬 `tool-source.ts` 的源码前缀/手写 JS 分析、mistaken-wait 自动改调
  write_stdin、host 自动下载、Notebook/Codex 产品耦合。
