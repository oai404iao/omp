<a id="pi-codex-runtime"></a>

# @oai404iao/pi-codex-runtime

Codex 扩展共用的配置、模型能力目录、认证投影、请求身份和会话 broker。面向编写 Pi 扩展或 SDK 集成的开发者；只想使用补丁、搜索和生图的用户，请安装 [完整组合包](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-minimal-tools#readme)。

**这是库，不是 Pi 扩展。** 没有默认扩展工厂，也没有 `pi.extensions` 入口；单独安装不会注册 provider、工具或命令。Responses 网络传输属于 core，补丁、搜索与图片执行属于 tools。

要求 Node.js ≥22.19.0；Pi peer 下限和开发验证目标均为 **1.2.0**。包提供 TypeScript 源码，适用于 Pi 或支持 TypeScript 的加载器，不是可直接交给普通 Node.js 的编译产物。

## 安装与接入

core、tools 和组合包会自动安装所需的 runtime，普通用户不必另行安装。开发自己的集成时可使用已发布的预发行通道：

```bash
pnpm add @oai404iao/pi-codex-runtime@next
```

`@next` 是注册表中的预发行版本，不保证包含本工作树的全部功能；修改源码不会发布 npm 制品。验证本仓库源码，应先在仓库根目录运行 `pnpm install --frozen-lockfile --ignore-scripts`，再使用工作区依赖。不要用 `pi install` 把这个库当成独立扩展加载。

### SDK 子会话身份

公开的 `./subagent-inline` 入口给 SDK 创建的子会话安装身份生命周期和 Fast 继承，不安装 Responses 引擎、工具、命令或渲染器：

```typescript
import { createCodexSubagentInlineExtension } from
  "@oai404iao/pi-codex-runtime/subagent-inline";

const childIdentity = createCodexSubagentInlineExtension({
  parentSessionManager: parentSession.sessionManager,
});
```

把 `childIdentity` 加到 Pi `DefaultResourceLoader` 的 `extensionFactories`。`parentSession` 是宿主已经创建的父会话；加载、绑定和释放会话的完整用法见 [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)。组合包保留同名 `./subagent-inline` 再导出。

`openAIIdentity:false` 关闭这个内联扩展的 Codex 身份集成，但不关闭 Fast 继承。子代理在下一次请求时跟随主代理当前的 Fast 选择，包括 followup；已经发出的请求不变。

## 配置放在哪里

所有 Codex 包共用原来的目录，不按能力新建配置目录：

```text
<agentDir>/extensions/pi-codex-minimal-tools/config.json
<agentDir>/extensions/pi-codex-minimal-tools/models.json
```

`agentDir` 优先取 `PI_CODING_AGENT_DIR`；未设置时，优先使用已存在的 `$XDG_CONFIG_HOME/pi/agent`（默认 `~/.config/pi/agent`），否则使用 `~/.pi/agent`。这些是插件读取的用户配置，不是项目 `.pi/settings.json`。

两个 `models.json` 不要混淆：

| 文件 | 职责 |
| --- | --- |
| Pi 自己的 `<agentDir>/models.json` | provider、实际模型、API、base URL、认证、headers、输入模态、上下文限制和价格 |
| 本插件的 `extensions/pi-codex-minimal-tools/models.json` | 精确模型 ID 的 Responses 格式、传输、工具、压缩和 Fast 行为 |
| 本插件的 `config.json` | 全局偏好、能力总开关和端点能力声明 |

runtime 独占规范 [config.schema.json](config.schema.json)、[models.schema.json](models.schema.json) 和默认目录。编辑后执行 Pi `/reload`；加载 core 时可用 `/codex-minimal-tools:doctor` 查看实际路径和诊断。

<a id="configuration"></a>

## 全局配置

以下是完整的当前全局配置示例：

```json
{
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-runtime/config.schema.json",
  "enabled": true,
  "glyphStyle": "unicode",
  "autoEnable": true,
  "webSocketEnabled": true,
  "fastMode": false,
  "applyPatch": true,
  "webSearch": true,
  "imageGeneration": true,
  "imageOutputDir": ".pi/openai-codex-images",
  "imageModel": "gpt-image-2",
  "deferApplyPatchRendering": false,
  "codexRequestExtensions": true,
  "endpoint_config": []
}
```

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 关闭时不启用插件引擎和能力；core 的诊断/Fast 命令仍可用于查看状态 |
| `glyphStyle` | `"unicode"` | UI 字形，可选 `"ascii"` |
| `autoEnable` | `true` | 在支持的模型上自动激活包工具；不覆盖 Pi 明确禁用的工具 |
| `webSocketEnabled` | `true` | `false` 强制 SSE 并关闭所有模型的 WebSocket 预热，不改写目录配置 |
| `fastMode` | `false` | 新会话默认值；`/fast` 只保存当前会话选择，不写回本文件 |
| `applyPatch` | `true` | 补丁总开关；关闭注册和补丁专用行为，不改变其他能力 |
| `webSearch` | `true` | 同时控制 hosted/standalone 搜索的注册、执行和专用显示 |
| `imageGeneration` | `true` | 控制生图工具、`/image-gen`、专用显示和网络执行；不关闭图片输入或历史回放 |
| `imageOutputDir` | `".pi/openai-codex-images"` | 输出目录；相对路径从向上找到的最近 `.git` 或 `.pi` 根目录解析，找不到则从 cwd 解析 |
| `imageModel` | `"gpt-image-2"` | standalone 图片模型，还支持 `"gpt-image-1.5"`、`"gpt-image-1"` |
| `deferApplyPatchRendering` | `false` | `true` 使用 Pi 回退渲染器而非内置流式文件预览 |
| `codexRequestExtensions` | `true` | 是否生成可选 Codex wire 身份与请求元数据；不是 Responses/工具/压缩总开关 |
| `endpoint_config` | `[]` | 按 provider 和认证解析后的 base URL 限制能力，见下文 |

三个能力开关是最终的独立门控，`false` 优先于目录和旧配置，不替换模型 profile，也不改变其哈希。能力未安装、模型未知或 profile 已禁用时，设为 `true` 不会凭空启用实现。

### 请求元数据与隐私

`codexRequestExtensions:false` 停止生成可选 thread/window/turn/subagent headers、`client_metadata`、安装身份元数据，以及现代 OpenAI 路由的默认 `originator`；prompt-cache key 回到 Pi 会话 ID。显式用户 headers/metadata、认证、协议必需的 Lite/旧版 headers 和 WebSocket 协商字段不会被删除。

Standard/Lite、SSE/WS、工具与原生压缩仍由各自配置控制。关闭此开关不等于切回 Pi 整套原生 stream 实现，也不删除已有身份记录。开关变化会隔离 WebSocket/预热缓存；不应把它当成匿名化或会话数据清理功能。

默认身份模型是：根 `SessionId === ThreadId`；子代理共用根 SessionId、各有 ThreadId；`prompt_cache_key` 使用 SessionId，`x-client-request-id` 使用 ThreadId；TurnId 对应一个逻辑回合，WindowId 在成功压缩后推进。安装 UUIDv4 保存在 `<agentDir>/pi-codex-minimal-tools/installation_id`。请求开始前捕获身份，SSE、WS 和独立客户端使用同次调用的快照。

### 端点能力声明

下面仅演示声明格式，**不表示该地址或任意账号实际支持这些能力**：

```json
{
  "endpoint_config": [
    {
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "responsesMode": ["standard"],
      "transport": ["sse"],
      "webSearch": ["hosted"],
      "imageGeneration": [],
      "compaction": []
    }
  ]
}
```

| 列表 | 允许值 |
| --- | --- |
| `responsesMode` | `"standard"`、`"lite"` |
| `transport` | `"sse"`、`"websocket"`；`websocket-cached` 归入后者 |
| `webSearch` | `"hosted"`、`"standalone"` |
| `imageGeneration` | 只有 `"standalone"` |
| `compaction` | 只有 `"responses"` |

匹配精确 provider 和 **Pi 认证解析后的** base URL，忽略尾部 `/`；URL 不得带凭据、query 或 fragment。同一 provider/base URL 的 OAuth 与 API-key 共用声明。未声明的端点保留目录行为；省略列表继承 profile，`[]` 拒绝该能力。无效列表只禁用对应能力并报诊断；重复端点取第一条并报诊断。

白名单不选择实现、不启用模型、不探测服务器，也不切换账号或地址。例如 profile 选择 hosted，白名单只允许 standalone 时，搜索被禁用，不自动改成 standalone。拒绝显式 Responses mode/transport 会报错；`auto` 只在允许 SSE 的前提下可因 WS 被禁用而使用 SSE。

为避免仅展示工具就触发登录/刷新，认证延迟解析。首个请求确定真实端点前，工具投影按模型 profile 展示；执行始终检查端点声明，随后列表反映已解析端点。

明确且可识别的“不支持该能力”响应只暂时禁用当前会话、当前端点的对应模式并警告；失败操作仍失败，不自动重发。认证失败、限流、连接错误、通用 404/5xx 或不支持某个子参数不构成能力缺失证据。不会改写配置或凭据；新会话生命周期或 `/reload` 清除暂时拒绝记录。

## 精确模型配置

例如，只为一个已存在于 Pi 的模型关闭远程工具并固定 SSE：

```json
{
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-runtime/models.schema.json",
  "version": 1,
  "models": [
    {
      "id": "openai/gpt-6-astra",
      "responses": { "transport": "sse", "websocketPrewarm": false },
      "tools": { "webSearch": false, "imageGeneration": false },
      "compaction": "pi"
    }
  ]
}
```

ID 按精确、大小写不敏感的 `provider/model` 匹配，绝不按名称前缀猜支持。同 ID 用户条目覆盖内置条目；`extends` 可继承内置或用户 profile。对象递归合并，数组和标量替换。重复 ID、未知字段、无效 JSON、缺失父项和继承循环均有诊断。未知或禁用模型留在 Pi 原生实现，不获得包工具。

| 字段 | 可选值与约束 |
| --- | --- |
| `id`、`extends`、`enabled` | `id` 必填；`extends` 为父 profile ID；`enabled:false` 禁用此 profile |
| `responses.providerShim` | 是否使用 core 序列化/解析；仅支持 Pi API `openai-responses`、`openai-codex-responses` |
| `responses.mode` | `"standard"` 或内部兼容格式 `"lite"` |
| `responses.transport` | `"sse"`、`"websocket"`、`"websocket-cached"`、`"auto"` |
| `responses.websocketPrewarm` | 启动时一次 best-effort `generate:false` 预热 |
| `responses.reasoningSummary` | `"auto"`、`"concise"`、`"detailed"`、`"none"`；缺省 Standard 为 auto，Lite 为 none；none 不发送 summary |
| `responses.systemPromptPlacement` | 当前公开 schema 只接受 `"developer"` |
| `responses.supportsVerbosity`、`defaultVerbosity` | verbosity 支持与默认值 `"low"`、`"medium"`、`"high"` |
| `responses.defaultReasoningEffort` | `"none"`、`"minimal"`、`"low"`、`"medium"`、`"high"`、`"xhigh"`、`"max"` |
| `responses.supportsReasoningSummary` | 是否允许发送 reasoning summary |
| `responses.endpoint` | 已弃用；`"auto"`、`"openai"`、`"codex"` 仅影响旧 `openai-codex` 路由，不选择凭据 |
| `tools.parallelCalls` | 并行调用许可；Lite 始终强制关闭 |
| `tools.applyPatch` | `false`、`"function"` 或 `"custom"`；custom 要求实际加载兼容 core |
| `tools.webSearch` | `false` 或搜索配置对象，见下表 |
| `tools.imageGeneration` | `false` 或 `"standalone"`，不支持 hosted |
| `compaction` | `"pi"` 文本摘要或 `"responses"` 原生压缩 |
| `fast` | `false` 或 `{ "serviceTier": "priority", "costMultiplier": 2 }`；tier 为非空字符串，可选倍率必须为正数 |

搜索对象必须有 `implementation`，其他字段可省略：

| 搜索字段 | 可选值 |
| --- | --- |
| `implementation` | `"hosted"` 或 `"standalone"`；hosted 只用于 Standard 且要求兼容 core |
| `contentTypes` | 非空、去重的 `"text"`/`"image"` 数组 |
| `mode` | `"cached"`、`"indexed"`、`"live"`，默认 live |
| `searchContextSize` | `"low"`、`"medium"`、`"high"` |
| `maxOutputTokens` | standalone 截断预算，正整数，默认 10000；独立于调用的 `response_length` |
| `userLocation` | `{ "type": "approximate", "country"?, "region"?, "city"?, "timezone"? }`，可选项值均为字符串 |
| `filters.allowedDomains` | 非空域名字符串组成的数组 |

无继承的新 profile 不会默认开启内部协议或工具。要添加自定义 provider，先在 Pi 自己的 `models.json` 定义真实模型，再在此处用准确 ID 添加能力；复制相似模型的名称不构成能力验证。

### 内置兼容性默认值

| 精确 profile | 当前默认行为 |
| --- | --- |
| `openai/gpt-6.1-sol` | 显式继承 `openai/gpt-5.6-sol`：Lite、auto WS/SSE、预热、standalone web/image、custom patch、原生压缩，Fast 可用（priority、2x 配置倍率） |
| `openai/gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna` | 独立 Standard SSE profile、custom patch；远程搜索/生图、原生压缩、预热和 Fast 默认关闭 |
| `openai-codex/...` | 冻结的旧 provider 兼容条目，与现代 `openai` 分开；每会话一次迁移警告 |

这些是兼容策略，**不是账号权限、端点可用性或 Fast 实际价格的保证**。Pi 提供真实模型描述、限制与价格。当前模型证据见随包的 `provenance/pi-openai-120-gpt6.json`；原 `pi-openai-0991-gpt6.json` 保留不变。

## 从旧配置迁移

维护中的 OpenAI provider 是 `openai`，同时支持 Pi 的 API key 和 ChatGPT OAuth。使用 `/login openai`，再用 `/model` 选择现代模型。插件不复制凭据、不重命名 provider、不改默认模型或历史会话。非旧 provider 的 API/base URL/认证都由 Pi 管理，忽略插件 `apiKeyMode` 和 `responses.endpoint` 覆盖。

以下旧 `config.json` 字段仍用于过渡性的内存投影，新配置请移入模型目录：

| 旧字段 | 迁移目标 |
| --- | --- |
| `nativeProviderTools` | `responses.providerShim` 与显式工具实现 |
| `openaiTransport`、`openaiWebSocketPrewarm` | `responses.transport`、`responses.websocketPrewarm` |
| `compactionMode` | `compaction`；仅该旧字段存在时只改变压缩生成策略 |
| `requestProfile.responsesMode`、`reasoningSummary`、`systemPromptPlacement` | 对应 `responses.mode`、`reasoningSummary`、`systemPromptPlacement` |
| `requestProfile.patchTransport` | `tools.applyPatch` |
| `requestProfile.supportsHostedTools`、`supportsParallelTools` | 显式 `tools.webSearch` 实现与 `tools.parallelCalls` |
| `webSearchEnabled`、`applyPatchEnabled` | `tools.webSearch`、`tools.applyPatch` |
| `additionalModelIds` | 每个模型一条精确目录项 |
| `apiKeyMode` | 仅旧 `openai-codex` 兼容；现代 provider 在 Pi 中配置认证和 API/base URL |

旧投影先于全局能力门控，所以不能绕过新的 `false`。删除已移除的 `directImageApiFallback`，并把图片实现设为 `"standalone"`；该旧字段为 true 时生图保持关闭。旧 `compactionMode:"responses-compact"` 会阻止请求，必须改成 `"responses"` 或 `"pi"`；原生压缩现在只使用 `compaction_trigger`。不要编辑历史 checkpoint 绕过保护。

## 组合与故障排查

- **版本冲突：** broker 要求 ABI v2 和完全相同的 runtime 包版本，即使 broker 已缓存也会检查。不兼容时明确失败，不依加载顺序选择语义。
- **重复加载：** 使用同步 `pi.events` 发现服务，按能力认领而非比较模块对象。兼容 core/tools/组合包可共存，分离的物理副本也能协作；不支持与不认识 broker 的旧单体混装。
- **工具状态：** 只管理已安装能力。patch 用 `prepareLoadout.hiddenDeclarations` 隐藏所选 `edit`/`write` 的声明，不移出 active set；Pi 保留恢复/分支选择，codemode 仍可调用，插件不会重启明确禁用的工具。
- **会话释放：** shutdown 关闭发现与资源；实际 Pi runtime 失效会解除跟踪的总线订阅。显示 sink 在请求 I/O 前捕获，观察器只属于当前响应尝试；不要复用旧会话 context。
- **原生 checkpoint：** provider/model/API/profile 不兼容时保留并报错，不伪装成文本摘要。恢复原设置、回到压缩前的分支或开始新会话；仅把生成策略从 responses 改成 pi 不会破坏兼容回放。

`./internal/*` 只用于包间实现接线和测试，不是稳定公共 API。broker 隔离不是沙箱；扩展具有 Pi 进程权限，Standalone 请求也会发送用户内容。会话、身份记录和不透明压缩状态均应按敏感数据处理。

## 开发、参考与许可

从仓库根目录运行：

```bash
pnpm --filter @oai404iao/pi-codex-runtime run check
pnpm run test:codex-composition
pnpm run test:codex-packages
```

这些测试使用模拟 HTTP/loopback 和隔离 tarball 消费者，不验证真实服务权限。规范 schemas 和 provenance 随包提供；`reference/` 是仓库证据，不在 tarball 中：

- [包组合与生命周期（仓库）](https://github.com/oai404iao/omp/blob/main/docs/codex-packages.md)
- [配置参考与迁移证据（仓库）](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-runtime/reference/configuration.md)
- [协议索引与源代码映射（仓库）](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-runtime/reference/source-map.md)
- [LICENSE](LICENSE)、[第三方声明](THIRD_PARTY_NOTICES.md)
