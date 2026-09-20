# Pi Code Mode S4 验证记录

## 结论与授权边界

用户在 S2 后直接授权 S4；**S4 已完成，S3 未实施**。本阶段实现通用 JSON
模式上的协作式 hide-bridged、动态注册与恢复，不引入 Codex adapters、
grammar 或新的 provider 路由。

- 基线：S2 `cf91c10c`；分支：`feat/code-mode-s4`。
- 修改集中于独立 `pi-code-mode` 包、其验证脚本与文档。
  现有 Codex 扩展没有改动或新增依赖。
- 包仍 private/blocked，附 minor changeset，不手动改版本；
  未推送、合并或发布。
- 严格 only 在原设计中属于“有需求再做”；本阶段没有把协作隐藏冒充 only。
  `only` 配置明确报错，默认继续 mixed。

接口与完整 owner 示例见[README](../../pi-extensions/pi-code-mode/README.md)，
决策已回写[设计方案](../plans/pi-code-mode.md#s4-落地决策先于-s3)。

## 公开 Pi API 的实证边界

查阅本机 Pi extensions/packages/SDK 文档、dynamic-tools 示例，以及实际安装的
Pi `0.85.1` 实现，重点为：

- `dist/core/extensions/types.d.ts`：getAllTools 只有 ToolInfo metadata，
  没有公开执行函数、registration identity、unregister 或全局 visibility lock。
- `dist/core/agent-session.js`：setActiveTools 基于当前 registry 更新 active set；
  registry refresh 在存在 tools allowlist 时会重新加入选中名称；
  reload 重新启用扩展工具。
- `dist/core/extensions/loader.js`：同 extension 内同名 registerTool 会替换定义；
  `sourceInfo.path` 标识 extension 来源，不能区分同源同 metadata 的语义替换。
- `dist/core/extensions/wrapper.js`：新增工具的 native addedToolNames 契约要求
  纯增加；非加法变更由 Pi 的正常工具列表路径处理。
- `pi-agent-core` 的 agent-loop 与 Pi prepareNextTurn：工具快照发生在
  turn_start/context 之前。不能在这些钩子里“补救当前请求的工具列表”。
- 只读核对现有 Codex `tool-activation.ts`：模型/thinking/session hooks
  会合并开启它拥有的工具，不会自动理解新扩展的隐藏要求。

因此采用**显式 owner cooperation**，不是轮询、私有 registry patch、
名称猜测或 provider payload 改写。非协作 writer 仍能改变 active set。

## 交付契约

### 用户侧

`--code-mode-visibility mixed|hide-bridged`；运行中可用
`/code-mode visibility mixed|hide-bridged` 切换，且不授予任何新权限、
不取消已有 cell。reload 重新使用显式 CLI 值。

只有 enabled、未永久 blocked、已精确授权且 owner 同意的贡献才会隐藏 direct
counterpart。原生 read/write/bash 不会因为新增的本地同名能力而被误隐藏；
无 owner binding、未授权或 metadata/source 不匹配时仍保持 direct。

状态展示当前可观测 hidden/reactivated 名称及错误，不宣称全局锁定。

### owner 侧

- 公开 `createCodeModeDirectBinding(pi,{name,sourcePath})` 返回 binding、
  setActive、reconcile、dispose；贡献的可选 `direct` 字段携带 binding。
- 精确匹配 sourceInfo.path，并记录 metadata fingerprint。
  helper 不接受 builtin/sdk 来源，也不允许 exec/wait 自隐藏。
- owner 每次激活意图经 setActive 传递；隐藏期间的新意图保留到释放，
  而不是反复把工具重新加进 active set。
- registerTool 后调用 reconcile，版本化同步 visibility 事件使晚到的 direct
  定义加入协调。贡献语义变化仍通过 S2 refresh/dispose 使旧 cell 失效。
- 每个 lease 只恢复自己移除的名称或 owner 后续明确表达的激活意图，
  使用 live active set，不恢复完整旧快照。
- 释放失败保留 receipt 并可重试；metadata/source 替换后不操作新定义。
  同源、同 metadata 的 execute 替换无法自动识别，owner 必须在语义替换前
  dispose，创建新 handle，再 refresh 匹配的贡献。
- 构造/发现不启动 Host、进程、计时器；lease 协议是同步的。

## 实际检查

本机日志：
`/home/u/.local/state/agents/tmp/code-mode-s4.0FGEfqzs/`。

环境沿用 S0–S2：Pi 0.85.1、Node 24.13.0、Linux x64、systemd user/cgroup v2。
Host `rust-v0.145.0`，SHA-256
`60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8`，
实际路径仍是
`/home/u/.local/state/agents/tmp/code-mode-s0-nlgsDZ/codex-code-mode-host-x86_64-unknown-linux-musl`。

| 命令/日志 | 结果 |
| --- | --- |
| package check，`check-1.log` | 初版 typecheck + 48/48 通过 |
| 完整 `npm run ci`，`ci.log` | 最终 typecheck + **49/49** Code Mode 常规测试；全仓其余检查通过 |
| `CODE_MODE_TEST_HOST=… npm run test:host --workspace @oai404iao/pi-code-mode`，`host-1.log` | **21/21** 真实 Host/内核/Pi 测试，无 skip |
| 对新增动态 loader 后的 `tests/providers.test.ts` 重跑，`providers.log` | **6/6**：四个已有 mixed/hide provider 用例，加两个新动态 loader 用例 |
| `npm run test:code-mode-package -- --host …`，`install-2.log` | 生产 tarball、公开 helper 导入、hide/restore/reload、真实 exec/wait 成功 |
| `npm run changeset:sync` | 无额外依赖方变更 |
| `git diff --check` | 通过 |
| `systemctl --user list-units 'pi-code-mode-*' --all --no-legend` | 无残留单元 |

Host/集成共 **23 个不同用例**均已验证；不是把 21 和 6 相加算成 27。
最终添加的两个用例只对变更所在 provider 文件重跑，未重复全套资源测试。

完整 CI 包括各包 typecheck/tests、architecture、changesets、release scripts、
license/pack 和 **17** 种 Codex production tarball/Pi 组合回归。
Code Mode pack 为 **24 files / 115,216 bytes unpacked / blocked**。
没有引入依赖变更，因此 root lockfile 未改变。

隔离 consumer 位于
`/home/u/.local/state/agents/tmp/code-mode-s1-install-V2eoW4`；
脚本目录前缀保留 S1 命名，实际验证产物为当前 S4。

### 覆盖重点

- 正反加载顺序、mixed/default/未授权/未贡献 owner 均不误隐藏；
  invalid only 不启用 Code Mode。
- 初始 inactive、owner 后续 false 意图、无关工具增删；
  off/mixed/refresh/dispose 的 live-state 恢复。
- 实际 Pi allowlist + registerTool 的重新激活，以及 owner reconcile 的修正。
- 实际 model/thinking 自动启用与 reload 的新 lease；
  旧 handle 不影响替换 runtime。
- 可检测的同名 metadata/source 替换不被旧 lease 误隐藏/激活；
  重复 binding、acquire 失败与 release 重试。
- OpenAI Completions、Anthropic Messages 各自 mixed/hide 下的
  exec→wait→最终结果，**检查每次实际 HTTP fixture payload 的工具定义**。
- 原生 loader 执行中注册 direct 工具并贡献适配后，紧接着的模型请求
  已有 nested catalog、没有该 direct schema；没有伪造 addedToolNames。
- S2 非协作 invocation 导致模型切换 invalidation 超时/poison 后，
  S4 恢复 direct；后续 owner visibility 和 tree 事件不重新隐藏。
- 既有取消、store、usage、写入/进程/OOM/watchdog 回归继续通过。

## 审查发现与失败修正

独立审查发现：原 suppression 条件只看 session.enabled，S2 poison 后仍为
enabled，导致“nested 已不可执行，但 direct 仍被隐藏”。已增加 blocked 状态
检查；未确认清理导致的 invalidation 失败保持 blocked，不能通过下一次协调
再隐藏。真实 Pi/Host 的模型/tree failure 回归覆盖该修复。

释放顺序检查中补充了失败后保留 live receipt 的处理，单元测试验证重试恢复，
而不是在失败前先把 lease 标成已释放。

第一次 S4 隔离安装 probe 的 reload 断言失败，见 `install.log`：
Pi 0.85.1 的 reload 只在保留 UI/action/error binding 时发出 session_start，
原 probe 仅 `bindExtensions({mode:"print"})`，没有保留此类 binding。
最终 probe 加入与 print frontend 一致的 onError binding，并断言无扩展错误；
`install-2.log` 成功。没有用 workspace alias 或跳过 reload 掩盖问题。

## 仍明确不承诺

- 未跑真实 provider 账号/外部服务、跨平台或新的 Pi floor/target matrix；
  本阶段不改变 0.85.1 兼容基线。Provider HTTP 均是本机 fixture，
  但 Pi loader、流解析器、Host、内核限制是真实的。
- 不合作的 late setActiveTools/同 metadata 语义替换无法被公开 API 全局拦截；
  不承诺永久隐藏、历史文本清除、缓存不失效或严格 only。
- 不继承 Pi native hooks 到 nested adapter，不改变本地进程的完整用户权限
  或副作用不可回滚的 S2 边界。
- owner 回调是可信扩展代码，helper 不是恶意扩展隔离机制。
  错误恢复是 best effort，有失败就报告，不宣称任意 owner 都能被强制收尾。
