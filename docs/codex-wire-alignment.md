<a id="codex-wire-alignment-and-migration"></a>

# Codex 协议对齐与迁移

请求序列化基线为 OpenAI Codex
[`5a3140176e668a2f72f3c098490eb7f7052d9d85`](https://github.com/openai/codex/tree/5a3140176e668a2f72f3c098490eb7f7052d9d85)。
这是源码与 fixture 对齐，不保证账号获准访问端点或服务端接受请求。
Pi 仍拥有模型选择、认证和实际 base URL；扩展不冒充 Codex CLI。

<a id="breaking-removals"></a>

## 先迁移已移除的执行选项

| 旧选项 | 当前行为 | 迁移方式 |
| --- | --- | --- |
| `tools.imageGeneration:"hosted"` | 关闭该 profile 的图像能力并给出迁移诊断，其他能力不因此整体禁用 | 显式选择 `"standalone"`；内置 GPT-4.1 图像 profile 已切换 |
| `directImageApiFallback:true` | 禁用图像执行并诊断 | 删除该字段；只保留一条 Images 执行路径，不提供 fallback |
| `compaction:"responses-compact"` | 不再调用 `/responses/compact` | 选择 `"responses"` 的原生 `compaction_trigger`，或在历史允许时选 `"pi"` 文本压缩 |
| 全局 `compactionMode:"responses-compact"` | 阻止请求直至迁移，但保留历史 checkpoint 保护 | 同上，不可直接丢弃 opaque 状态 |
| Endpoint allowlist 的 hosted image / unary compaction | 无效项禁用受影响能力，不选择备用路线 | 使用当前 schema 支持的能力 |
| `systemPromptPlacement:"instructions"` | 诊断后归一为 developer input | 当前 schema 只声明 developer input |

移除执行路径不代表删除历史数据：旧 image results 和 opaque compaction checkpoints 仍可回放。
已知 bundle checkpoint hashes 有显式迁移；未知自定义 profile hash 仍拒绝，不能绕过模型身份。
常用开关与文件位置见[配置](configuration.md)。

<a id="request-contracts"></a>

## 请求如何对齐

- Standard 与 Lite 均将基础指令放入 developer input，thread 范围稳定 UUIDv5 prefix ID
  使用 Codex 构造规则。Standard 在适用时发送空 tools，Lite 省略空 additional-tools 项。
- 已核验 profile 明确声明 verbosity/reasoning 的支持与默认值。未知 profile 不从名称模式取得能力；
  不在固定上游 catalog 中的旧模型保留显式本地继承，不将其称作新核验的上游记录。
- Wire window ID 为 `thread_id:window_number`；context-window UUID 独立，放入 turn metadata。
  迁移旧 session identity 不替换其 context UUID 或 thread identity。
- Spawn headers 使用 `collab_spawn`，metadata 使用 `thread_spawn` 和规范 `/root/...` agent path。
  排队任务捕获因果 parent/root turn 归属，不临时借用当前恰好活跃的 parent turn。
- HTTP/WS metadata 使用 ASCII-safe JSON；实际 model/effort 与远程压缩操作元数据描述正在发送的请求。
- Lite prewarm 接受稳定 developer/tool 前缀，不接受任意用户历史。Pi 无法提供最终工具投影时，
  原生 codemode/tool-search 仍禁止推测预热。
- 搜索使用独立 external-tool metadata 投影，不发送整个 Responses blob。可见历史截止最新 user 消息，
  按上游 UTF-8 approximate-token 策略截断。
- 图像接受 `transparent_background`；缺省/`false` 为 `opaque`，`true` 为 `transparent`。
  生成与编辑请求均保持 JSON。

<a id="search-model-policy"></a>

## 搜索 profile

`tools.webSearch` 保留 hosted/standalone 与 content types，接受：

| 字段 | 契约 |
| --- | --- |
| `mode` | `cached`、`indexed` 或 `live` |
| `searchContextSize` | 搜索上下文大小策略 |
| `userLocation` | 用户位置策略 |
| `filters.allowedDomains` | 允许域名过滤 |
| `maxOutputTokens` | Standalone 输出预算，默认固定 catalog 的 10,000 tokens，可按模型覆盖 |

Hosted 请求接收适用搜索策略，但仅有声明不会推断端点或证明引擎已加载。
工具使用见 [tools README](../pi-extensions/pi-codex-tools/README.md)。

<a id="deliberate-pi-boundaries"></a>

## 有意保留的 Pi 边界

- 保持 `originator:pi`、Pi 认证和诚实客户端标识；显式 provider headers 与 suppression 优先。
- 不伪造 Codex 版本、sandbox/approval 状态、Guardian credits、attestation、routing hints
  或 Pi 无法取得的 MCP accounting。
- 不为匹配可选 Codex 遥测字段而增加工作区/Git 信息采集或上传。
- Residency/auth headers 按配置透传；其存在与有效性由 Pi/provider 认证负责，不猜 token claims。
- `codexRequestExtensions:false` 关闭可选身份、headers 和 metadata，不关闭独立选定且受支持的
  Lite 或 native compaction。必需的格式、传输和能力信号仍保留。
- 端点模式/传输白名单及明确的 unsupported 响应始终有效，不改变 Pi 的凭证、地址或身份。

<a id="source-evidence"></a>

## 查来源证据

固定基线中的下列文件定义了对照字段与生命周期边界：

```text
core/src/client.rs
core/src/responses_metadata.rs
core/src/turn_metadata.rs
core/src/session/{mod,session,startup_prewarm}.rs
ext/web-search/src/{tool,history,extension}.rs
tools/src/response_history.rs
utils/string/src/truncate.rs
ext/image-generation/src/{tool,backend}.rs
codex-api/src/{common,images}.rs
```

Namespace 改编保留 Apache attribution 与既有不可变 provenance，新 image 声明有单独固定证据。
不能把历史 source map 改写成声称它分析了这个较新 commit。
完整索引见 [runtime reference](../pi-extensions/pi-codex-runtime/reference/README.md)。
