# @oai404iao/pi-telegram-notify

让 Pi 在用户任务完成、最终失败，或打开交互对话框等待回复时，通过 Telegram Bot
通知你。你可以离开终端，收到通知后再回到 Pi；本扩展不从 Telegram 接收回复或远程控制任务。

要求 Node.js ≥22.19.0、Pi ≥1.2.0；兼容性下限与开发目标均为 Pi 1.2.0。

## 开始使用

安装扩展：

```bash
pi install npm:@oai404iao/pi-telegram-notify
```

在 Pi 中执行 `/reload` 或重启，然后运行 `/telegram-notify` 查看实际配置路径。
在该路径创建 `config.json`，填入你自己的 Bot token 和接收方 ID：

```json
{
  "botToken": "123456789:replace-with-your-bot-token",
  "chatId": "123456789"
}
```

再次运行 `/telegram-notify` 确认凭据显示为 `configured`。准备好发送真实网络消息时，
运行 `/telegram-notify test`。之后正常向 Pi 提交任务即可，无需调用模型工具。

> 通知会把项目的**绝对工作目录**和任务概要发送给 Telegram。概要可能包含回答、
> 错误信息或用户提示词。截断不是脱敏；配置前请先确认这些内容允许离开本机。

<a id="安装"></a>

## 选择安装方式

| 用途 | 命令 |
| --- | --- |
| 持久安装 npm 包 | `pi install npm:@oai404iao/pi-telegram-notify` |
| 仅本次试用 | `pi -e npm:@oai404iao/pi-telegram-notify` |
| 加载本地源码目录 | `pi -e /absolute/path/to/pi-telegram-notify` |
| 持久安装本地目录 | `pi install /absolute/path/to/pi-telegram-notify` |

持久安装后重启 Pi 或 `/reload`。扩展不会自动创建配置，也不会替你创建 Bot、
发现聊天 ID 或管理 Telegram 权限。Pi 包的作用域和资源开关见
[Pi 包文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)。

## 配置

### 找到配置文件

扩展按以下顺序选择 agent 目录；使用 `/telegram-notify` 可以避免猜测路径：

1. 非空的 `PI_CODING_AGENT_DIR`。
2. 已存在的 `$XDG_CONFIG_HOME/pi/agent`；未设置 `XDG_CONFIG_HOME` 时检查 `~/.config/pi/agent`。
3. `~/.pi/agent`。

配置固定放在所选目录下，不读取项目级配置：

```text
<agent-dir>/extensions/pi-telegram-notify/config.json
```

npm 包带有 `@oai404iao/` 作用域，但配置目录仍叫 `pi-telegram-notify`，保持旧配置兼容。
配置在发送通知或查询状态时重新读取；修改此文件不必重新加载扩展。

### 完整示例和默认值

可将包内的 [配置示例](config.example.json) 和 [JSON Schema](config.schema.json)
一起复制到上述配置目录。这样支持 JSON Schema 的编辑器可以校验和补全字段：

```json
{
  "$schema": "./config.schema.json",
  "enabled": true,
  "botToken": "123456789:replace-with-your-bot-token",
  "chatId": "123456789",
  "requestTimeoutMs": 10000
}
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `$schema` | 不需要 | 编辑器校验文件的路径或 URL，不参与发送。 |
| `enabled` | `true` | 是否发送通知；设为 `false` 也会禁用测试发送。 |
| `botToken` | 未配置 | 非空字符串，首尾空白会移除。没有凭据时不发送。 |
| `chatId` | 未配置 | 非空字符串或安全整数；数字在读取后转为字符串。 |
| `requestTimeoutMs` | `10000` | 单次请求超时，单位毫秒；允许 `1000`–`120000` 的整数。 |

`chatId` 可以是私聊 ID、群组 ID（通常为负数）或 `@channelusername`。
建议始终使用字符串，避免 JSON 数字精度丢失。Bot 必须有向目标聊天发送消息的权限。

运行时对无效的 `enabled` 和超时值使用默认值，对空凭据或不安全的数字 ID 视为未配置。
文件缺失时不发送；JSON 解析失败时回退默认设置，并在状态命令的 `diagnostics` 中显示原因。
Schema 比运行时的宽容读取更严格，应以 Schema 校验配置，不要依赖未知字段被忽略。

`config.json` 含凭据，请限制文件读取权限，不要提交到 Git、放进公共示例或分享给他人。
状态命令仅显示凭据是否存在，不显示 token。

## 命令

本扩展不注册模型工具，只有以下 Pi 命令：

| 命令 | 作用 | 是否联网 |
| --- | --- | --- |
| `/telegram-notify` | 显示配置路径、启用状态、凭据存在状态、超时和解析诊断。 | 否 |
| `/telegram-notify test` | 发送“Telegram 通知测试”，并报告成功或失败。 | 是 |
| `/telegram-notify:test` | 与上一个测试命令相同。 | 是 |

未配置或禁用时，测试命令提示配置位置而不发送。带子代理标记的会话也不能发送测试通知。
测试发送是显式操作，不受“仅自动通知用户任务”的限制；请只在允许真实发送时使用。

<a id="触发条件"></a>

## 何时通知

### 用户任务和最终结果

自动通知仅用于 `before_agent_start.messageType === "user"` 的运行，包括用户输入和
`pi.sendUserMessage()`。扩展通过 `pi.sendMessage(..., { triggerTurn: true })`
启动的 `custom` 运行不自动通知，也不会沿用上一条用户提示词。

完成和错误通知读取**当前活动分支** `getBranch()` 的最后一个 assistant 消息，
而不是整个会话文件的最后一条消息：

| 最终 `stopReason` | 通知状态 | 概要来源，按优先级排列 |
| --- | --- | --- |
| `stop` | 完成 | assistant 文本 → 本次用户提示词 → “Pi 任务已完成”。 |
| `length` | 完成 | assistant 文本 → “模型输出达到长度上限”。 |
| `error` | 错误 | `errorMessage` → assistant 文本 → 本次用户提示词 → “Pi 任务失败”。 |
| `toolUse`、`aborted` 或无 assistant | 不发送 | — |

“完成”表示这一轮已经停止，不保证用户目标已经完成；`length` 也会归入完成通知。
只在公开 `agent_settled` 事件发送：此时 Pi 不再自动重试、压缩后续跑或处理排队的
continuation。中间的 `agent_end` 不发送通知。

`agent_settled.aborted === true` 始终抑制完成和错误通知，即使取消重试等待后留下的
最后一条 assistant 是 `error` 或较早的 `stop`。同一个 assistant 条目会去重；
`session_start` 和 `session_shutdown` 会清空去重、用户运行标记和提示词概要。

### 等待你回复

在活跃的用户运行中，且 `ctx.hasUI` 为真时，原生 `ui_prompt_start` 会发送“等待回复”。
支持 `select`、`confirm`、`input`、`editor` 和 `custom` 对话框，包括审批弹窗。
概要使用事件标题；标题为空时使用“等待用户回复”。

Pi 将嵌套或重叠对话框合并成一个等待区间，只在区间开始时通知；`ui_prompt_end`
不发送通知。空闲时打开的对话框、无 UI 会话或尚未真正打开对话框的工具调用不发送等待通知。
普通无 UI 会话仍可发送完成和错误通知。

扩展不读取完整问卷，不监听旧的 `rpiv:ask-user:prompt`，也不按工具名设置延时回退。
因此自定义 UI 若未在标题中提供问题，通知不会附带完整问题内容。Telegram 只是提醒，
实际回答和审批仍在 Pi 中进行。

### 子代理隔离

每次发送前检查全部会话条目 `getEntries()` 中的 `pi-subagent/descriptor` 标记，
覆盖自动通知和测试命令。标记在启动后才写入、或位于当前分支之外，也会抑制通知。
不会仅凭没有 UI 或 `parentSession` 判断子代理；普通 print/RPC 会话和用户手动 fork
不会因此被误判。

## 通知内容与交付

显示示例：

```text
项目: /home/me/code/example
状态: 等待回复

概要:
应该使用哪一种认证方案？
```

使用 Telegram MarkdownV2：标签加粗，路径为行内代码，概要保留换行和缩进。
概要里的原始 Markdown 按字面显示，不作为格式执行；不展示思考文本或非文本内容。

| 内容 | 上限 |
| --- | --- |
| 概要 | 3000 个 UTF-16 单位，包含截断省略号。 |
| 项目路径 | 512 个 UTF-16 单位，路径中的连续空白合并为空格。 |

大多数中英文字符占一个 UTF-16 单位，部分 emoji 占两个。动态内容先截断再转义，
不拆分 Unicode 码点；概要优先在接近上限的段落、行或词边界结束。预算让整条消息
保持在 Telegram 解析后 4096 字符限制内，而不是把转义后的源码长度当成限制。

发送通过 HTTPS Bot API `sendMessage`，关闭网页预览。格式实现见包内
[`src/message.ts`](src/message.ts)，协议格式见
[Telegram MarkdownV2](https://core.telegram.org/bots/api#markdownv2-style)。

自动发送为尽力交付：异步请求不会阻塞 Pi 的 agent loop，网络/API 失败不会中断任务。
每次请求有独立超时，并在结束后清理定时器。没有持久发送队列或自动重发保证；
自动通知的去重也不代表 Telegram 已送达。显式测试会等待请求结束并显示失败原因。

## 隐私

通知发送的是**绝对路径**，不是目录短名。概要可能来自 assistant 回答、模型错误、
本次用户提示词或对话框标题，可能含文件名、代码片段、账号信息及其他敏感内容。
3000 单位的上限比早期 30 字符预览包含更多信息，但仍不构成脱敏。

Telegram 和接收聊天中的成员可能看到这些内容。无需通知时将 `enabled` 设为 `false`，
或在 Pi 中禁用/移除此包；删除凭据前也要考虑已有通知副本。

## 排查通知问题

| 现象 | 检查方法 |
| --- | --- |
| 状态显示 `missing` | 按 `/telegram-notify` 输出的真实路径检查文件；确认 token 非空、数字 ID 为安全整数，最好改为字符串。 |
| 改配置后没生效 | 检查 agent 目录优先级；不要把配置放在 npm 安装目录或项目 `.pi` 下。状态命令会立即重读。 |
| JSON 错误 | 查看状态命令的 `diagnostics`，对照包内 Schema 修复。 |
| 自动通知没来 | 先检查 `enabled`，再核对用户/custom、取消、子代理和焦点无关的 UI 条件；自动发送失败不显示错误。 |
| 需要诊断网络/API | 允许真实发送后运行测试命令；根据显示的超时、HTTP 状态或 Telegram 错误检查网络、凭据和聊天权限。 |
| 收到等待提醒却没有完整问题 | 这是标题提醒，不是问卷转发；回到 Pi 查看完整对话框。 |
| 同一结果没有重发 | assistant 条目已处理会去重；修复配置后可以显式发送测试，不保证自动补发旧结果。 |

## 开发校验

以下命令在维护仓库根目录执行；npm tarball 不包含测试和仓库开发工具：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @oai404iao/pi-telegram-notify run check
```

检查包含 TypeScript 和模拟请求测试，覆盖配置、格式、请求参数、最终结果、UI 等待和子代理隔离。
它们不发送真实 Telegram 消息，也不能证明真实 Bot、网络或接收方权限可用。

<a id="license"></a>

## 许可证

MIT © 2026 oai404iao，见包内 [LICENSE](LICENSE)。
