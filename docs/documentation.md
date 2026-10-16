# 文档组织与写作

本项目参考 **Pi 1.2.0** 的文档组织，而不是复制其整套产品手册。
研究来源为本机安装包 `@earendil-works/pi-coding-agent@1.2.0`，
对应上游入口为 [Pi v1.2.0](https://github.com/earendil-works/pi/tree/v1.2.0/packages/coding-agent)。
这一版本依据不代表上游此后没有更新。

## 借鉴了什么

| Pi 文档及章节 | 写法 | 本项目的落点 |
| --- | --- | --- |
| `README.md` / Getting started | 短定位、最短启动、导向手册，不把所有参考塞首页 | 根 README 只介绍能力、入口、试用和关键限制 |
| `docs/index.md` / Start using、Find reference | 按读者任务分流，不列一串无说明文件名 | [文档首页](index.md)区分使用、能力、兼容、开发和历史证据 |
| `docs/quickstart.md` / 1–4、Next steps | 完成一条真实路径，再链接复杂设置 | [快速开始](quickstart.md)从选包到加载验证，不重新教授整个 Pi |
| `docs/configuration.md` 与 `settings.md` | 文件位置/作用域与字段参考分开 | [配置](configuration.md)解释归属，各包保留自己的详细字段契约 |
| `docs/packages.md` / Install、Select、Scope | 将安装、资源选择、依赖与身份去重分别解释 | [包组合](codex-packages.md)分清安装依赖、能力加载和 broker 去重 |
| `docs/extensions.md` / Lifecycle、Tools、Errors | 示例之后解释并发、权限、生命周期与失败 | 各扩展 README 保留工具、配置、取消、恢复和排障 |
| `docs/sdk.md`、`session-format.md` | 区分最短集成与完整持久化/上下文契约 | [Pi 兼容性](pi-compatibility.md)与[协议迁移](codex-wire-alignment.md)承载深层边界 |
| `docs/security.md` / Project trust | 直接说明信任不是沙箱、权限如何生效 | [安全说明](../SECURITY.md)明确进程权限、外发与不可逆副作用 |

研究完整阅读了以上文件，另阅读 Pi 根 README 与本项目对应指南、包配置/API 实现及测试。
没有把参考文档的每个链接都变成本项目的新章节，也没有照搬不属于 OMP 的 CLI/SDK 产品能力。

## 目录分层

```text
README.md                         项目定位与最短入口
docs/
  index.md                        按任务导航
  quickstart.md                   第一次加载与验证
  configuration.md                配置归属、路径和常用策略
  troubleshooting.md              从症状到检查路径
  codex-packages.md                包组合与生命周期
  codex-wire-alignment.md          协议差异与升级动作
  pi-compatibility.md              基线和上下文/工具契约
  documentation.md                本文：组织依据与写法
  audits/                         保留历史核验证据
  plans/                          保留设计与迁移记录
pi-extensions/<package>/README.md  对应版本的独立使用手册
CONTRIBUTING.md                    开发与验证流程
RELEASING.md                       发布审批、执行和恢复
SECURITY.md                        安全边界与报告方式
```

不搬动原专题路径，避免破坏源码指令和历史链接。各包 README 随 tarball 分发，必须独立说明
自身用途、公共契约和关键限制，不能要求 npm 用户先找到仓库根文档才知道如何使用。

## 编写一篇指南

1. 开头说明解决什么问题、适用对象与前提；能给最短示例时先给示例。
2. 按“选择 → 操作 → 预期结果 → 失败时检查什么”组织，不按实现文件顺序讲故事。
3. 正文使用简体中文，API、字段、路径、模型 ID 和错误标识保持原文。
4. 配置用表格列类型、默认值、作用与限制；JSON 示例是有效 JSON，不放注释或真实凭证。
5. 命令注明工作目录、副作用与授权边界。不能把发布、真实通知、计费模型调用伪装成只读验证。
6. 区分代码策略、固定 fixture、真实端点核验和历史观察；写出检查没有证明什么。
7. 用链接指向细节的权威位置。必要摘要可以重复，配置定义和行为规则不要维护互相矛盾的多份副本。
8. 中文标题下保留已用英文 anchors；新增配置/API 说明须对照实现、schema 与 tests。

## 哪些内容不随文风重写

`AGENTS.md`、`CHANGELOG.md`、许可证/第三方声明、`reference/`、`provenance/`、
`audits/`、`plans/` 与 `release-locks/` 保留各自的约束、原始证据和历史语境。
其中旧叙述可能只对某个阶段成立；当前指南明确区分这些记录，而不是篡改它们来制造一致性。

## 验证文档改动

核对命令、配置字段/默认值、相对路径、标题 anchors 和 JSON 示例，并检查新增页面可从入口到达。
包 README 的变更需要 Changeset；按[贡献指南](../CONTRIBUTING.md)选择检查，
打包检查确认随包文档及资源仍符合 allowlist。仅调整文档不应变更实现、发布资格或版本号。
