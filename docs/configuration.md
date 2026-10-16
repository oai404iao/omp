# 配置

OMP 使用 Pi 的宿主配置，同时各扩展保留自己的配置契约。
**Pi 的模型定义、Codex 模型 profile、子代理角色是三种不同对象**，不能把它们放进同一份 `models.json`。

## 先确认配置归属

| 要修改什么 | 位置与说明 |
| --- | --- |
| Pi 加载哪些包、默认模型、工具或 MCP | Pi 的 agent 目录及项目 `.pi/`；遵循宿主信任和优先级规则 |
| Codex 全局开关 | `<codex-agent-dir>/extensions/pi-codex-minimal-tools/config.json` |
| Codex 每模型行为 | 同目录 `models.json`，由 runtime 的 schema/catalog 解释 |
| 子代理角色、模型和工具上限 | [subagent 配置](../pi-extensions/pi-subagent/README.md)，不是 Codex 的 `models.json` |
| Telegram 目标及通知策略 | [telegram-notify 配置](../pi-extensions/pi-telegram-notify/README.md) |
| Kitty/tmux 桌面通知 | [local-notify 配置](../pi-extensions/pi-local-notify/README.md) |

Pi 的个人 `settings.json` 和受信任项目 `.pi/settings.json` 控制资源加载。
这并不意味着每个扩展的自有配置都支持项目覆盖。
宿主配置详见 [Pi Configuration](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/configuration.md)。

## 找到 Codex 实际读取的目录

Runtime 的 `piUserDir()` 按下列顺序解析 `<codex-agent-dir>`：

1. 非空 `PI_CODING_AGENT_DIR`，支持 `~` 展开。
2. 已存在的 XDG 目录：设置了 `XDG_CONFIG_HOME` 时使用其下 `pi/agent`，否则使用 `~/.config/pi/agent`。
3. 回退 `~/.pi/agent`。

为避免宿主与插件目录选择不同，需要自定义路径时显式设置 `PI_CODING_AGENT_DIR`。
Codex 的 `loadSettings(cwd)` 不读取项目覆盖；当前工作目录不是选择这份配置的依据。

无论加载完整组合、core、tools，还是搜索/图像兼容入口，都使用上面的旧共享路径。
不要创建 `extensions/pi-codex-core/` 等平行配置目录。Schema 和默认 catalog 由 runtime
统一维护，入口见 [runtime README](../pi-extensions/pi-codex-runtime/README.md)。

## 修改常用开关

以下是 `config.json` 的有效 JSON 示例，仅关闭图像生成并强制 SSE：

```json
{
  "imageGeneration": false,
  "webSocketEnabled": false
}
```

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后优先于工具和模型 profile 开关 |
| `autoEnable` | `true` | 包工具的自动启用策略，不等于注册表权限或沙箱 |
| `applyPatch` | `true` | 补丁全局开关 |
| `webSearch` | `true` | 搜索全局开关 |
| `imageGeneration` | `true` | 图像生成全局开关，不影响图像输入、历史回放或其他能力 |
| `webSocketEnabled` | `true` | `false` 强制 Responses SSE，同时关闭 WS 预热 |
| `codexRequestExtensions` | `true` | 可选 Codex 身份、请求元数据等增强；不是 Lite/压缩总开关 |
| `fastMode` | `false` | 仅在 profile 和端点支持时启用 Fast |

工具全局关闭会跳过该能力的工具、命令和专用 renderer 注册，并阻止该能力的新任务或请求，
但保留历史回放。模型 profile 的开关独立存在：全局 `true` 不会给未知模型添加能力，
全局 `false` 也不会被旧 `applyPatchEnabled` / `webSearchEnabled` 配置重新打开。

完整字段、图像路径、端点白名单和模型覆盖请查各包 README、runtime schemas 与
[配置参考](../pi-extensions/pi-codex-runtime/reference/configuration.md)。参考文件保留来源记录；
遇到旧示例与当前 schema 不一致时，对照[迁移说明](codex-wire-alignment.md)，不要复制已删除选项。

## 分清独立的模型选项

Standard/Lite 请求格式、可选 Codex 增强、SSE/WS 传输、Pi/native 压缩是独立选择。
端点 `responsesMode` / `transport` 白名单验证真实支持，不负责选择另一套实现。
`codexRequestExtensions:false` 不切换认证、不改端点，也不禁用已选择能力所必需的 Lite
格式、传输信号或原生压缩字段。

维护中的 OpenAI route 是 `openai`，使用 Pi 的 API key 或 ChatGPT OAuth 与解析后的地址。
`openai-codex` 是冻结的兼容路径，不是自动 OAuth 回退。
精确模型 ID 决定 profile；不要用模型家族通配或相近名称推断支持。

## 升级旧配置

| 旧配置 | 处理 |
| --- | --- |
| 图像 `"hosted"` | 显式改成 `"standalone"`，不提供 hosted 图像执行 |
| `directImageApiFallback:true` | 移除，不能作为第二条图像认证或端点路径 |
| `"responses-compact"` | 选择 `"responses"` 或在历史允许时选择 `"pi"` |
| `systemPromptPlacement:"instructions"` | 当前规范是 developer input，旧值会带诊断归一化 |

不要通过清空不透明检查点或修改 provider/model/profile 身份来绕过迁移错误。
详见[协议迁移](codex-wire-alignment.md)和[排查问题](troubleshooting.md)。
