# @oai404iao/pi-telegram-notify

Pi 完成任务、最终停止于错误、或通过 `ask_user_question` 等待你的回复时，向 Telegram Bot 发送一条通知。

兼容性下限：Pi 0.86.1；已验证 0.86.1。

通知使用 Telegram MarkdownV2：标签加粗，项目路径使用行内代码，概要保留
换行和缩进。概要上限从 30 提高到 **3000 UTF-16 单位**（大多数中英文字符
占 1，部分 emoji 占 2），包含截断省略号；优先在靠近上限的段落、行或
词边界截断，不拆开 Unicode 码点。显示示例：

```text
项目: /home/me/code/example
状态: 等待回复

概要:
应该使用哪一种认证方案？
```

`状态` 为 `完成`、`错误` 或 `等待回复`。

路径最多保留 512 UTF-16 单位，确保整条通知处于 Telegram 解析后 4096 字符
限制内。动态内容先截断再转义，避免路径、错误消息或被截断的 Markdown
导致 Telegram 拒收；概要中的原始 Markdown 按字面文本显示，不作为格式执行。
格式遵循 [Telegram MarkdownV2 规则](https://core.telegram.org/bots/api#markdownv2-style)。

## 隐私

每条通知都会将 Pi 当前项目的**绝对工作目录**以及概要文本发送给
Telegram。概要最多保留 3000 UTF-16 单位，比旧版包含更多内容。
截断不等于脱敏；通知仍可能包含文件名、错误信息或其他敏感内容。

## 安装

首个公开版本发布后：

```bash
pi install npm:@oai404iao/pi-telegram-notify
```

本地开发或尚未发布时：

```bash
pi install /absolute/path/to/pi-telegram-notify
```

重启 Pi 或执行 `/reload`。

## 配置

配置文件不写死 `~/.config` 路径。扩展会按下列顺序寻找 Pi 的 agent 目录：

1. `PI_CODING_AGENT_DIR`
2. `$XDG_CONFIG_HOME/pi/agent`（未设置时为 `~/.config/pi/agent`，且目录已存在）
3. `~/.pi/agent`

配置文件路径为：

```text
<PI_CODING_AGENT_DIR>/extensions/pi-telegram-notify/config.json
```

npm 包名使用 `@oai404iao/pi-telegram-notify`，但配置目录继续使用
`pi-telegram-notify`，以保持已有配置兼容。

将 [`config.example.json`](config.example.json) 和
[`config.schema.json`](config.schema.json) 一起复制到该目录；示例中的
`"$schema": "./config.schema.json"` 会让支持 JSON Schema 的编辑器提供字段补全和校验。

```json
{
  "$schema": "./config.schema.json",
  "enabled": true,
  "botToken": "123456789:replace-with-your-bot-token",
  "chatId": "123456789",
  "requestTimeoutMs": 10000
}
```

`chatId` 可以是私聊/群组 ID（群组 ID 通常是负数），也可以是
`@channelusername`。建议将 ID 写为字符串，避免 JSON 数字精度丢失。
`config.json` 含有 Bot token，不要提交到 Git。

## 触发条件

- **subagent 不通知**：带有 `pi-subagent/descriptor` 会话标记的 spawn / fork
  子代理不会发送完成、错误、等待回复或测试通知。发送时动态检查标记，
  兼容启动后才写入标记的子会话；普通无 UI 会话和用户手动 fork 不受影响。
- `完成`：Pi 的 agent loop 确实结束，且当前 active branch 的最后一个
  assistant 消息以 `stop` 或 `length` 结束。
- `错误`：Pi 已决定不再自动重试或自动压缩后继续，且当前 active branch
  的最后一个 assistant 消息以 `error` 结束。
- `等待回复`：优先订阅
  `@juicesharp/rpiv-ask-user-question` 的 `rpiv:ask-user:prompt` 公开事件；
  同时对 `ask_user_question` / `ask-user-question` 工具名提供回退监听。

“完成/错误”只使用 Pi 0.86.1 的公开 `agent_settled` 事件，并从
`ctx.sessionManager.getBranch()` 读取当前 active branch。该事件只在没有
自动重试、自动压缩或排队 continuation 时触发通知。`toolUse` 和
`aborted` assistant 消息会被忽略；`agent_end` 不会触发通知。

通知请求是 best-effort：网络或 Telegram API 失败不会中断 Pi 的任务。

## 命令

| Command | Action |
| --- | --- |
| `/telegram-notify` | 显示配置路径和凭据是否已配置（不会显示 token）。 |
| `/telegram-notify test` | 发送一条测试通知。 |
| `/telegram-notify:test` | 同上。 |

## 开发校验

```bash
npm install
npm run check
```

## License

MIT © 2026 oai404iao. See [LICENSE](LICENSE).
