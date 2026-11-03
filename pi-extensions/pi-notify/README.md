# pi-notify

让 Kitty 在 Pi 完成一轮工作或最终出错时显示本地桌面通知。适用于 Kitty，支持单层 tmux
透传。默认只发本地通知：仅含项目目录名和固定状态，不使用网络服务。
也可选择 Telegram 或两个通道；本扩展自带 Telegram 实现，所有配置都位于自己的目录。

本包已纳入 npm 发布工作区，当前处于首次发布准备（`bootstrap`）阶段，尚未完成 npm 首发。
本地通道无需凭据或配置；不需要加载或保留相邻的其他通知扩展。
要求 Node.js ≥22.19.0、Pi ≥1.2.0；兼容性验证目标为 Pi 1.4.0。

## 开始使用

### npm 安装（待首发后可用）

以下命令供首次 npm 发布完成后使用；当前准备状态不表示包已经可以从 npm 安装：

```bash
pi install npm:@oai404iao/pi-notify
```

安装后重启 Pi 或执行 `/reload`。首发前请使用下面的源码加载方式。
首次 npm 发布由维护者手动完成；`bootstrap` 包不会自动进入受保护发布 workflow，
首发核验和 trusted publisher 配置完成后，仍需单独审阅激活变更。

### 源码加载

在 Kitty 中，仅为本次 Pi 启动加载扩展。将路径替换为你自己的源码目录：

```bash
pi -e /absolute/path/to/omp/pi-extensions/pi-notify
```

向 Pi 提交任务，然后切换到其他桌面窗口。任务最终停止后，通知标题为 `Pi`，正文例如：

```text
my-project: Ready for input
```

普通通知只在 Kitty 未聚焦时请求显示。需要立即验证时，可以主动运行
`/notify-test`；它会请求真实桌面通知，即使 Kitty 当前有焦点。

<a id="加载"></a>

## 持久加载或停用

确认本地行为符合预期后，可自行将本地目录加入 Pi 配置：

```bash
pi install /absolute/path/to/omp/pi-extensions/pi-notify
```

然后重启 Pi 或执行 `/reload`。本地路径直接加载原目录，不会复制源码，移动目录后需更新配置。
不要同时加载其他桌面通知扩展，以免重复提醒。独立的 `pi-telegram-notify` 保持原有行为、
配置和命令，本扩展不会读取其配置或接管它。若同时启用两个扩展的 Telegram 通知，
它们会各自发送；使用本扩展管理 Telegram 时，可自行停用不再需要的旧入口。

仅使用 `pi -e` 试用时，下一次不带该参数启动即可停用。持久安装可通过
`pi remove /absolute/path/to/omp/pi-extensions/pi-notify` 移除声明，或用
`pi config` 禁用资源。首发后通过 npm 安装的声明可用
`pi remove npm:@oai404iao/pi-notify` 移除。扩展本身不会更改 Pi、Kitty 或 tmux 设置。

## 环境与配置

本扩展不注册模型工具。`/notify` 显示当前通道、配置路径和凭据是否存在，不显示凭据值。
所有配置固定放在 `<agent-dir>/extensions/pi-notify/config.json`（示例均为占位值）：

```json
{
  "channel": "both",
  "telegram": {
    "enabled": true,
    "botToken": "REPLACE_WITH_BOT_TOKEN",
    "chatId": "REPLACE_WITH_CHAT_ID",
    "requestTimeoutMs": 10000
  }
}
```

仅使用本地通道时，可不创建配置，或只写 `{ "channel": "local" }`。
已有配置需用户自行整理到上述路径，更名前的加载路径也需自行更新；扩展不自动读取、
复制或搬迁其他扩展的文件，旧 Telegram 配置对本扩展无效。

| `channel` | 行为 |
| --- | --- |
| `local`（默认） | 仅本地 Kitty 通知。 |
| `telegram` | 仅 Telegram，通知用户任务和等待回复。 |
| `both` | 两个通道各按原规则发送，互不依赖成功与否。 |

配置每次发送时重新读取，无需 `/reload`。文件缺失、无法读取、JSON 无效或值不合法时，
通道安全回退到 `local`，绝不自动启用网络发送。agent 目录解析优先级：
`PI_CODING_AGENT_DIR` → 已存在的 XDG Pi agent 目录 → `~/.pi/agent`。

| `telegram` 配置项 | 行为 |
| --- | --- |
| `enabled` | 布尔值，默认 `true`；设为 `false` 仅禁用 Telegram，不影响本地通道。 |
| `botToken` | 必填非空字符串，Telegram bot token。 |
| `chatId` | 必填非空字符串或安全整数，目标会话。 |
| `requestTimeoutMs` | 默认 `10000`；有效范围为 `1000`–`120000` 的整数，否则使用默认值。 |

Telegram 发送必须同时满足通道为 `telegram`/`both`、`telegram.enabled` 为真且两项凭据齐全。
`enabled` 类型不正确时使用默认值；空白凭据按缺失处理。不要把真实凭据提交到仓库。
`/notify test telegram` 会在满足上述条件且不是子代理时发送真实测试消息。
首次加载源码修改需 `/reload` 或重启，后续改配置无需重载。
测试失败会显示通用错误；请核对 bot 凭据、chat 权限和网络，不回显底层 URL 或凭据。

**Telegram 会将绝对工作目录、回答／错误／用户提示词概要或对话框标题发送到 Telegram；
截断不等于脱敏。** 它仅自动通知用户启动的运行，可在普通 RPC/JSON/print 父会话中发送，
等待提醒要求活跃用户运行和 `hasUI`。本地通道仍通知 user/custom 的最终结果，
不发送等待提醒；以下终端条件只约束本地通道：

| 条件 | 说明 |
| --- | --- |
| `ctx.mode === "tui"` | 仅 Pi 交互终端模式；RPC、JSON、print 模式不输出转义序列。 |
| `process.stdout.isTTY` | stdout 必须是终端；重定向输出时保持静默。 |
| 非空 `KITTY_WINDOW_ID` | 由 Kitty 环境提供；仅有 `TERM=xterm-kitty` 不足以启用。 |
| 不是子代理会话 | 全部会话条目中不能含 `pi-subagent/descriptor`。 |

扩展在**每次发送时**重新检查子代理标记，包括测试命令。即使标记在会话启动后才写入，
或不在当前活动分支，也会抑制通知。

### tmux

通过 `TMUX` 或 `TMUX_PANE` 检测 tmux；存在其中任意一个就使用 DCS 透传包装。
可以先只读取当前配置：

```bash
tmux show-options -g allow-passthrough
```

tmux 必须允许透传。确认需要修改后，自行在 tmux 配置中启用：

```tmux
set -g allow-passthrough on
```

`on` 只允许可见 pane 透传。若需要隐藏的 tmux window/pane 也能通知，可自行评估
`all`；这会扩大透传范围，不是扩展自动设置的选项。扩展将标题和正文一起封装，
并将全部内部 ESC 加倍，避免 tmux 截断通知。

点击通知不会切换 tmux window 或 pane，只请求聚焦承载它的 Kitty 窗口。
嵌套 tmux、SSH 和 Zellij 未适配，不保证这些链路中的显示或点击行为。

<a id="行为"></a>

## 通知时机与内容

本地通道仅在公开 `agent_settled` 通知，在自动重试、压缩和排队工作结束后，读取当前活动分支
`getBranch()` 的最后一个 assistant 消息：

| 最终 `stopReason` | 正文 |
| --- | --- |
| `stop`、`length` | `<项目目录名>: Ready for input` |
| `error` | `<项目目录名>: Stopped with an error` |
| `toolUse`、`aborted` 或没有 assistant | 不通知。 |

`length` 表示模型达到输出上限，也显示 `Ready for input`，并不保证用户任务已经完成。
本地通道对用户消息和扩展 `custom` 消息启动的运行使用同一规则；Telegram 仅通知用户任务。

本地通道在以下情况不通知：

- 中间的 `agent_end`，因为其后仍可能自动重试、压缩或继续执行工具。
- 阻塞式问卷或审批弹窗；本地通道不提供“等待回复”提醒，Telegram 通道仍按上述规则发送。
- `agent_settled.aborted === true`，即使取消重试等待后最后一条 assistant 仍为 `error`
  或较早的 `stop`。
- 当前最终 assistant 条目已经成功写入过通知序列。

同一会话内按最终 assistant 条目去重，`session_start` 和 `session_shutdown` 时重置。
同步 stdout 写入失败不会中断 Pi，也不会标记为已通知，因此后续仍可尝试。
写入成功只说明终端收到序列，不代表桌面服务已经显示通知。

Telegram 独立按 assistant 条目去重，自动发送失败不重试、不影响任务或本地通知。
概要最多 3000 UTF-16 单位，路径最多 512，截断不拆分 Unicode 字符后再作 MarkdownV2 转义。

### 焦点与点击

| 用途 | Kitty OSC 99 参数 | 效果 |
| --- | --- | --- |
| 普通通知 | `o=unfocused` | Kitty 有焦点时不弹通知。 |
| 手动测试 | `o=always` | 有焦点时也请求通知。 |
| 点击动作 | `a=focus` | 点击时请求聚焦发送通知的 Kitty 窗口，不会主动抢焦点。 |

实际显示、点击和激活仍由 Kitty、桌面通知服务和合成器决定。在 Wayland/niri 等环境中，
不能把发出聚焦请求视为系统一定允许激活。

### 隐私与编码

通常只发送当前工作目录的短名和上述固定状态；根目录等没有短名时回退到原工作目录。
目录名仍可能透露项目身份，并显示在桌面通知中。通知不包含提示词、模型回答或错误详情，
本地通道不访问网络服务；选用 Telegram 后适用上面的网络隐私披露。

标题和正文使用 base64 编码的 Kitty OSC 99 multipart 消息，共享唯一 ID 并带完成标记，
防止目录名中的分号、换行或终端控制字符被作为控制序列执行。base64 是编码，不是加密。

<a id="手动验证"></a>

## 手动验证与排障

`/notify-test` 无需参数，仅测试本地通道。它请求标题为 `Pi`、正文为
`<项目目录名>: Test notification` 的通知。通道未启用、环境不符合发送条件或同步写入失败时，
Pi 会显示未发送警告。

只在你允许真实桌面提醒时执行：

1. 在 Kitty TUI 中运行 `/notify-test`，确认有焦点时也能显示。
2. 切换到其他窗口，再点击通知，检查是否回到 Kitty。
3. 提交正常任务后离开 Kitty，检查 `o=unfocused` 的实际表现。
4. 使用 tmux 时分别检查所需 pane 可见性下的透传行为。

| 现象 | 检查方法 |
| --- | --- |
| 测试命令不存在 | 确认扩展路径正确、已加载，持久安装后执行过 `/reload`。 |
| 测试提示未发送 | 检查 TUI、终端 stdout、`KITTY_WINDOW_ID` 和子代理标记；不要伪造变量来宣称其他终端受支持。 |
| 普通任务结束没弹窗 | Kitty 是否仍有焦点？是否取消了任务？当前结果是否已去重？先按上述规则核对。 |
| Kitty 正常，tmux 内无通知 | 读取 `allow-passthrough`，核对 pane 是否可见以及环境变量是否传入。 |
| 写入成功但没有桌面弹窗 | 检查 Kitty 和桌面通知服务的设置；扩展无法确认显示结果。 |
| 点击不聚焦或只返回错误的 pane | 聚焦受桌面策略限制，扩展也不选择 tmux pane；不保证嵌套/远程链路。 |

## 开发校验

在维护仓库根目录使用现有锁文件安装工具，然后运行工作区包检查：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @oai404iao/pi-notify run check
```

打包路径或入口变更还须运行 `pnpm run pack:check` 和 `pnpm run license:check`。

检查包括 TypeScript、OSC 99 编码、tmux 透传、去重、取消、模式/子会话隔离和写入失败测试。
测试捕获 stdout、模拟 Telegram 请求，不发送真实桌面或网络通知。真实加载、显示和点击验证需要单独允许；自动测试
通过不能证明桌面送达。

实现依据 [Kitty OSC 99 协议](https://sw.kovidgoyal.net/kitty/desktop-notifications/)，
没有复制上游扩展代码。

<a id="license"></a>

## 许可证

MIT © 2026 oai404iao，见[包级许可证](LICENSE)。
