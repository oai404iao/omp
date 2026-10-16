# @oai404iao/pi-codex-minimal-tools

一次加载 Pi 的 Codex Responses 引擎与补丁、搜索、图片工具。适合希望继续使用原包名、无需手工组合能力的用户。

本包只做组合，不再内置一份单体实现：

| 依赖 | 提供什么 |
| --- | --- |
| [core](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-core#readme) | Standard/Lite Responses、SSE/WS、预热、原生压缩、诊断和 Fast 命令 |
| [tools](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-tools#readme) | `apply_patch`、`web_search`、`image_generation`，含执行、显示与 `/image-gen` |
| [runtime](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-runtime#readme) | 共享配置、schemas、精确模型目录、身份和会话 broker |

包名、默认扩展工厂和 `@oai404iao/pi-codex-minimal-tools/subagent-inline` 保持支持。要求 Node.js ≥22.19.0；Pi peer 下限和开发验证目标均为 **1.2.0**。

## 安装与开始使用

测试当前仓库，在根目录运行：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pi -e ./pi-extensions/pi-codex-minimal-tools
```

`-e` 只加载一次。希望保存本地包声明时使用：

```bash
pi install /absolute/path/to/omp/pi-extensions/pi-codex-minimal-tools
```

重启 Pi 或 `/reload`。本地目录不会被复制，依赖需要先从仓库根安装；不能只复制组合包目录而丢掉精确工作区依赖。**工作树版本不等于已经发布的 npm 版本**；旧版已发布制品仍保留旧实现，详见 [安装/发布状态（仓库）](https://github.com/oai404iao/omp/blob/main/docs/codex-packages.md)。

进入 Pi 后：

1. `/login openai`，使用 Pi 的 API key 或 ChatGPT OAuth。
2. `/model` 选择模型，再 `/codex-minimal-tools` 确认有效 profile 和能力。
3. 直接提出任务，例如“用补丁修改这段代码”，或在支持搜索/生图的 profile 上要求查资料、画图。

维护中的 provider 是 `openai`。`openai-codex` 仅为弃用兼容；不自动迁移凭据、模型选择或历史会话。非旧 provider 路由遵循 Pi 的 API/base URL，不使用插件 `apiKeyMode` 或 `responses.endpoint` 覆盖。

## 命令与常见操作

| 操作 | 命令/工具 |
| --- | --- |
| 查看实际模型 profile、能力与 active 状态 | `/codex-minimal-tools` |
| 查看配置/目录诊断 | `/codex-minimal-tools:doctor`，或 `/codex-minimal-tools doctor` |
| 查看/修改会话 Fast | `/fast [on\|off\|status]`；不带参数切换 |
| 压缩会话 | Pi `/compact`，遵守当前 profile 与不透明 checkpoint 保护 |
| 后台生成或编辑图片 | `/image-gen <prompt> [@reference.png]` |
| 修改文件、查资料、生成图片 | 由模型调用 `apply_patch`、`web_search`、`image_generation` |
| 查看本地图片 | Pi 原生 `read`，不是新增的图片检查工具 |

Fast 配置默认值只影响新会话；`/fast` 只保存当前会话选择，不写配置。选择支持 resume、reload、分支和 fork/clone；子代理在下次请求（含 followup）跟随主代理当前选择，已发请求不变。没有 Fast profile 的模型不受影响。

patch 声明生效时隐藏所选 Pi `edit`/`write` 的模型声明，但不移出 active set：codemode 仍可调用，历史选择和恢复由 Pi 管理，明确禁用的工具不会被重新启用。

### 模型默认值并不相同

| 精确 profile | 默认值 |
| --- | --- |
| `openai/gpt-6.1-sol` | 显式继承 `openai/gpt-5.6-sol`：Lite、auto WS/SSE、预热、standalone web/image、custom patch、原生压缩和 Fast 可用（priority、2x 配置倍率） |
| `openai/gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna` | Standard SSE、custom patch；远程工具、原生压缩、预热和 Fast 默认关闭 |

这是兼容配置，不是实际端点权限、账号资格或 Fast 定价保证。其他 `openai-codex` Lite profile 单独保留，不从相似名字推断支持。未知或禁用模型继续使用 Pi 原生实现。

### codemode 与 SDK

原生 codemode 可调用 active patch 和 standalone web/image，hosted 搜索只供模型调用。脚本返回结构化结果：patch 为 `{ summary, files }`，搜索为 `{ output, results }`，生图为 `{ path, latestPath?, image }`。本包不启用 codemode、不加载 MCP 服务器；它们仍由 Pi 配置。

启用原生 codemode/tool-search 时，core 跳过推测 WS 预热。没有原生 checkpoint 时可退回 Pi 文本压缩；已有不透明 checkpoint 时保留并拒绝重压缩。禁用两个编排工具后在原模型重试 `/compact`，或导航回 checkpoint 之前。

SDK 公共入口保留：

```typescript
import { createCodexSubagentInlineExtension } from
  "@oai404iao/pi-codex-minimal-tools/subagent-inline";
```

它再导出 runtime 的身份/Fast 继承集成，不加载完整组合包。可传 `parentSessionManager`，`openAIIdentity:false` 关闭 wire 身份集成但不关闭 Fast 继承。接入例子见 [runtime](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-runtime#readme)。

<a id="configuration-and-installation"></a>

## 配置

旧路径保持不变：

```text
<agentDir>/extensions/pi-codex-minimal-tools/config.json
<agentDir>/extensions/pi-codex-minimal-tools/models.json
```

`PI_CODING_AGENT_DIR` 指定 agent 目录；否则插件优先已有的 XDG `pi/agent`，再用 `~/.pi/agent`。**Pi 自己的 `models.json` 定义连接，本插件的 `models.json` 定义行为**。把非旧 provider 的 endpoint 覆盖移到 Pi 的文件，不要新建各能力配置目录。

### 全局偏好

| `config.json` 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `enabled` | `true` | 引擎/能力总开关；诊断/Fast 命令仍可查看状态 |
| `autoEnable` | `true` | 支持模型自动激活工具，尊重 Pi 明确禁用 |
| `applyPatch`、`webSearch`、`imageGeneration` | 各 `true` | 独立能力开关，false 阻止注册、专用显示与命令，不改其他模型行为 |
| `webSocketEnabled` | `true` | false 强制 SSE 并关闭 WS 预热 |
| `fastMode` | `false` | 新会话 Fast 默认值 |
| `codexRequestExtensions` | `true` | 可选 Codex 请求身份与元数据 |
| `endpoint_config` | `[]` | 精确 provider/base URL 的能力白名单 |
| `imageOutputDir` | `".pi/openai-codex-images"` | 图片输出目录；相对工作区根 |
| `imageModel` | `"gpt-image-2"` | 另支持 gpt-image-1.5/gpt-image-1 |
| `glyphStyle` | `"unicode"` | 可改 ascii |
| `deferApplyPatchRendering` | `false` | 使用 Pi 回退渲染而非补丁流式预览 |

例如关闭全部生图与 WS，但保留其他能力：

```json
{
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-runtime/config.schema.json",
  "imageGeneration": false,
  "webSocketEnabled": false
}
```

能力开关在模型/旧配置解析后独立生效，不替换 profile，也不绕过 disabled/unknown 状态。`codexRequestExtensions:false` 只停生成可选身份/元数据；Standard/Lite、工具、传输、原生压缩仍由各自配置决定，协议必需信号和历史回放保留。它不是匿名化或切回 Pi 全套原生 stream 的开关。

### 模型与端点

插件 `models.json` 使用 `{ "version": 1, "models": [...] }`。每条必须有准确 `id`，可用 `extends` 继承；同 ID 深度覆盖，数组整体替换。例如只在一个已知模型上关闭搜索：

```json
{
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-runtime/models.schema.json",
  "version": 1,
  "models": [
    { "id": "openai/gpt-6.1-sol", "tools": { "webSearch": false } }
  ]
}
```

profile 选择 patch 的 function/custom、搜索的 hosted/standalone、图片的 standalone，以及 Responses mode/transport/compaction/Fast。`endpoint_config` 则按 **Pi 认证解析后的** provider/base URL 限制 `responsesMode`、`transport`、`webSearch`、`imageGeneration`、`compaction`。列表省略则继承，`[]` 拒绝；允许值不启用工具、不挑 fallback。

明确 unsupported 只暂时禁用当前会话/端点的对应模式并警告；失败不重发，不改凭据/配置。认证、限流、通用 404/5xx 和连接错误不算能力证据。首个请求解析认证前工具投影可能待定；执行始终检查声明，`/reload` 刷新并清除暂时拒绝。

规范 schemas 只在 runtime 提供：

- [config.schema.json](https://unpkg.com/@oai404iao/pi-codex-runtime/config.schema.json)
- [models.schema.json](https://unpkg.com/@oai404iao/pi-codex-runtime/models.schema.json)
- [全部字段、默认值与旧配置迁移](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-runtime#configuration)

旧版固定版本的 `pi-codex-minimal-tools@1` schema URL 仍指向原发布制品；新配置改用 runtime。当前组合包不镜像 schemas，也不提供旧私有 `src/*` 转发。

## 限制与故障排查

- **只有当前组合实现支持 broker 去重。** 与兼容能力包可共存，要求 ABI v2、相同 runtime 版本；不与旧未参与 broker 的单体保证去重。
- **生图仅 standalone。** 使用 Pi 所选模型的认证/端点；删除 `directImageApiFallback`，旧 hosted 图片 profile 改成 standalone。关闭生图不关闭图片输入和历史回放。
- **原生 checkpoint 不等于文字摘要。** provider/model/API/profile 不兼容时保留并拒绝回放；恢复原设置、回到压缩前或新建会话，不要修改 session JSON。原生压缩仅使用 `compaction_trigger`，旧 `responses-compact` 配置必须迁移。
- **本地/远程执行不是沙箱。** patch 有文件修改权限，搜索会发送有限对话尾部，图片编辑会上传参考图片；输出与会话应按敏感数据保管。abort/会话关闭不能撤销已经开始的服务端生成或文件写入。
- **Lite 和预留端点是不稳定的内部兼容面。** 离线测试不证明真实账号可以使用它们，profile 白名单也不是账号授权。

遇到工具不见或配置错误，先 `/reload`，再运行 doctor，核对实际路径、精确 profile、Pi API/认证、全局/模型开关和 active 工具选择。补丁执行、图片参数与并发边界见 [tools 使用说明](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-tools#readme)。

## 开发与相关资料

本包 `check` 只做 typecheck；行为测试归 runtime/core/tools，跨包测试在根 `tests/codex/`：

```bash
pnpm --filter @oai404iao/pi-codex-minimal-tools run check
pnpm run test:codex-composition
pnpm run check:architecture
pnpm run test:codex-packages
```

安装、生命周期和源码证据是仓库资料，不随本包 tarball 提供：[包组合](https://github.com/oai404iao/omp/blob/main/docs/codex-packages.md)、[配置参考](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-runtime/reference/configuration.md)、[源代码映射](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-runtime/reference/source-map.md)。

<a id="license"></a>

## 许可

组合入口采用 [MIT](LICENSE)。依赖保留各自许可和来源声明，见 [第三方声明](THIRD_PARTY_NOTICES.md)。
