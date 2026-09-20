# 独立 Pi Code Mode 设计

状态：S0–S4 已完成，分别见验证记录。实施顺序为 S0、S1、S2、S4、S3。
严格 only 仍是按需后续项，不属于已完成的协作隐藏。包仍 private/blocked。

第二轮优化设计与固定 Host 0.155.1 升级目标见
[v2 优化方案](pi-code-mode-v2.md)。该方案尚未实施，不改变本文 S0–S4 的
历史版本与验收结论。

## 目标与非目标

新增独立 `@oai404iao/pi-code-mode` 扩展，将 Code Mode 定义为“通过
JavaScript 编排工具的执行层”，而不是 Codex 的附属功能。通用 provider
和 Codex 共用执行器、桥接、状态管理；Codex 适配仅增加协议优化和工具贡献。

单独安装必须可用，不安装或依赖任何 `pi-codex-*` 包，不接管登录、模型目录、
provider、整个系统提示词或 Codex 配置目录。新扩展的命令、配置与状态独立。
不在首版实现 Deno Notebook、npm/import、持久 JS heap、检查点重放、多执行器、
远程 gRPC Host 或任意第三方工具自动执行。

收益是让工具结果暂留执行器，通过代码过滤、聚合后才交给模型，减少工具调用
轮数与上下文消耗。是否实际节约成本需要后续测量，不作为 S0 已证明的结论。

## 研究快照

| 来源 | 固定版本 |
| --- | --- |
| `openai/codex` 本地研究树 | `7498521d28` |
| `howaboua-pi-stuff` 本地研究树 | `4593f06` |
| OMP 设计基线 | `3304952c7184c31d6a813de1c4c82e432d797b1a` |
| Pi SDK | `0.85.1` |

研究树不作为构建依赖。Codex 的当前研究树与 howaboua 引用的
`rust-v0.145.0` Host **不是同一个版本**；必须分别记录结论，不能把当前源码的
字段或行为直接归给旧版二进制。

主要参考：

- Codex：`codex-rs/code-mode-protocol/src/description.rs`、
  `code-mode-runtime/src/runtime/mod.rs`、
  `core/src/tools/code_mode/delegate.rs`。
- howaboua：`packages/pi-codex-conversion/src/tools/code-mode/`
  下的 `public-tools.ts`、`shared-runtime.ts`、`host-*.ts`，
  以及 `src/code-mode-extension-tools.ts`、`src/adapter/code-mode/nested-tool-adapter.ts`。
- 本仓库：[包组合](../codex-packages.md)、[Pi 基线](../pi-compatibility.md)。

## 参考实现的取舍

Codex 的 `exec` 运行在独立 V8 isolate，不是 Node REPL。文件、网络和进程
操作通过 `tools.*` 委托给宿主；`wait` 等待或终止 cell；`text/image` 显式输出；
跨 cell 只通过 JSON `store/load` 保留状态。借鉴这些契约，不搬整个 Rust
多 crate、gRPC、遥测、provider 与产品策略体系。

howaboua 的 TS→stdio Host、工具贡献、取消和渲染值得参考；其 Code Mode、
Codex provider、工具和 Deno Notebook 的产品耦合不沿用。直接调用
`tool.execute()` 绕过 Pi 原生工具钩子的事实必须明确，不把自有 preflight
接口描述成既有权限插件自动兼容。

## 三个独立维度

| 维度 | 选择 | 默认/阶段 |
| --- | --- | --- |
| 模型工具协议 | 通用 JSON / 可选 grammar 增强 | JSON，包括 Codex |
| 工具可见性 | mixed / hide-bridged / 严格 only | 首版 mixed |
| 执行环境 | 固定版本受限 JS Host | 首版只有一种 |

通用模式面向支持普通 function tools 的 provider，不要求 Responses、Codex
OAuth 或 Codex 模型目录。目标模型工具：

```ts
exec({ code: string })
wait({
  cell_id: string,
  yield_time_ms?: number,
  max_tokens?: number,
  terminate?: boolean
})
```

固定工具名发生冲突时明确失败，不静默覆盖其他扩展。

Codex 模式仍调用内部 `execute({code})`，仅在实际传输链支持时使用 raw JS /
grammar；可选消费已安装 Codex 工具的贡献。`auto` 按能力判断，不按 provider
名字猜测。工具暴露和权限是两回事；保留 direct 工具的模式不能叫严格 only。

## 包结构与数据流

```text
pi-extensions/pi-code-mode/
  index.ts
  src/
    extension.ts       注册、命令、生命周期
    public-tools.ts    exec / wait
    session.ts         cell、取消、会话代际
    runtime/           Host 客户端、协议、固定资产
    bridge/            工具贡献、校验、审批、分派
    adapters/          明确支持的工具适配
    prompt.ts          JS API 与嵌套工具契约
    output.ts          输出预算、图片、受限轨迹
  tests/
```

```text
任意 provider → exec/wait → 会话控制 → 独立 JS Host
                                        │ tools.xxx(args)
                                        ▼
                  授权 → 参数规范化/校验 → 审批 → 调度
                                        │
                      本地工具 / 扩展贡献 / 可选 Codex 工具
                                        │
                         结果处理/脱敏 → JS → text/image
```

首版不拆多个 SDK/runtime 发布包。不引入新的全仓工具管理框架。
跨包贡献走版本化 `pi.events` 协议，不通过硬依赖反向安装整个执行器。
配置使用 Pi 导出的目录常量并检查项目 trust，不硬编码 `.pi`。

## 执行器决策与发布门槛

优先验证固定版本 `codex-code-mode-host`，所有 provider 共用。Host 自身不需要
OpenAI 服务；复用二进制不等于依赖 Codex 扩展。资产需固定源码/协议版本、
URL、SHA-256、许可证与支持平台，缺失时明确失败，不降级为宿主 `eval`。

当前研究版 Codex 的 heap 字段未生效；旧版 Host 是否有此字段需独立实测。
fresh isolate 是能力隔离，不是 OS 沙箱，也不是资源预算。发布前必须落实：

- 有效内存上限；明确 V8 heap 与进程 RSS 的区别。
- cell 总期限，独立于 `yield_time_ms` 观察窗口。
- 输出累计字节、帧大小、文本/图片数量与大小上限。
- 工具调用总量、并发数、排队数量上限。
- Host 故障时 pending 请求整体失败与安全重建。
- 取消后拒绝新分派，迟到回调不影响新会话。

限制须覆盖 Host 和 Node bridge；仅最终输出截断不能防止执行器 OOM。
`node:vm` 不是运行不可信代码的安全机制，不能作为安全替代。
参见 [Node 官方文档](https://nodejs.org/api/vm.html#vm-executing-javascript)。
不必首版支持所有平台，只声明实际验证的平台。

## 工具桥接与权限

Pi 0.85.1 `getAllTools()` 只有元数据，没有执行函数；公开 ExtensionAPI
不存在通用 `executeTool()`。不枚举私有 registry、不猴子补丁拦截全局注册。

工具所有者显式贡献适配器：

```ts
interface CodeModeToolAdapter {
  name: string;
  description: string;
  parameters: JsonSchema;
  execution: "parallel" | "exclusive";
  invoke(args: unknown, context: NestedCallContext): Promise<NestedToolResult>;
}
```

版本化发现协议须支持加载顺序无关、注销、刷新、重复名称拒绝。未适配工具
继续 direct，不假装可嵌套调用。禁止 `exec/wait` 自递归。

重新调用 `createReadTool/createBashTool` **不等价于当前 Pi 工具**：会丢失
SSH/容器 operations、`baseToolsOverride`、shell 前缀或权限包装；即便
`sourceInfo.source === "builtin"` 也不能证明等价。factory adapters 必须是
显式授权的新本地能力；要保留原行为则由原工具所有者贡献 adapter。

嵌套直接调用不经过 Pi `tool_call/tool_result`，既有审批、审计与脱敏插件
不会自动生效。桥接须对所有能力明确授权，包括读取。可并发≠无需权限。

最小管线：授权 → 规范化/校验 → 审批最终参数 → 执行 → 结果处理/脱敏。
无授权、审批拒绝/异常/超时均 fail closed。参数不能在审批后被替换。
不执行未经信任项目配置授予的能力。长期可以推动 Pi 提供原生命周期下的
公开嵌套执行 API，但不能把不存在的 API 当作前置条件。

## 状态、输出、控制流

- 每 cell 新 JS 环境；有限大小 JSON `store/load`，首版仅内存。
- session replacement、tree、reload 清空并提示；禁止重放代码恢复状态。
- model 切换先取消旧 cell；是否保留已提交 JSON 需在 S2 明确并测试，
  不能继续使用旧模型上下文的工具句柄。
- store 不是事务：Host 正常报错完成也可能提交此前写入；终止语义单独验证。
- 外部文件、进程、网络副作用不回滚。
- 工具业务数据供 JS 过滤，只有显式 `text/image` 进入模型上下文。
- 轨迹、耗时、诊断放受限 UI/details；不自动把全部工具 details 暴露给 JS。
- 需要保留或明确拒绝 `usage`、`terminate`、动态工具激活等特殊契约；
  不兼容的工具保留 direct，不能静默丢弃语义。
- 嵌套参数校验失败与工具错误必须能被 JS 捕获；脚本失败不能伪装成功。
- 工具文档生成有大小预算；名称冲突明确报错，不能静默丢掉工具。

首版单活动 cell，内部可有界 `Promise.all`。明确可并发工具并行，其他默认
独占；独占只针对 bridge，不宣称整个 Pi 会话全局互斥。

取消：停止分派 → abort 嵌套任务 → terminate JS → 等待已开始任务收尾 →
清理 cell。无法确认副作用结束时不能释放互斥或报告完全清理。迟到回调通过
会话代际隔离。退出/reload 必须幂等关闭资源；工厂加载时不启动后台 Host。

## 与现有 Codex 包组合

1. [tool-activation.ts](../../pi-extensions/pi-codex-runtime/src/tool-activation.ts)
   会在模型/thinking 等变化时自动启用工具。首版 mixed 不改变其 active 集合。
   后续 hide-bridged 必须与所有者协作；退出只撤销自己的修改，不恢复旧全量快照。
2. 当前 Responses
   [tools.ts](../../pi-extensions/pi-codex-runtime/src/providers/responses/tools.ts)
   一律发 function；
   [stream.ts](../../pi-extensions/pi-codex-runtime/src/providers/responses/stream.ts)
   把 custom 映射为 `{input}`；
   [messages.ts](../../pi-extensions/pi-codex-runtime/src/providers/responses/messages.ts)
   replay 读取 `arguments.input`。只给 exec 加 `constrainedSampling` 不够。
   后续独立修复通用 grammar encode/decode/replay，不硬编码 exec 执行。
3. hosted web/image 的本地定义含占位路径，不能包装 `.execute()` 当成真实
   嵌套工具。hosted 保留 direct，standalone 经明确适配才嵌套；不静默换账号、
   endpoint 或执行方式。

以上未来协作不改变功能归属：执行器、会话、审批、提示词和 UI 都属于新包。
S0 不修改任何现有 Codex 运行行为。

## 实施与验收

| 阶段 | 交付 |
| --- | --- |
| S0 | 固定 Host 实际运行；Pi 公开 API/权限边界；取消及资源限制；可复现证据与 go/no-go |
| S1 | 独立包、JSON exec、mixed、少量授权只读 adapters、有界并发/输出 |
| S2 | wait/terminate、跨轮 cell、贡献协议、写入/进程适配与特殊结果契约 |
| S3 | 可选 Codex adapters、grammar 全链路、跨 provider 历史兼容 |
| S4 | 协作式 hide-bridged、动态注册/恢复；有需求再做严格 only |

S1 可内部等待 cell 完成，暂不对模型暴露悬挂 cell；目标仍是 exec+wait。
S0 的“完成”是问题得到可复现回答，不意味着安全发布条件全部通过；
发现的否定结果必须成为明确阻塞，不能以能力降级冒充通过。

S0 必须覆盖：固定资产身份与协议、JS/工具桥接、fresh isolate/store、错误、
wait/terminate、无限循环终止、Host 故障、输出/内存/调用预算、Pi 真实 loader
和 agent 工具事件、override/本地 factory 差异、拒绝授权/审批异常的零副作用。
高资源测试只能在已验证的 OS 限制下执行，不使用真实凭据或用户文件。

后续验收还包括至少两种 provider API 实测、单独安装无 Codex 依赖、产物
实际加载、正反加载顺序、模型/session/tree/reload 失效、图片、usage、互斥收尾。
本机 fixture 通过不等于真实服务、跨平台或权限生态兼容已验证。

S0 的执行说明及结论见 [验证记录](../audits/pi-code-mode-s0.md)。

## S1 落地决策

用户在 S0 之后授权完整 S1。实现位于 `pi-extensions/pi-code-mode/`；
详见 [S1 验证记录](../audits/pi-code-mode-s1.md) 和包 README。

- 独立私有包 `@oai404iao/pi-code-mode`，仓库 release track 为 blocked。
  可打包/本地安装；未授权 npm 发布，不依赖任何 Codex 包。
- 普通 JSON `exec({code})`、mixed；不暴露 wait，不隐藏或包装其他工具。
- 配置仅使用独立 CLI flags；不增加持久配置文件。
  `/code-mode on` 确认 cwd 的本地读取权限；headless 必须显式 root flag。
- 内置两个**新本地能力**：只读 `tools.read` 与 `tools.ls`，不冒充 Pi 工具。
  Linux fd-anchored traversal + O_NOFOLLOW 拒绝越界、symlink 和特殊文件。
- 所有 provider 共用固定 Host。提供真实内核 memory/pids/CPU 校验；
  30 秒父进程期限 + 独立 35 秒 systemd kill timer；Host 自身最长 1 小时。
  关闭未确认时保留 watchdog，不能只杀 proxy 就宣称停止。
- 正常 exec 之间保留 JSON store；失败/取消/模型/tree/reload/off 清空，
  5 分钟 idle 或 1 小时 Host 生命周期也会丢失。S1 不持久化、不重放。
  这是对上游“失败完成也可能提交 store”的额外 runtime-reset 策略，不是事务。
- 有界只读并发、调用/排队/帧/代码/输出预算；输出超预算报错并 reset，
  不是截断后伪装成功。只支持文本，不实现图片/音频/通知。
- 两种原生 provider adapter 使用 fixture HTTP 跑完整工具往返；
  这不是两家真实账号或外部 endpoint 实测。

## S2 落地决策

用户授权完整 S2。实现仍在独立包；详见
[S2 验证记录](../audits/pi-code-mode-s2.md) 与
[完整使用/贡献契约](../../pi-extensions/pi-code-mode/README.md)。
上文 S1 描述作为阶段历史保留；下列 S2 决策覆盖对应旧限制：

- JSON `exec({code,yield_time_ms?,timeout_ms?,max_tokens?})` 与
  `wait({cell_id,yield_time_ms?,max_tokens?,terminate?})`，保留 mixed。
  单 cell、单 observer；终态输出/usage 全部收取后 ID 才被消费。
- cell 独立于单次 observer 和正常 agent_end，可跨模型 turn、用户 prompt。
  Esc 单独取消 cell；wait 取消仅退出观察、不丢结果。忙碌错误携带可恢复 ID。
  终止先取消分派，再等待实际 effects 收尾；未确认停止则 poison，禁止新 cell。
- 总期限默认/最大 300s，可主动缩短；独立 OS watchdog 最大 305s，
  不被 wait 延长。观察窗口最大 30s；max_tokens 为每 token 四 UTF-8 字节估计。
- 正常 Host terminate 保留之前已提交 store，丢弃当前 pending writes。
  已先完成的 Host Result 不可撤回提交；收尾期间取消不会伪装全部成功。
  model/tree/session/reload/off、贡献刷新/注销均清空 store/旧 cell，不重放。
- 通过公开 `./contributions` 子路径和版本化 `pi.events` 发现显式适配器；
  `owner__tool` 精确授权、无歧义命名、每 cell 冻结快照、有界目录与结果。
  prepare → 冻结/校验 → before → invoke → after；policy 拒绝/异常/超时 fail closed。
  仅明确 parallel 的 read 并发；writer/process 在 bridge 内为 FIFO 独占屏障。
- 独立 `--code-mode-write` 与 `--code-mode-process` 授权。write 在 root 内原子
  create/replace，接入 Pi 协作文件队列；bash 独立 cgroup + gate + watchdog。
  **process 是完整当前用户本地执行权，不受 root 限制，不是 FS/network 沙箱。**
  不继承 Pi 原生权限/脱敏钩子、SSH/容器 operations；外部副作用不回滚。
- 数据返回 `{value,usage?}`；usage 每次观察仅交付一次，取消不消费。
  丢弃结果记 audit-only receipt，不伪造 native totals；超时收尾后的迟到 receipt
  若 Pi runtime 已失效则输出 stderr，不向替换会话注入内容，也不承诺持久化。
  `terminate`/`addedToolNames` 等 Pi 控制字段明确拒绝，依赖它们的工具保持 direct。
- IPC frame 从 128 KiB 增至 1 MiB，仅用于有界 128 KiB 写入的 JSON 转义开销；
  cell text 仍为 32 KiB，bridge result 64 KiB，调用/并发/队列仍为 32/4/16。
- 包仍 private/blocked。未新增 Codex 包依赖、grammar、tool hiding 或发布。

## S4 落地决策（先于 S3）

用户在 S2 后直接授权完整 S4。它是通用 JSON 执行层之上的工具可见性策略，
不依赖 grammar 或 Codex 专用适配。详见
[S4 验证记录](../audits/pi-code-mode-s4.md) 与包 README 的 owner 示例。

- 新增 `--code-mode-visibility mixed|hide-bridged`，默认 mixed；
  `/code-mode visibility mixed|hide-bridged` 在当前 runtime 切换，不授予权限、
  不重放/取消正在运行的 cell；reload 重新采用 CLI 值。`only` 明确拒绝。
- 只处理已被 `--code-mode-tools` 精确授权，且通过贡献的 `direct` 字段
  显式提供 owner binding 的工具。缺少任何条件均保持 direct，不按同名猜测。
  内置新本地 read/write/bash 能力不证明与 Pi 当前工具等价，因此不隐藏它们。
- 公开 `createCodeModeDirectBinding(pi,{name,sourcePath})`；owner 用
  `setActive(boolean)` 表达当前意图，`reconcile()` 在动态注册后重新协调，
  `dispose()` 撤回同意。公开 sourceInfo.path 精确匹配 + metadata fingerprint
  保守拒绝可检测替换；builtin/sdk 与 exec/wait 不可由该 helper claim。
- owner 的 `setActive` 接入其模型/thinking/命令等现有激活逻辑，避免双方
  反复启用/隐藏。S4 不猴子补丁 `pi.registerTool`/`setActiveTools`，不修改
  Codex autoEnable、不扫描私有 registry。
- 每个隐藏只持有同步 lease 与单工具恢复意图；释放时合并 live active set。
  不恢复完整旧集合，不误激活原本 inactive 的工具，保留无关增删；
  owner 在隐藏期间表达的新意图优先。旧 lease 不操作检测到的替换定义。
- 贡献刷新/注销沿用 S2 取消与清空 cell/store；可见性同步在当前目录刷新后
  完成。off/mixed/dispose/shutdown/reload 释放 lease；永久 blocked 会话在
  协调时恢复 direct，后续 visibility/model/tree 事件不会重新隐藏。
- 发现 Pi 工具快照早于 turn_start/context；因此使用 session_start、
  before_agent_start、turn_end、自身工具/命令边界及 owner 同步事件。
  实际验证动态 loader 新增贡献后，**紧接着的模型请求**使用新目录并隐藏
  direct 定义；不靠 provider payload rewriting。
- Pi 没有公开 active-tools-changed 事件或 registration identity。
  `--tools` allowlist 的 registry refresh、reload 或非协作者可重新启用工具；
  同源同 metadata 换 execute 无法自动识别。owner 必须在语义替换前 dispose、
  重建 binding 并 refresh contribution；不宣称不合作扩展也可全局锁定。
- active 移除可能退回普通完整工具列表，影响 deferred loading/prompt cache；
  不伪造 addedToolNames、不改写历史，不把“隐藏”当权限边界或 native hooks 继承。
- 本阶段未实施 S3、没有发布；后续 S3 见下节。S0–S2 章节保留阶段历史。

## S3 落地决策（在 S4 之后）

用户授权先提交 S4，再完整实施 S3。复用同一执行器、贡献协议、cell/store
与权限模型；不另建 Codex 专属 Code Mode。详见
[S3 验证记录](../audits/pi-code-mode-s3.md)。

- 新增 `--code-mode-protocol json|auto|grammar` 和同名命令，默认 JSON。
  auto 只在受支持 OpenAI API、模型明确 grammar metadata 且 transport
  可确认时启用；未知 custom provider 退回 JSON。强制 grammar 不满足条件
  时 exec 在启动 Host 前报错，不影响 wait 收尾。切协议不重置 cell/store。
- transport v1 总线对比实际 active streamSimple 函数身份，覆盖 legacy
  与 native Provider；Codex core 自愿握手。不能只认 provider 字符串。
- grammar 为原始非空源码包装，不是 JS parser、安全边界或新的执行语言。
  canonical arguments 仍为 `{code,...controls}`；首行
  `// @exec: {...}` 承载 yield/timeout/output controls，计入 24 KiB，
  对未知键、范围、冲突先验证再执行。
- 公共 context hook 仅为 grammar 请求投影历史 exec 控制项；原会话消息、
  call/result ID 不变，原始输入字节不变，不执行历史代码。不可表示的历史
  保守禁用 grammar，使用 JSON 或干净分支，不静默丢掉 timeout 等控制项。
- Codex runtime 通用处理任意单一 required string 属性的 grammar tool，
  不硬编码 exec；Standard/Lite、SSE/WS 均覆盖声明、escaped JSON deltas、
  done-only、call/result replay。旧 apply_patch raw input 行为保留。
  JSON/grammar 切换按当前声明选择 wire 类型；不匹配的缓存前缀回退全量请求。
- Pi 安装 loader 的 SDK root alias 会错误重写 constrained-sampling 子路径；
  因此 runtime 自行实现小型 wire codec，测试以固定 Pi 0.85.1 原生 helper
  为 oracle，不导入私有 SDK 路径、不解析全局安装目录。
- core 可选贡献 `codex_core__apply_patch`：exclusive write，复用 owner
  executor 与 Pi mutation queue；不是 root-confined。取消在入队执行前检查，
  已进入的写入等待结算，不宣称回滚。web 可选贡献
  `codex_web__web_search`：仅 standalone、parallel read，复用 profile/auth/
  alpha-search；auth I/O 前快照身份与 history，避免跨轮 cell 污染新轮元数据。
- 以上工具须精确 grant；owner 与 Code Mode 双向均无 package dependency。
  原 Codex broker 去重、load-order/reload 保持。hosted placeholders、
  view_image/image_generation 不桥接；multimodal/control 不降格伪装文本。
  Codex owner 尚未接入 S4 activation lease，故不贡献 direct binding、不自动隐藏。
- S0–S4 的实现不意味着发布、真实账户端点可用或安全沙箱认证。
  保持 private/blocked 与现有版本/锁；strict only、多模态后续仍需独立授权。
