# 快速开始

先选择一个能力，确认能加载，再添加配置和其他扩展。以下源码步骤描述当前 checkout；
要使用 npm 产物，应按对应版本的包 README 操作。

## 1. 准备环境

已安装的 Pi 需要 **1.2.0 或更新版本**。本仓库的精确开发目标为 1.2.0，
不是对所有未来版本已经通过测试的承诺。

```bash
pi --version
node --version
pnpm --version
```

源码工作区要求 Node.js ≥22.19.0、pnpm 12.4.1。在仓库根目录安装锁定依赖：

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

尚未安装 Pi 时，按 [Pi 快速开始](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/quickstart.md)
准备宿主。OMP 不替代 Pi 的安装、模型选择或登录流程。

## 2. 选择加载方式

### 从源码临时试用

在仓库根目录启动一次：

```bash
# 多代理协作
pi -e ./pi-extensions/pi-subagent

# 完整 Codex 组合：与上面的命令分开运行
pi -e ./pi-extensions/pi-codex-minimal-tools

# 只试本地桌面通知
pi -e ./pi-extensions/pi-local-notify
```

`-e` 不会添加持久安装记录；本地路径不复制包，也不替你安装依赖。
这些是不同选择，不要求全部启用。

### 从 npm 安装

先核对目标版本的包说明及其精确依赖是否已发布，再安装所需包。例如：

```bash
pi install npm:@oai404iao/pi-subagent
pi list
```

Pi 默认写入个人安装配置。需要项目级安装时加 `-l`，其声明写入 `.pi/settings.json`，
受 Pi 项目信任控制。临时试 npm 包可使用 `pi -e npm:<包名>@<版本>`。
预发布 Codex 包显式选择 `@next` 或已核实的精确版本，不要以 `latest` 判断稳定性。
仓库 manifest 的版本号不是可直接安装的注册表清单。

### 只组合引擎和工具

```bash
pi -e ./pi-extensions/pi-codex-core -e ./pi-extensions/pi-codex-tools
```

Runtime 是共享库，不单独作为 Pi 扩展加载。Core 不注册补丁、搜索或图像工具。
需要更细选择时阅读[包组合](codex-packages.md)，不要同时加载旧单体版与新能力包。

## 3. 在 Pi 中选择模型并验证

通过 Pi 的 `/login` 配置认证，用 `/model` 选择模型。OMP 不读取另一套密钥来替代
Pi 的认证，也不会根据相近模型名猜测端点能力。

按所选包检查：

| 加载内容 | 检查方法 |
| --- | --- |
| Core 或完整组合 | 按 [core README](../pi-extensions/pi-codex-core/README.md)检查诊断、当前模型 profile 与传输 |
| Tools | 按 [tools README](../pi-extensions/pi-codex-tools/README.md)核对工具注册、全局开关与模型支持 |
| Subagent | 按 [subagent README](../pi-extensions/pi-subagent/README.md)发出一个小型只读任务，再读取消息或最终结果 |
| 通知 | 先阅读所选通知包配置；Telegram 的手动测试会真正外发，桌面通知需要终端支持 |

能加载并不证明账号可访问 Lite、搜索或图像端点。出现问题先看[排查指南](troubleshooting.md)，
不要通过换账号、猜私有端点或删除会话检查点绕过错误。

## 4. 配置或移除

扩展不共用一份万能配置。先看[配置文件位置](configuration.md)，再按包 README 修改。
修改后按对应包的重载要求操作；移除旧进程级补丁必须完全重启。

移除持久 npm 安装时，传入与安装声明一致的 source，例如：

```bash
pi remove npm:@oai404iao/pi-subagent
```

项目级安装加 `-l`；本地路径安装移除对应 source。临时 `-e` 加载只需下次启动不再传入。
本仓库不会自动修改你的 Pi、tmux 或通知配置。

## 下一步

- [配置](configuration.md)：理解宿主配置与扩展开关。
- [Pi 兼容性](pi-compatibility.md)：了解已验证和未验证的范围。
- [贡献指南](../CONTRIBUTING.md)：准备修改源码与运行检查。
