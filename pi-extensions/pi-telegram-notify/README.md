# pi-telegram-notify

Pi 完成任务、最终停止于错误、或通过 `ask_user_question` 等待你的回复时，向 Telegram Bot 发送一条通知。

兼容性: Pi 0.84.2 或更高版本;当前测试基线为 0.84.2。

通知固定使用三行，正文概要会压缩为空白规范化后的前 30 个字符：

```text
项目: /home/me/code/example
状态: 等待回复
概要: 应该使用哪一种认证方案？
```

`状态` 为 `完成`、`错误` 或 `等待回复`。

## 安装

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

- `完成`：Pi 的 agent loop 确实结束，且最后一个 assistant 消息正常结束。
- `错误`：Pi 已决定不再自动重试或自动压缩后继续，且最后一个 assistant 消息是错误。
- `等待回复`：优先订阅
  `@juicesharp/rpiv-ask-user-question` 的 `rpiv:ask-user:prompt` 公开事件；
  同时对 `ask_user_question` / `ask-user-question` 工具名提供回退监听。

“完成/错误”使用一个很小的 Pi 内部 post-run 兼容钩子，是为了避免在
自动重试、上下文压缩并继续执行时过早发送错误通知。若未来 Pi 移除了该
内部钩子，扩展会回退到公开的 `agent_end` 事件。

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
