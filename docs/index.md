# OMP 文档

按要完成的任务阅读。初次使用先看[快速开始](quickstart.md)，不必先读发布审计。
本套指南描述当前 checkout；npm 包中的文档对应其不可变发布版本，二者可能不同。

## 开始使用

- [快速开始](quickstart.md)：选择扩展、临时加载、安装与验证。
- [配置](configuration.md)：区分 Pi 配置与扩展配置，找到实际生效的文件。
- [排查问题](troubleshooting.md)：工具缺失、认证、历史会话、子代理与通知问题。
- [安全说明](../SECURITY.md)：进程权限、数据外发、凭证与漏洞报告。

## 选择能力

| 能力 | 使用指南 |
| --- | --- |
| Codex 完整组合 | [minimal-tools](../pi-extensions/pi-codex-minimal-tools/README.md) |
| Responses 引擎与压缩 | [core](../pi-extensions/pi-codex-core/README.md) |
| 补丁、搜索、图像生成 | [tools](../pi-extensions/pi-codex-tools/README.md) |
| 单项兼容入口 | [web-search](../pi-extensions/pi-codex-web-search/README.md)、[imagegen](../pi-extensions/pi-codex-imagegen/README.md) |
| 共享运行时库 | [runtime](../pi-extensions/pi-codex-runtime/README.md) |
| 多代理协作 | [subagent](../pi-extensions/pi-subagent/README.md) |
| Telegram 通知 | [telegram-notify](../pi-extensions/pi-telegram-notify/README.md) |
| 本地桌面通知 | [local-notify](../pi-extensions/pi-local-notify/README.md) |

## 理解行为与兼容性

- [Codex 包组合](codex-packages.md)：依赖、所有权、broker、加载顺序与生命周期。
- [协议对齐与迁移](codex-wire-alignment.md)：请求格式、已移除的执行模式及 Pi 身份边界。
- [Pi 兼容性](pi-compatibility.md)：当前基线、原生 codemode、上下文与验证范围。

## 开发与发布

- [贡献指南](../CONTRIBUTING.md)：环境、定向/完整检查、Changesets 和 PR。
- [发布指南](../RELEASING.md)：版本 PR、定向发布、OIDC、不可变产物与失败恢复。
- [文档组织与写作](documentation.md)：Pi 文档研究依据、本项目的信息分层与维护规则。

## 查协议依据或历史记录

这些资料保留原语言和原路径，不作为当前安装步骤：

| 目录或入口 | 用途 |
| --- | --- |
| [runtime reference 索引](../pi-extensions/pi-codex-runtime/reference/README.md) | 定位协议说明、配置细节、固定上游来源与许可依据 |
| 各包 `reference/`、`provenance/` | 协议快照、来源映射及指纹，不能仅为文风统一而改写 |
| [`audits/`](audits/) | 某次核验的证据、限制和结论，不是实时状态表 |
| [`plans/`](plans/) | 设计/迁移记录，是否完成应对照实现与后续审计 |
| 各包 `CHANGELOG.md` | 已记录的版本历史 |
| 根与各包 `AGENTS.md` | 贡献者/代理维护约束，不是产品使用手册 |

注册表历史见[初始激活审计](audits/codex-bootstrap-activation.md)和
[tools 激活审计](audits/codex-tools-bootstrap-activation.md)。
旧 `1.3.0` minimal-tools tarball 内的 README/notice 仍是首发阶段快照，不能据此判断当前发布资格。
