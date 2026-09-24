# Codex 离线消融与 Pi 内置实现对照

## 结论与范围

**建议保留扩展特有的协议、回放与 continuation 层，优先吸收 Pi 的
取消、重试和终止状态处理；不建议整体替换为内置 provider。**

初轮只新增离线实验与报告，随后按授权实现第 1、2 批修复和剩余工作，
各阶段结果见末节。前两阶段没有调用模型接口；最后一阶段经用户明确授权，
使用已有 `openai/gpt-6-sol` 配置完成有限真实 smoke，不切换账户或泄露凭据。
工作区依赖和发布状态保持不变；兼容矩阵仅在临时副本中离线安装锁定依赖。
离线部分是协议层消融，不是模型质量、网络延迟或 token 成本评测。

- 扩展基线：`351c1943c7402b56f36abbe22fe45bb639bf5f81`。
- 对照：工作区 `@earendil-works/pi-ai@0.87.1` 的
  `dist/api/openai-codex-responses.js` 和 `openai-responses-shared.js`。
  本机安装的 Pi 也是 0.87.1；其 Codex provider 文件与工作区 SHA-256 相同：
  `6e69310d77278231cfc87d7f03ee815d4a0f2ff273e6c43fcee6835e7df2b0c7`。
- Node：`v24.21.0`。比较固定版本，不声称代表上游最新实现。
- SSE 差分使用同一 `gpt-5.5` 描述符、上下文、假 JWT、固定响应，
  直接调用两侧 stream 入口。它不覆盖 Pi loader、OAuth 或真实服务行为。
- 消融直接调用实现 owner 的现有函数，不依赖兼容包转发或修改源码。
  Lite 是合成请求形状对照；WS 是 continuation 纯函数实验，没有建立连接。
- 未对 imagegen、真实 compaction 服务、prewarm 收益、所有模型/包组合
  做独立消融；既有单元测试不能替代这些效果评测。

## 复现与证据

在已经按仓库锁文件安装依赖的 checkout 中运行：

```sh
npm run test:codex-ablation
```

入口为 [`scripts/codex-ablation/run.mjs`](../../scripts/codex-ablation/run.mjs)。
要求 POSIX；截止期限清理测试在 Linux 验证。它会：

1. 检查 Pi 精确版本为 0.87.1。
2. 在 `$HOME/.local/state/agents/tmp/codex-ablation-*` 创建私有目录，
   使用空 HOME、XDG、agent 目录与工作目录，不继承凭据、代理或 `NODE_OPTIONS`。
3. 强制 SSE、替换 fetch；所有响应在内存生成，不访问模型服务。
4. 顺序执行测试文件；60 秒超时或中断时终止测试进程组，包括子 worker。
5. 保留 `manifest.json`、`tests.tap`、`result.json`，不自动删除。
   manifest 记录 Git revision/dirty 状态、Node/Pi 版本、锁文件、
   内置实现及实验源文件 SHA-256。

初轮断言是 **characterization tests（现状刻画）**：
对“扩展当前有问题”的预期也会通过。第 1、2 批修复已经将
D1/D3/D8/D11/D12/D15 改为正确行为的回归断言；剩余工作又将
D2/D4/D5/D6/D7/D9 转为回归断言。D13/D14 保留内置实现的反例。
**不能为了保持实验全绿而保留缺陷**。
实验单独运行，未加入通用 CI，避免将 0.87.1 的已知差异误当成永久契约。

## A：组件消融

源码：[`components.test.ts`](../../scripts/codex-ablation/components.test.ts)。
每个 A 用例保持其余输入相同；比较结构而非随机 identity/timestamp。

| 用例 / 移除项 | 实测变化 | 支持的结论 |
| --- | --- | --- |
| A1 custom patch 声明 → JSON function | 工具声明由 840 字节降至 180 字节，其余请求字段相同 | grammar 声明有固定体积；**不能据此判定 JSON 更准、更快或更省 token**，未执行 patch |
| A2 reasoning summary 请求 | 仅 `reasoning.summary` 消失，effort 不变 | 可以独立控制展示相关请求；未验证模型推理变化 |
| A3 parallel tool calls | 仅 `parallel_tool_calls` 从 true 变 false | 请求开关独立；未验证模型是否并行调用或任务耗时 |
| A4 精确文本回放 signature | 文字保留；原始 item ID、phase、引用 annotations 丢失 | v2 原始 item 回放不是冗余；同时断言原始历史未被修改 |
| A5 WS continuation cache | input 从 1 个增量 item 回到 3 个完整历史 items，不再含 `previous_response_id` | 有协议级增量价值；请求参数或前缀改变时必须失效，未证明服务端缓存命中或延迟收益 |
| A6 web observer | web 活动展示块消失；回答块、usage、捕获的两个响应 items 相同 | 展示层可以独立移除，不必连带删除传输/回放能力 |
| A7 normalization 层 | terminal-only compaction 的 content/signature 仍相同，但 continuation 捕获的 item 从 1 变 0 | 存在内容层兜底，**不等于 normalization 可删除**；本用例未做后续真实续传 |

P1 单独比较 Standard/Lite：Lite 改用 `additional_tools` namespace、
developer prompt、`reasoning.context=all_turns`，并关闭 parallel/hosted
profile 能力。这是**复合协议对照，不是单因素消融**，不能把变化归因于其中一个字段。

## D：完整实现差分

源码：[`differential.test.ts`](../../scripts/codex-ablation/differential.test.ts)、
[`retry.test.ts`](../../scripts/codex-ablation/retry.test.ts)。
这些用例比较两个完整实现，**不属于组件移除实验**。

以下记录初轮消融基线，修复后的差异见末节。

| 用例 | Pi 0.87.1 内置 | 消融基线扩展（修复前） |
| --- | --- | --- |
| D0 正常文字/Unicode/usage | 正常完成 | 相同关键结果 |
| D1 EOF 前最后一帧无空行 | flush 后正常完成 | 丢失 terminal 帧，报提前关闭 |
| D2 中间出现无效 JSON 帧 | 明确协议错误 | 跳过，随后正常完成 |
| D3 headers 后 body 停滞，再 abort | 取消 reader 并结束 | 不取消/不结束；测试主动关闭 body 后才返回 aborted |
| D4 注入 `options.fetch` | 使用注入函数 | 忽略它，使用全局 fetch |
| D5 `cacheRetention: none` | 无 `prompt_cache_key` | 仍有 session 派生的 key |
| D6 input=100, cached=30, cache_write=20 | fresh input=50, cacheWrite=20 | fresh input=70, cacheWrite=0 |
| D7 input=10, cached=30（异常计数 fixture） | fresh input=0 | fresh input=-20 |
| D8 incomplete/content_filter | error 终止 | 当作 length，发送 done；max_output_tokens 两侧均为 length |
| D9 encrypted reasoning 仅在 terminal output 补齐 | backfill 持久化 signature | signature 缺少 encrypted_content |
| D10 payload replacement / response hook | 均生效，验证实际发送体 | 均生效，验证实际发送体 |
| D11 HTTP 503, `maxRetries: 0` | 请求 1 次，无 retry sleep | 请求 4 次，计划 sleep 1000/2000/4000ms |
| D12 HTTP 429, Retry-After=30s, retry budget=5s | 请求 1 次，报告超出等待预算 | 请求 4 次，忽略服务端等待值与预算 |
| D13 HTTP 400, `maxRetries: 1` | 请求 2 次 | 请求 1 次，保留 non-retryable 分类 |
| D14 多个 CRLF SSE frames | 本 fixture 报 JSON 错误 | 正常完成 |
| D15 terminal status=cancelled | error event，带错误信息 | **done event 但 stopReason=error**，无错误信息 |

注意：

- D3 使用事件循环同步与悬挂的内存 reader，不是取消延迟 benchmark；
  它复现 provider 层的问题，不断言所有 Pi UI 取消路径都会挂起。
- D11–13 的 retry-sleep stub 记录计划等待并立即触发回调，
  将 headers deadline 保持未触发；没有真实等待、测量 wall time 或验证超时精度。
- D6/7/9/15 是兼容性/防御性输入，不说明实际 Codex 服务经常返回这些字段。
  D9 的上游实现注释说明其动机涉及 Azure 风格的延迟 reasoning 字段。
- D2 是容错策略差异，不直接判定哪边正确。应先明确 malformed-frame
  的产品契约，再决定 fail-closed 还是带诊断的兼容模式。
- **D13、D14 是反例**：上游并非处处更好，照搬会失去现有保护。

## 改进方案：按优先顺序拆分

### 1. 取消与 terminal 契约（优先）

实现位置：
[`core/.../sse.ts`](../../pi-extensions/pi-codex-core/src/providers/openai-codex/sse.ts)、
[`core/.../stream.ts`](../../pi-extensions/pi-codex-core/src/providers/openai-codex/stream.ts)、
[`runtime/.../usage.ts`](../../pi-extensions/pi-codex-runtime/src/providers/responses/usage.ts)。

- 学习内置 `parseSSE(response, signal)`：读 body 阶段直接订阅 abort，
  取消 reader，finally 释放 listener/lock。当前 header helper 返回后已解除
  parent signal，body parser 又不接收 signal，D3 明确复现后果。
- flush EOF 残余 frame，同时**保留扩展现有 CRLF 支持**；另补跨 chunk 的
  CR/LF、Unicode、abort-before-start、缺少 terminal 等回归。
- 学习内置 `assertSuccessfulOutput`：发送 done 前验证终止状态；
  将 incomplete reason 区分为输出上限与错误，保留原始原因。
  不要靠类型断言把 error 强行当成合法 done reason。
- 验收：D1/D3/D8/D15 转为正确行为断言；既有 replay/WS/identity/
  null-content 测试保持通过。

### 2. 统一调用方重试语义，但保留不可重试错误分类

实现位置：
[`stream.ts`](../../pi-extensions/pi-codex-core/src/providers/openai-codex/stream.ts)、
[`retry.ts`](../../pi-extensions/pi-codex-core/src/providers/openai-codex/retry.ts)。

- SSE 尊重 `maxRetries`、`Retry-After(-ms)`、`maxRetryDelayMs`；
  优先复用已有 WS 延迟解析逻辑，不再平行维护两套语义。
- 默认是否从 3 次改为 Pi 的 0 次需作为明确行为变更讨论，
  避免与 Pi 外层重试叠加。首先确保显式 `maxRetries: 0` 生效。
- **保留 `NonRetryableProviderError`**，不要复制上游 catch 中把 400
  再当网络错误重试的路径。
- 验收：D11/D12 对齐；D13 保持扩展只请求一次；补 quota、abort-during-sleep。

### 3. 小范围补齐 usage、reasoning 与 stream options

- usage：按内置实现分开 fresh/cacheRead/cacheWrite，并给 fresh input 加下界；
  不改变现有 service-tier pricing 钩子，单独验证费用计算。
- reasoning：以 item ID 在 terminal output 中补齐缺失的 encrypted_content，
  不覆盖已存在 signature，也不丢弃扩展 v2 文本/引用/compaction 元数据。
- 支持注入 fetch；cache retention 与逻辑 thread/session identity 分离，
  **不能为关闭缓存而破坏 subagent 的身份关联**。
- 验收：D4–D9 相应用例对齐，保持 observer、原始回放、namespace 和身份测试。

### 4. 先补证据，暂不实施的候选

以下仅有源码证据，**没有纳入本轮行为差分**：

- 扩展代理选择读取 `process.env`；内置 WS proxy resolver 可接收
  provider-scoped env。需额外验证 custom fetch/proxy/NO_PROXY 的边界。
- 扩展 WS connect/idle 使用常量，而内置传入
  `websocketConnectTimeoutMs`/`timeoutMs`；需用 loopback 做阶段性超时测试。
- 内置 SSE 在可用时做 zstd 压缩。D10 已能解码其请求供断言，但没有做压缩
  收益实验；是否适用于扩展自定义 endpoint/proxy 必须另证，不能直接全量启用。
- 内置 shared converter 可作为持续差分 oracle，但不能直接替换扩展 converter：
  A4/A6/A7 与 Lite namespace、native item、image/web replay 存在额外契约。

## 初轮验证结果与局限

- 新实验：7 个组件消融 + 1 个复合协议对照 + 16 个完整实现差分/控制；
  另有 1 个 runner 截止期限测试，**25/25 通过，无跳过**。
  原始结果由 runner 保存为 TAP。
- 既有 `npm run check -w @oai404iao/pi-codex-minimal-tools`：
  typecheck 通过，**344/344 tests 通过**。
  首次用隔离脚本的 `umask 077` 运行时，既有 executable mode 测试失败
  （0700 对 0755）；确认其建文件方式受 umask 影响后，
  在同一私有目录使用正常 `umask 022` 重跑通过，未修改该测试或实现。
- 顶层命令使用 npm 11.19.0；切换空 HOME 后现有 npm shim 解析为 12.0.2，
  因而隔离的既有检查由 npm 12.0.2 调度。未安装/同步/修改任何依赖。
- 未运行完整仓库 CI、Pi 0.87.0 floor、tarball 安装矩阵或真实模型评测。
  本轮无 tarball-facing 修改，不添加 changeset。

下一阶段若授权真实评测，应固定模型/effort/任务集，成对比较组件开关，
随机执行顺序并重复采样，记录成功率、tool errors、token、TTFT/总时长，
单独控制冷/热缓存。**本报告不把离线字段差异推断成模型效果提升。**

## 后续实施：第 1、2 批

按后续授权实现，未扩大到 usage 算术、fetch 注入、缓存关闭、
reasoning signature 或压缩等第 3、4 批工作：

- SSE parser 接收 abort signal，取消悬挂 reader 并释放 listener/lock；
  header helper 保留 fetch body 对调用方取消的关联，compaction SSE
  调用点也传递 signal。
- EOF flush 和流式 UTF-8 解码；CR 立即结束一行，并抑制跨 chunk 的 LF，
  同时支持 LF、CRLF、CR，不要求 terminal frame 之后先关闭连接。
- 初始化为 pending；成功终止必须是 stop/length/toolUse。其他 incomplete
  reason（含缺失 reason）、failed/cancelled 以及非终态 queued/in_progress
  不再发出 done；保留 rawStopReason 和错误信息。只有 max_output_tokens
  映射为 length。
- WS 在保存 continuation 之前验证终止状态；失败时关闭连接并丢弃缓存，
  不自动转 SSE。没有修改正常输出上限截断的连接复用策略。
- SSE 尊重显式 maxRetries，未指定仍默认重试 3 次；解析 Retry-After-ms、
  Retry-After 秒数/日期，复用等待上限校验。默认等待上限为 60 秒，
  maxRetryDelayMs=0 表示不设上限；超限直接失败，不通过另一条 catch 路径重试。
  HTTP 不可重试分类不变；默认 quota 分类未在本批调整。
- Retry sleep 完成或取消后移除 abort listener。

回归入口：
`tests/sse-parser.test.ts`、`tests/provider-sse-contract.test.ts`、
`tests/provider-shim-websocket.test.ts`（位于兼容包），以及更新后的离线差分。
包含暂停 body、调用前/等待中取消、分字节 CRLF/Unicode、无 EOF 的 CR 帧、
缺失 terminal、错误终止、WS 缓存失效、默认/显式重试和等待预算。
core/runtime 添加 patch changeset，并同步递归消费者 changeset；
不改版本号、锁文件或发布开关。

实施后验证：

- 更新后的消融/差分：25/25 通过。
- 完整 `npm run ci` 通过：包括全工作区类型检查/测试、架构、changeset、
  license、pack 和 Codex 独立安装组合；兼容包测试增至 367/367。
- `npm run ci:pi-matrix` 的 Pi 0.87.0 floor、0.87.1 target 均通过完整 CI，
  设置 `npm_config_offline=true`，未使用真实模型或发布接口。
- 独立评审发现并补上“CR 分隔 terminal frame 必须在 EOF 前送达”的回归；
  该修复与测试已包含在上述最终 CI/矩阵中。

## 后续实施：剩余工作

### 代码与契约

- usage 分开 fresh input/cacheRead/cacheWrite，fresh input 不小于 0；
  reasoning/totalTokens 和 service-tier 费用钩子不变。
- terminal output 按 ID 补齐缺失的 encrypted reasoning，
  不覆盖已有密文或 compaction signature；补齐结果经过历史转换回放测试。
- 注入的 `options.fetch` 真正接管网络请求，不附加 undici 专用 dispatcher；
  自定义 fetch 的代理处理由调用方负责。默认 fetch 和 WS 尊重 provider env、
  NO_PROXY（含端口、IPv6）；显式空值可清除继承的环境配置。
- WS 连接缓存和 HTTP 回退缓存按有效代理路由隔离，避免更换 provider env 后
  继续使用旧代理连接。普通 prewarm/compaction 的默认路由使用同一 key 规则。
- `cacheRetention:none` 不发 prompt_cache_key，不复用 WS socket/continuation，
  不等待或使用 startup prewarm；session/thread/subagent 身份仍保留。
  不强制清除其他在途请求的缓存，也不承诺服务端不会自动缓存。
- WS connect/idle 尊重 `websocketConnectTimeoutMs`/`timeoutMs`，0 关闭相应计时，
  未指定仍保留 15s/300s 默认。共享握手的后来调用方有独立 deadline/abort，
  session shutdown 也能取消没有连接时限的在途握手。
- 畸形 SSE JSON 报协议错误，不再跳过；明确 quota/billing hard limit
  不重试，普通限流仍可重试。HTTP-200 SSE 中的 compaction quota 错误也不会重试。
- zstd level 3 仅用于精确的内置 Codex SSE URL、非 API-key endpoint 模式、
  无显式 Content-Encoding 且压缩后字节更少的请求；移除失效的 Content-Length。
  自定义端点、WS、`/compact` 不猜测压缩支持。不可用/失败则保持原 JSON 编码。

### 压缩实验

```sh
npm run test:codex-compression
```

Node 24.21.0，每种合成输入预热 5 次、测量 50 次；每个样本验证解压回原 JSON。
该测量包含 helper/header 构造开销，不能归因成纯 zstd 指令耗时。

| 合成输入 | 原始 bytes | 编码 bytes | 平均编码 ms |
| --- | ---: | ---: | ---: |
| 短请求 | 134 | 114 | 0.020 |
| 高重复历史 | 109267 | 487 | 0.099 |
| 混合摘要字符串 | 127041 | 36082 | 0.435 |

高重复输入故意容易压缩，不能外推真实会话的压缩率。这不是 token 节约、
TTFT 或网络延迟证据。当前真实评测模型走自定义 OpenAI endpoint，保持不压缩；
内置 Codex endpoint 的接入依据为已核对的 Pi 0.87.1 实现，未冒用其他账户进行
真实 zstd 服务端验收。

### 真实 smoke：明确的兼容性边界

用户指定 `openai/gpt-6-sol`，允许真实调用并授权本地提交，不授权推送/发布。
该配置的 API 是 **openai-responses**，不是 openai-codex-responses；
因此真实 baseline 使用相应内置 OpenAI Responses 实现，离线 Codex 对照未变。

```sh
# 会真实调用模型；不会在普通 CI/离线实验中自动执行
npm run test:codex-live -- --execute openai/gpt-6-sol
```

脚本每次运行最多 12 个请求、每请求 60s、maxRetries=0；固定算术、JSON 提取、
工具调用三种公开合成任务，各重复两次，并在第二轮反转实现顺序。
统一 low effort、无 summary、无 priority tier、parallel=false、
cacheRetention=none。工具只验证声明/调用，不执行本地操作。
不发送仓库、现有会话或私人文件；保留指标，不保存 token、URL、headers 或回答全文。

首次 12 个请求的结果：

| 实现 | 成功 | 实际请求形态 | 观测 |
| --- | ---: | --- | --- |
| 扩展 | 6/6 | Lite | 算术、JSON、工具调用均符合预期；成功样本耗时 2.19–3.65s |
| 内置 OpenAI Responses | 0/6 | Standard | 都以 error 结束，未返回 token usage |

另追加 1 个 30s 上限、零重试的原生算术诊断请求，确认 HTTP 400，
只输出固定的错误类别提示，没有输出原始服务错误/凭据。
本阶段合计 **13 个真实模型请求**。诊断后给脚本补上 fetch 层 HTTP status
及固定白名单 error hints，供后续失败分析；没有为得到全绿而绕过原生请求格式。

扩展 6 次累计返回 596 tokens；模型描述符中的费率计算出的 cost 字段合计
0.001896，**不是实际账单**。内置未返回 usage，不能据此认定其费用为零。

**结论仅为当前配置下扩展 smoke 可用、内置路径不兼容**。
两侧协议形态不同且原生 baseline 失败，不能报告质量提升百分比、速度胜出，
也不能称作完成了公平的性能 benchmark。若要比较性能，需要另找同一账户下
两实现都接受的共同协议/模型，不能在本轮偷偷替换用户指定的模型。

### 评审与交付

两轮独立评审覆盖代理路由、缓存身份、取消/共享握手、压缩 headers、
compaction quota 和实验安全。发现的四个边界问题已修复并补回归：
共享等待独立 deadline、空环境覆盖、流式 compaction quota、
压缩 Content-Length。新增源模块均在 400 行预算内。
本轮只做本地 Conventional Commit，不推送、不合并、不发布。

剩余工作完成后的最终验证：

- `npm run test:codex-ablation`：25/25。
- `npm run ci`：完整通过；兼容包 387/387，含新增回归；
  架构检查覆盖 203 模块，17 种 Codex tarball/Pi 安装组合通过。
- `npm run ci:pi-matrix`：Pi 0.87.0 floor 与 0.87.1 target
  均通过完整 CI，依赖操作强制 offline。
- live runner 单独通过 TypeScript 检查；真实 smoke 的原生失败保留为失败，
  不混入离线通过数，也不以重跑或换模型掩盖。
