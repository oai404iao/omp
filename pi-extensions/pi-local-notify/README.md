# pi-local-notify

让 Kitty 在 Pi 完成一轮工作或最终出错时显示本地桌面通知。适用于 Kitty，支持单层 tmux
透传；通知只含项目目录名和固定状态，不发送提示词、回答或错误详情，不使用网络服务。

这是 `private: true` 的本地扩展，不在 npm 发布工作区内。无需凭据、配置文件或额外运行时依赖。
要求 Node.js ≥22.19.0、Pi ≥1.2.0；兼容性验证目标为 Pi 1.2.0。

## 开始使用

在 Kitty 中，仅为本次 Pi 启动加载扩展。将路径替换为你自己的源码目录：

```bash
pi -e /absolute/path/to/omp/pi-extensions/pi-local-notify
```

向 Pi 提交任务，然后切换到其他桌面窗口。任务最终停止后，通知标题为 `Pi`，正文例如：

```text
my-project: Ready for input
```

普通通知只在 Kitty 未聚焦时请求显示。需要立即验证时，可以主动运行
`/local-notify-test`；它会请求真实桌面通知，即使 Kitty 当前有焦点。

<a id="加载"></a>

## 持久加载或停用

确认本地行为符合预期后，可自行将本地目录加入 Pi 配置：

```bash
pi install /absolute/path/to/omp/pi-extensions/pi-local-notify
```

然后重启 Pi 或执行 `/reload`。本地路径直接加载原目录，不会复制源码，移动目录后需更新配置。
不要同时加载其他桌面通知扩展，以免重复提醒。

仅使用 `pi -e` 试用时，下一次不带该参数启动即可停用。持久安装可通过
`pi remove /absolute/path/to/omp/pi-extensions/pi-local-notify` 移除声明，或用
`pi config` 禁用资源。扩展本身不会更改 Pi、Kitty 或 tmux 设置。

## 环境与配置

扩展没有配置项，也不注册模型工具。发送前必须同时满足：

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

扩展只监听公开 `agent_settled`，在自动重试、压缩和排队工作结束后，读取当前活动分支
`getBranch()` 的最后一个 assistant 消息：

| 最终 `stopReason` | 正文 |
| --- | --- |
| `stop`、`length` | `<项目目录名>: Ready for input` |
| `error` | `<项目目录名>: Stopped with an error` |
| `toolUse`、`aborted` 或没有 assistant | 不通知。 |

`length` 表示模型达到输出上限，也显示 `Ready for input`，并不保证用户任务已经完成。
用户消息和扩展 `custom` 消息启动的运行使用同一规则；这与仅通知用户任务的 Telegram
扩展不同。

以下情况不通知：

- 中间的 `agent_end`，因为其后仍可能自动重试、压缩或继续执行工具。
- 阻塞式问卷或审批弹窗；本扩展不提供“等待回复”提醒。
- `agent_settled.aborted === true`，即使取消重试等待后最后一条 assistant 仍为 `error`
  或较早的 `stop`。
- 当前最终 assistant 条目已经成功写入过通知序列。

同一会话内按最终 assistant 条目去重，`session_start` 和 `session_shutdown` 时重置。
同步 stdout 写入失败不会中断 Pi，也不会标记为已通知，因此后续仍可尝试。
写入成功只说明终端收到序列，不代表桌面服务已经显示通知。

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
也不访问网络服务。

标题和正文使用 base64 编码的 Kitty OSC 99 multipart 消息，共享唯一 ID 并带完成标记，
防止目录名中的分号、换行或终端控制字符被作为控制序列执行。base64 是编码，不是加密。

<a id="手动验证"></a>

## 手动验证与排障

`/local-notify-test` 是唯一命令，无需参数。它请求标题为 `Pi`、正文为
`<项目目录名>: Test notification` 的通知。环境不符合发送条件或同步写入失败时，
Pi 会显示未发送警告。

只在你允许真实桌面提醒时执行：

1. 在 Kitty TUI 中运行 `/local-notify-test`，确认有焦点时也能显示。
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

在维护仓库根目录使用现有锁文件安装工具，然后运行本地包检查：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check:local-notify
```

也可从仓库根目录运行 `pnpm --dir pi-extensions/pi-local-notify run check`。
本包不在发布工作区中，不能用 workspace filter 替代这个检查。

检查包括 TypeScript、OSC 99 编码、tmux 透传、去重、取消、模式/子会话隔离和写入失败测试。
测试捕获 stdout，不发送真实桌面通知。真实加载、显示和点击验证需要单独允许；自动测试
通过不能证明桌面送达。

实现依据 [Kitty OSC 99 协议](https://sw.kovidgoyal.net/kitty/desktop-notifications/)，
没有复制上游扩展代码。

<a id="license"></a>

## 许可证

MIT © 2026 oai404iao，见
[仓库许可证](https://github.com/oai404iao/omp/blob/main/LICENSE)。
