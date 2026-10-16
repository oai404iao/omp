<a id="pi-codex-core"></a>

# @oai404iao/pi-codex-core

为 Pi 的精确模型 profile 提供 Codex Responses 引擎：Standard/Lite 请求格式、SSE/WebSocket、连接预热、安全续传、原生压缩，以及状态诊断和 Fast 命令。

适合只需要传输/压缩增强，或想自己组合工具的用户。**core 不注册 `apply_patch`、`web_search` 或 `image_generation`。** 需要这些工具时另加 [tools](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-tools#readme)，需要一次加载全部功能则使用 [组合包](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-minimal-tools#readme)。本地看图使用 Pi 原生 `read`。

要求 Node.js ≥22.19.0；Pi peer 下限和开发验证目标均为 **1.2.0**。

## 安装与加载

验证本仓库源码时，在仓库根目录安装锁定依赖，再加载本包：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pi -e ./pi-extensions/pi-codex-core
```

`-e` 只作用于本次调用，不保存设置。长期加载本地工作树可使用：

```bash
pi install /absolute/path/to/omp/pi-extensions/pi-codex-core
```

重启 Pi 或执行 `/reload`。本地路径不会复制包，也不会替你安装工作区依赖。注册表预发行版可用 `pi install npm:@oai404iao/pi-codex-core@next`，但它与本工作树不一定相同；源码修改不会自动发布。

core 只依赖共享 runtime 和传输库，不依赖 tools 或兼容外观包。兼容的重复安装通过 broker 去重；runtime 版本不一致或 ABI 不是 v2 时明确报错。不要与不支持 broker 的旧单体混装。

## 开始使用

1. 在 Pi 执行 `/login openai`，选择 API key 或 ChatGPT OAuth。
2. 通过 `/model` 选择 Pi 已有且有明确 profile 的模型。
3. 用 `/codex-minimal-tools` 查看实际 profile、传输与能力；有异常时运行 doctor。

插件不注册替代模型，也不根据模型名猜能力。未知/禁用 profile 使用 Pi 原生实现。`openai` 是维护中的 OpenAI provider；`openai-codex` 只是冻结的弃用兼容入口，每会话提示一次迁移，不自动搬运凭据或改写会话。

### 命令

| 命令 | 用途 |
| --- | --- |
| `/codex-minimal-tools` | 当前模型、配置路径、profile 哈希、有效能力和 active 工具状态 |
| `/codex-minimal-tools:doctor` | 配置/目录诊断及认证状态；`/codex-minimal-tools doctor` 为同义用法 |
| `/fast` | 切换当前会话 Fast 状态 |
| `/fast on`、`/fast off` | 显式设置当前会话 Fast |
| `/fast status` | 同时查看会话选择、配置默认值、当前模型是否支持 |
| `/compact` | Pi 原生命令；压缩由当前 profile 与 checkpoint 状态决定 |

命令沿用旧组合包名称，并不意味着 core 同时安装工具。`/image-gen` 属于 tools。

### Fast 的作用范围

`config.json.fastMode` 只是新会话默认值。`/fast` 把选择持久化为不进入模型上下文的会话条目，不重写配置。选择跟随当前会话分支，支持 resume、`/reload`、fork 和 clone。子代理在下一次请求（包括 followup）跟随主代理的当前选择，已经发出的请求不变。

只有 profile 明确配置 Fast service tier 的模型受影响。不支持 Fast 时可以保存选择，但不会发送该 tier。profile 的 `costMultiplier` 是 Pi 报告费用的配置倍率，不是对服务真实定价或账号资格的承诺。

## 配置

core 和其他 Codex 包共用：

```text
<agentDir>/extensions/pi-codex-minimal-tools/config.json
<agentDir>/extensions/pi-codex-minimal-tools/models.json
```

agent 目录规则、全部字段及迁移表见 [runtime 配置说明](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-runtime#configuration)。不要另建 `pi-codex-core` 配置目录。Pi 自己的 `models.json` 才定义 provider 的 API、base URL、认证和真实模型。

### 常用全局项

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用引擎与压缩；诊断/Fast 命令仍保留 |
| `webSocketEnabled` | `true` | `false` 强制 SSE 并禁用全部 WS 预热，不改模型 profile |
| `fastMode` | `false` | 新会话 Fast 默认值 |
| `codexRequestExtensions` | `true` | 可选 Codex 身份/元数据，不控制格式、传输或原生压缩 |
| `endpoint_config` | `[]` | 按 Pi 认证解析后的 provider/base URL 声明允许的模式、传输和能力 |

要全局只用 SSE：

```json
{
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-runtime/config.schema.json",
  "webSocketEnabled": false,
  "fastMode": false
}
```

要只调整一个模型，在插件 `models.json` 覆盖精确 ID：

```json
{
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-runtime/models.schema.json",
  "version": 1,
  "models": [
    {
      "id": "openai/gpt-6-astra",
      "responses": {
        "mode": "standard",
        "transport": "sse",
        "websocketPrewarm": false,
        "reasoningSummary": "none"
      },
      "compaction": "pi"
    }
  ]
}
```

同 ID 深度覆盖，`extends` 可继承其他 profile，数组整体替换。provider shim 只支持 Pi `openai-responses` 和 `openai-codex-responses` API。Responses 格式、请求增强、传输和压缩是独立选项；不要用其中一个开关代替另一个。

端点声明是能力白名单，不是探测、路由或实现选择器。缺省列表继承 profile，`[]` 拒绝能力。明确的 unsupported 响应仅记录为当前会话/端点的暂时拒绝；失败仍返回错误，不自动换模式、凭据或模型。通用 404、认证失败、限流和连接错误不会误记为能力缺失。修改配置后 `/reload` 清除暂时拒绝记录。

### 默认模型差异

| profile | 引擎默认行为 |
| --- | --- |
| `openai/gpt-6.1-sol` | 继承 `openai/gpt-5.6-sol`：Lite、auto WS/SSE、预热、Responses 原生压缩、Fast 可用（priority、2x 配置倍率） |
| `openai/gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna` | 独立的 Standard SSE；原生压缩、预热、Fast 和远程工具默认关闭 |
| 旧 `openai-codex/...` | 单独保留其冻结兼容 profile，不因相似名称获得现代 profile 的能力 |

custom patch 和 standalone web/image 的 profile 配置只有在相应 tools 能力已加载时才有工具实现。以上默认值不证明账号可访问 Lite、预留端点或 Fast，也不验证实际费用。

## 传输、预热与续传

| `responses.transport` | 行为 |
| --- | --- |
| `sse` | 只用 HTTP 流 |
| `websocket` | 复用 WS；请求是上一逻辑请求的精确前缀扩展时，安全使用 `previous_response_id` 增量 |
| `websocket-cached` | 兼容别名，与 websocket 使用相同的安全续传规则 |
| `auto` | 优先 WS 并重试暂时 WS 错误；只有 HTTP 426 升级拒绝触发会话内粘性的 SSE 回退 |

模型/请求错误、输出或上下文限制，以及升级完成后的连接错误，不会触发自动换传输。连接、续传和回退状态都按会话与 profile 隔离；失败重试不是无限制的“换路线再试”。

启用 `responses.websocketPrewarm` 后，每次会话启动（含 resume/fork）后台安排一次 `generate:false` 最佳努力预热，不阻塞初始化。只发送稳定的 developer/工具前缀，**不发送恢复的聊天历史或待发用户消息**。首个真实请求会消费尚未结束的启动预热句柄；预热超时/失败不会在每条消息上反复重试。

当 Pi 原生 `codemode` 或 `tool_search` 处于 active 状态时，core 跳过推测式 WS 预热，因为 Pi 不公开最终的 `prepareLoadout` 工具投影。这个按内置名称的保护不覆盖任意第三方同类 hook。

## 原生压缩与历史会话

`compaction:"responses"` 只通过当前 SSE/WS 的 Responses `compaction_trigger` 生成原生 checkpoint。旧 unary `/responses/compact` 客户端已移除，`responses-compact` 旧配置必须迁移。

原生 checkpoint 是不透明状态，不是可单独发送的文字摘要。v4 不把压缩前消息留在模型上下文，但原始会话/UI 历史仍保存。回放检查原 provider、model、API 和有效 profile；不兼容时保留 checkpoint 并拒绝继续，绝不拿占位文本假装摘要。

- 改为 `compaction:"pi"` 只改变以后如何生成摘要，不丢弃兼容的原生 checkpoint。
- 仅从 Responses 生成策略改成 Pi，或关闭可选 Codex 元数据，可保持符合保护规则的回放；旧精确 `:wire-off` 缓存后缀会规范化。
- 少数旧内置 profile 哈希有经过审查的迁移白名单；自定义、旧覆盖、未知或后来再次变更的 profile 不能绕过检查。
- 旧 checkpoint 若被其他 context handler 改变边界，会停止而非猜测或恢复已过滤内容。在原模型执行 `/compact` 迁移；重压缩失败保留原 checkpoint。
- 旧扩展不能回放 v4。含原生压缩的会话按敏感数据管理，不要手工改 JSON 重新标记 provider/model。

**与 codemode/tool-search 同时使用：** 没有原生 checkpoint 时，压缩可退回 Pi 文本摘要；已有 checkpoint 时保留并拒绝重压缩。禁用两个编排工具后在原模型重试 `/compact`，或回到 checkpoint 之前的分支。

## 请求与集成契约

- **身份与认证：** 请求遵循 Codex `5a314017` 的 developer 前缀和线程范围确定性 ID；Lite 仅在需要时加入 `additional_tools`。SSE/WS 使用相同的身份/执行元数据快照，WS 保留传输专用字段。Pi 认证、刷新、有效 base URL 及显式 header 抑制始终优先。zstd 仅用于已验证官方路由且已有准备好的 OAuth 凭据。
- **关闭可选增强：** `codexRequestExtensions:false` 保留 Standard/Lite、工具/回放和原生压缩，只停生成可选元数据并隔离 WS 缓存。Lite 的必要信号、namespace、`reasoning.context` 和禁 hosted/并行限制仍在，不会静默降级。
- **采样：** Standard OpenAI Responses 按“Pi 模型默认值 → 钳制后的 Pi thinking level 覆盖 → 请求 `samplingParams`”逐键合并。thinking-level 键用 Pi 名称，不用 provider effort 名称。不能覆盖 envelope、工具、认证、身份、缓存或协议控制；`max_output_tokens` 必须受支持且为有限正数，最小发送 16。ChatGPT 订阅请求忽略 temperature 和输出 token 上限；Lite 只合并 temperature。旧 `openai-codex` 采样行为不变。
- **原始事件：** SSE 和 WS 都按流顺序将解析后的 provider 事件交给 Pi `provider_stream_event`，再做规范化；不是原始 HTTP 字节。
- **Grammar 工具：** 支持 grammar 的模型可在 Standard/Lite、SSE/WS 使用通用 constrained-sampling 工具与规范参数，支持 JSON/grammar 历史切换。tools 通过经所有权验证的 broker 描述符贡献 custom 声明与输入字段映射；core 不加载 grammar 资产、执行器或 renderer，也不改写无关同名工具。
- **历史工具：** 能解析旧 web/image item 不表示启用了那些端点。未知 profile 或未安装能力不会通过回放获得网络执行权限。

## 故障排查

| 现象 | 检查方法 |
| --- | --- |
| 装了 core 却没有补丁/搜索/图片 | 这是预期隔离；安装 tools 或组合包 |
| profile 有配置但引擎未激活 | doctor 检查精确 ID、`enabled`、Pi API 类型和实际认证端点 |
| `endpoint policy` 尚未解析 | 首个请求前正常；列表不会为了显示而额外刷新认证 |
| WS 不预热或使用 SSE | 检查全局 WS 开关、profile、端点白名单以及 active codemode/tool-search |
| 切模型后不能继续 | 检查不透明 checkpoint 身份；恢复原设置、导航回压缩前或开始新会话 |
| 同时加载包时报版本错误 | 统一 runtime 精确版本，不要与旧单体混用 |

不要把诊断成功或离线测试成功当成真实服务权限验证。Responses Lite 属于内部兼容路径，不是 OpenAI 支持的公共 API，服务端变化可能使其失效。扩展在 Pi 进程权限下运行，不提供额外沙箱。

## 开发、参考与许可

从仓库根目录运行：

```bash
pnpm --filter @oai404iao/pi-codex-core run check
pnpm run test:codex-composition
pnpm run test:codex-packages
```

行为测试和传输 fixture 归本包所有，使用模拟 HTTP/loopback，无需真实凭据。`./internal/*` 是内部接线，不是稳定 API。`reference/` 不随 tarball 提供，下列为仓库链接：

- [Standard Responses](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-core/reference/responses-standard.md)、[Responses Lite](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-core/reference/responses-lite.md)
- [Wire 对齐与迁移](https://github.com/oai404iao/omp/blob/main/docs/codex-wire-alignment.md)、[包组合](https://github.com/oai404iao/omp/blob/main/docs/codex-packages.md)
- [补丁协议](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-tools/reference/apply-patch-protocols.md)、[补丁行为](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-tools/reference/apply-patch-behavior.md)
- [LICENSE](LICENSE)、[第三方声明](THIRD_PARTY_NOTICES.md)
