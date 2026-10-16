# OMP Pi Extensions

OMP 是一组面向 [Pi](https://github.com/earendil-works/pi) 的扩展：按需加入
Codex Responses 引擎、补丁与联网工具、多代理协作，以及 Telegram 或桌面通知。
这是扩展集合与发布工作区，不是独立的代理应用。

从[文档首页](docs/index.md)选择任务，或按[快速开始](docs/quickstart.md)从本地源码试用。
当前支持的 Pi 下限与开发目标都是 **1.2.0**；仓库开发还需要 Node.js ≥22.19.0
和 pnpm 12.4.1。

<a id="packages"></a>

## 选择扩展

所有发布包使用 `@oai404iao/` npm scope，版本独立。

| 需要 | 文档 |
| --- | --- |
| 一次加载 Codex 引擎与三类工具 | [pi-codex-minimal-tools](pi-extensions/pi-codex-minimal-tools/README.md) |
| 只加载 Responses 引擎、传输与压缩 | [pi-codex-core](pi-extensions/pi-codex-core/README.md) |
| 加载补丁、搜索与独立图像生成 | [pi-codex-tools](pi-extensions/pi-codex-tools/README.md) |
| 只启用搜索或图像生成 | [pi-codex-web-search](pi-extensions/pi-codex-web-search/README.md)、[pi-codex-imagegen](pi-extensions/pi-codex-imagegen/README.md) |
| 创建、复用和协调子代理 | [pi-subagent](pi-extensions/pi-subagent/README.md) |
| 接收 Telegram 完成通知 | [pi-telegram-notify](pi-extensions/pi-telegram-notify/README.md) |
| 接收 Kitty 桌面通知，含 tmux 透传 | [pi-local-notify](pi-extensions/pi-local-notify/README.md)，仅限本地，不发布到 npm |
| 开发包间共享配置、身份或 broker 集成 | [pi-codex-runtime](pi-extensions/pi-codex-runtime/README.md)，库，不是扩展 |

Core 本身不提供 `apply_patch`；需要补丁时同时加载 tools，或使用完整组合包。
只选择搜索/图像入口并不会隔离其 tools 依赖。详见 [Codex 包组合](docs/codex-packages.md)。

<a id="local-development"></a>
<a id="local-only-extensions"></a>

## 从源码试用

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pi -e ./pi-extensions/pi-subagent
```

`-e` 只为本次启动加载扩展，不写入 Pi 的安装配置。使用 Codex 工具前，仍需在 Pi
中配置模型和认证；加载扩展不代表账号拥有相应端点权限。
从 npm 安装、组合加载及验证方法见[快速开始](docs/quickstart.md)。

## 升级前先读

- 子代理使用异步多代理 v2 API，旧同步工具与配置不再适用，先读[迁移指南](pi-extensions/pi-subagent/README.md#breaking-migration)。
- 不要把旧的单体 minimal-tools 与新的能力包混装；重复加载去重只适用于支持 broker
  且 runtime 版本一致的组合。
- `external-thinking`、`pi-keep-defaults`、`pi-tree-continue` 和 `pi-code-mode`
  已从仓库与未来产物批次移除。移除旧安装/配置后完全重启 Pi，不能假定 `/reload`
  能撤销旧进程补丁。历史 npm 产物和 release locks 不变。
- checkout 的 manifest 版本不等于 npm 已发布版本，`latest` 也不代表 alpha 已稳定。
  预发布包使用显式 `@next` 或已核实的精确版本；本页不提供实时注册表库存。

<a id="versioning"></a>

## 开发与维护

```bash
pnpm run check
pnpm run ci
```

修改 Pi 兼容性时还需 `pnpm run ci:pi-matrix`。
阅读[贡献指南](CONTRIBUTING.md)了解定向检查与 Changesets，阅读[发布指南](RELEASING.md)
了解受保护发布和恢复流程。八个发布工作区的资格由 `scripts/workspaces.mjs` 管理；
tools 首发及激活已完成，但后续消费者发布仍需单独授权、精确依赖验证与受保护调度。
文档修改不授权安装、变更本机配置、发版或修改不可变发布记录。

<a id="security-and-publication-status"></a>
<a id="license"></a>

## 安全与许可证

扩展以 Pi 进程的操作系统权限运行。子代理、工具开关和包边界都不是沙箱；
会话可能包含敏感数据，通知可能向外部服务发送内容。使用前阅读[安全说明](SECURITY.md)。

项目原创内容采用 [MIT](LICENSE)，copyright 2026 oai404iao。
上游改编内容保留各自条款，见[第三方声明](THIRD_PARTY_NOTICES.md)和 [`LICENSES/`](LICENSES/)。
