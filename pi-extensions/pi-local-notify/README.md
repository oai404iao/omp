# pi-local-notify

为 **Kitty + tmux** 提供 Pi 本地桌面通知。仅供本地加载，`private: true`，
不加入仓库的 npm 发布工作区；无需凭据、配置文件或额外运行时依赖。

## 加载

先仅在一个新 Pi 会话里试用，不修改全局设置：

```bash
pi -e /home/hisir/Dev/local/omp/pi-extensions/pi-local-notify
```

确认后可以自行持久安装：

```bash
pi install /home/hisir/Dev/local/omp/pi-extensions/pi-local-notify
```

重启 Pi 或执行 `/reload`。不要同时加载其他桌面通知扩展，以免重复通知。
Pi 兼容性下限为 0.99.1，Node.js 下限为 22.19.0。

## 行为

- 使用公开 `agent_settled` 事件，在自动重试、压缩和排队工作结束后通知；
  成功/长度限制显示 `Ready for input`，最终错误显示 `Stopped with an error`。
- 只显示项目目录名和固定状态，不发送提示词、回答或错误详情；通知只交给
  本机终端，不使用网络服务。但目录名仍会显示在桌面通知中。
- 普通通知使用 Kitty OSC 99 的 `o=unfocused`：终端有焦点时不弹通知。
- 点击通知通过 `a=focus` 请求 Kitty 聚焦发送通知的窗口；不是主动抢焦点。
  Wayland/niri 是否允许激活仍由 Kitty、通知服务和合成器决定。
- 仅在 Kitty 的交互 TUI 且 stdout 为终端时发送。RPC、JSON、print、
  输出重定向、其他终端以及带 `pi-subagent/descriptor` 标记的子会话不发送。
- 中间 `agent_end`、以 `aborted` 结束的 assistant 消息、工具继续执行和
  阻塞式问卷/审批弹窗不发送通知。若在重试等待期间取消，Pi 可能保留最后
  一个 `error` 消息，此时仍会显示错误通知；公开 settled 事件不提供取消原因。
- 同一会话内同一个最终 assistant 消息去重。

### tmux

扩展通过 `TMUX` 或 `TMUX_PANE` 检测 tmux，将完整 OSC 99 通知封装为 DCS
透传并转义内部 ESC。tmux 必须允许透传：

```tmux
set -g allow-passthrough on
```

可用 `tmux show-options -g allow-passthrough` 检查。`on` 只允许可见 pane
透传；如果希望隐藏的 tmux window/pane 也能通知，可以自行评估使用 `all`。
扩展不会修改 tmux 配置，也不会在点击时切换到某个 tmux window/pane：
Kitty 聚焦的是承载 tmux 的 Kitty 窗口。嵌套 tmux、SSH 和 Zellij 未适配。

## 手动验证

运行 `/local-notify-test`。测试通知使用 `o=always`，所以 Kitty 当前有焦点
时也会请求通知。切换到其他窗口后点击通知，检查是否返回 Kitty。
通知是否实际显示/激活需要在真实桌面验证；stdout 写入成功不代表桌面送达。

## 开发校验

在仓库根目录安装现有锁定的开发工具，然后运行：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir pi-extensions/pi-local-notify run check
```

测试校验 OSC 99 编码、tmux 透传、去重、模式和子会话隔离，不会发送真实通知。
实现依据 [Kitty OSC 99 协议](https://sw.kovidgoyal.net/kitty/desktop-notifications/)，
没有复制上游扩展代码。

## License

MIT © 2026 oai404iao，见仓库根目录 [LICENSE](../../LICENSE)。
