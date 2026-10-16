# 排查问题

先保留错误原文、包版本、`pi --version` 和加载方式，再检查配置。
不要上传完整会话、`auth.json`、Telegram token 或未脱敏的端点。
本文不要求访问真实模型、发送通知或发布包。

## 扩展没有加载

1. 从仓库使用 `-e` 时确认路径与当前工作目录，并先完成根目录冻结安装。
2. 持久安装使用 `pi list` 检查声明；项目包还需要 Pi 项目信任。
3. 检查是否把 runtime 库误当作扩展，或用了 plain Node 直接导入 TypeScript 包。
4. 检查 Pi 是否至少 1.2.0；本项目没有旧 SDK 回退。

## 工具不存在或不能执行

| 现象 | 先检查 |
| --- | --- |
| Core 有诊断但没有 `apply_patch` | Core 不包含工具实现，同时加载 tools 或完整组合 |
| 搜索/图像入口有依赖却只看到一种能力 | 这是选择性入口的设计；依赖安装不等于全部能力启用 |
| 所有工具都没出现 | `enabled`、模型是否支持/禁用、`autoEnable`、宿主工具选择 |
| 只有一类能力缺失 | 全局 `applyPatch` / `webSearch` / `imageGeneration` 与模型覆盖 |
| Custom patch 或 hosted 搜索报缺引擎 | 确认实际加载兼容引擎，profile 声明不是实现存在的证据 |
| 相同名称的外部工具没有被接管 | 所有权保护会保留非本包工具，不应绕过 |

先查[配置路径](configuration.md)，不要把修改写到能力包名下的新目录。

## 认证、端点或模型被拒绝

使用 Pi 的 `/login` 和 `/model` 核对当前 provider、模型、认证与解析地址。
未知模型保持 Pi 原生行为；相似名称不会继承能力。
端点白名单和明确的 unsupported 响应会限制受影响模式，不会偷偷改账号、换 route 或回退执行。

Fixture 成功只能证明固定输入下的实现行为，不能证明真实账号有 Lite、搜索、图像或 Fast 权限，
也不能核实价格。不要添加另一份环境密钥来试图绕过；先看
[core](../pi-extensions/pi-codex-core/README.md) 与 [tools](../pi-extensions/pi-codex-tools/README.md) 的诊断。

## 混装、重载或版本不一致

Broker 要求 ABI v2 和完全一致的 runtime 包版本；版本冲突显式失败，不按加载顺序选规则。
支持去重的是 broker-enabled 组合，不包括旧不可变单体 tarball。
移除重复或旧安装后重新启动，不要手工改 `node_modules` 或放宽精确依赖。

已移除扩展可能留下进程级补丁。移除安装和配置后完全重启 Pi；`/reload` 不保证撤销旧补丁。
历史 `1.3.0` tarball 中的首发文案不代表当前 checkout 发布状态。

## 旧会话或压缩检查点报错

不透明检查点与 provider/model/API/profile 绑定。历史兼容迁移只接受已审查的匹配，
不是通用跨模型转换器。不要删除 checkpoint，也不要用文字摘要替换 opaque payload。

若诊断要求在原模型 `/compact`，先回到原模型处理。原生 codemode/tool-search 活跃时，
没有 native checkpoint 的压缩可委托 Pi 文本摘要；已有 native checkpoint 时会拒绝重压缩。
此时关闭两项工具后在原模型重试，或在树中回到检查点之前。
详见[兼容性与上下文契约](pi-compatibility.md)。

## 子代理没有立即回复

`spawn_agent` / `followup_task` 接受任务不等于完成；消息由上下文邮箱交付。
先查看状态和邮箱，只有确实无独立工作时才等待。
`send_message` 不会启动空闲代理；后续工作使用 `followup_task`。
取消不回滚文件修改，关闭代理也不是磁盘清理。
完整工具与恢复语义见 [subagent README](../pi-extensions/pi-subagent/README.md)。

## 通知没有出现

- 两类自动通知都抑制 aborted 运行；完成边界是 `agent_settled`，不是每次 `agent_end`。
- Telegram 自动通知只针对 user 触发的运行，custom 运行不发送旧 prompt 摘要。
- 本地通知还受 Kitty 支持、tmux 透传、前台/焦点策略和配置开关影响。
- 先查对应包 README。手动测试 Telegram 会向配置目标发送真实信息，应先确认目标与内容。

## 检查或发布准备失败

离线 consumer 缺失 pnpm store 产物时，先按[贡献指南](../CONTRIBUTING.md)完成根冻结安装，
不要改成在线宽松解析。Matrix 只快照 tracked 工作树文件，新源码应先 stage。
详细日志与测试局限见 [Pi 兼容性](pi-compatibility.md)。

已锁定 npm 版本返回 E404 是待核验，不是允许重新发布或删除锁。
任何发布、标签修复与恢复都按[发布指南](../RELEASING.md)单独授权执行。
