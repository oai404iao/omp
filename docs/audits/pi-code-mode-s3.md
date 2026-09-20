# Pi Code Mode S3 验证记录

## 结论与范围

用户授权先提交 S4（`bbcba836`），再完整实施 S3；工作分支
`feat/code-mode-s3`。S3 交付可选 Codex 工具贡献、grammar 编解码/流式传输、
跨 provider 历史兼容；没有把 Code Mode 并入 Codex 扩展。
S0–S4 均已落地，严格 only、多模态桥接仍不在本次授权内。

- Code Mode 不依赖任何 Codex 包；Codex owner 也不依赖私有 Code Mode。
- 默认 JSON/mixed，精确授权、独立 Host、S2 cell/store 生命周期不变。
- 包仍 private/blocked，无版本提升、发布锁或 root lockfile 修改。
  Changeset 覆盖 Code Mode/runtime/core/web-search；同步生成依赖消费者项。
- 未推送、合并、发布，也没有使用真实 provider 账号。

接口见 [README](../../pi-extensions/pi-code-mode/README.md)，
落地决策见[设计方案](../plans/pi-code-mode.md#s3-落地决策在-s4-之后)。

## 主要实现与兼容边界

### 通用协议

`json|auto|grammar` 由 CLI/命令选择。auto 要求受支持 API、显式 grammar
metadata；自定义 provider 还需 transport v1 总线返回精确 active
streamSimple 身份，包含 Pi legacy/native Provider 注册。不根据供应商名称
猜测。强制 grammar 不可用时在 Host 启动前拒绝 exec，wait 仍可收尾。

原始输入 canonical 为 `code` 字符串，首行 `// @exec: {...}` 表示控制参数。
验证范围、冲突、未知键和包括 pragma 的 24 KiB 限制；Lark 只包装非空源码，
不是 JS parser 或沙箱。native Pi 和 Codex 使用同一执行器。

grammar 请求通过公开 context hook 投影历史 JSON 控制参数，不改持久化
messages/results/IDs，不重放代码、不丢弃 timeout。已有 raw input 按字节
保留。无法表示的历史使 auto 回 JSON、强制 grammar 报错；不伪造有效参数。
切协议不清空 cells/store，模型切换仍按既有 S2 生命周期失效。

### Codex wire

Runtime 对任意单一 required string 属性的 constrained-sampling tool
做声明/解析/重放，不硬编码 exec。Standard/Lite SSE 与 WS 均使用本次请求
实际声明映射；处理 input delta/done、仅 output-item done、转义字符串的
canonical JSON deltas。Legacy custom apply_patch 保留原始 `{input}` 契约。
call/result wire 类型服从当前声明，跨 JSON/grammar 不保留不兼容 item ID；
WS exact-prefix 检查不满足时发送完整请求。

生产 Pi loader 会将 SDK root alias 前缀应用到 constrained-sampling 子路径，
造成不存在的 `compat.js/api/...` 路径。因此 runtime 使用独立编写的小型 wire
helper，而非 SDK 私有路径绕行。固定 Pi 0.85.1 native helper 只作为测试 oracle；
测试覆盖 Unicode/lone surrogate 分块、quoted property、重复关闭和非法变更。

### 可选 owner 适配

- `codex_core__apply_patch`：exclusive write，复用 owner executor 和 Pi
  mutation queue，不限于 read root；取消在进入队列执行前检查。
  已开始的效果等待结算，不宣称取消就是回滚。
- `codex_web__web_search`：parallel read，仅配置支持的 standalone profile。
  复用 Pi auth/alpha-search，auth I/O 前捕获 identity/history，避免跨轮污染；
  auth 后/请求前/响应后检查 abort。没有隐式账户 fallback。
- 正反/重复加载使用既有 Codex broker claims；贡献需要精确 grant。
  nested policy 可拒绝/脱敏，不继承 Pi direct hooks。
- hosted placeholder、view_image/image_generation 不桥接。
  Codex 未接入 S4 activation lease，不提供 direct binding，不自动隐藏原工具。

## 实际验证

环境：Pi **0.85.1**，Node **24.13.0**，Linux x64，
systemd user manager/cgroup v2。Host `rust-v0.145.0`，source
`25af12f7e61572b0bc18ddb1008be543b91519b0`，SHA-256
`60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8`。
真实执行文件仍位于
`/home/u/.local/state/agents/tmp/code-mode-s0-nlgsDZ/codex-code-mode-host-x86_64-unknown-linux-musl`。

本机日志根目录：
`/home/u/.local/state/agents/tmp/code-mode-s3.iVOqpxa8/`。

| 检查 | 实际结果 |
| --- | --- |
| `npm run ci`，`ci-final.log` | 通过；Code Mode **56/56**、Codex compatibility **308/308**，全仓 typecheck/tests/architecture/changesets/release/license/pack 均通过 |
| CI 的 `test:codex-packages` | **17** 个 production tarball/Pi loader 组合通过，无外部链接/能力包泄漏 |
| `npm run ci:pi-matrix`，`matrix.log` | floor **0.85.1** 和 target **0.85.1** 各自隔离安装并运行完整 CI，通过；两条是同版本的独立验证，不代表两个不同 Pi 版本 |
| `CODE_MODE_TEST_HOST=… npm run test:host -w @oai404iao/pi-code-mode`，`host-final.log` | **33/33**，真实 Host/Pi/内核，无 skip |
| `npm run test:code-mode-package -- --host …`，`install-alone-final.log` | 独立 Code Mode production closure，通过 native grammar、public contribution、S4 hide/restore/reload、exec/wait；无 Codex 包 |
| 上述命令加 `--codex`，`install-codex-final.log` | Code Mode/runtime/core/web tarball closure，通过 Lite grammar、真实 patch、fixture standalone search、exec/wait/reload；无 Code Mode 反向依赖 |
| `npm run changeset:sync` | 生成递归消费者 changeset，不改版本或 exact pins |
| `git diff --cached --check` | 通过 |
| `systemctl --user list-units 'pi-code-mode-*' --all --no-legend` | 无残留单元 |

矩阵详细日志保留在上述日志根目录的 `omp-pi-matrix-results-zSUO2p/`。

最终两个隔离安装目录：

- `/home/u/.local/state/agents/tmp/code-mode-s3-standalone-install-r2tJh9`
- `/home/u/.local/state/agents/tmp/code-mode-s3-codex-install-NtqPPs`

每个目录保留生产 tarball/hash 和独立 consumer；使用 root lock 精确投影、
offline production npm ci，真实 consumer Pi loader，不通过 workspace alias
取巧。Code Mode pack：**25 files / 127,923 bytes unpacked / blocked**。

### 重点用例

- native Responses、native Completions、Codex Standard、Codex Lite 四条真实
  Pi+Host 路径分别验证 JSON → grammar → JSON → Anthropic；
  实际检查 request schemas、历史 controls、store 和 canonical args。
- generic arbitrary property grammar、Standard/Lite SSE/loopback WS continuation、
  JSON downgrade、legacy apply_patch replay、done-only 与 Unicode deltas。
- 未知 custom transport 回 JSON，legacy/native 精确握手；
  强制 grammar 不支持时零 Host 启动、无授权扩大。
- 贡献正常/反序/重复 owner，ungranted 缺席、hosted 不调用占位执行器；
  真实文件 patch、policy 拒绝/脱敏、搜索取消与 cell settlement。
- 排队 patch 被 abort 后不写文件；延迟 auth 跨轮仍保持旧 identity/history，
  auth 期间 abort 后不发送请求。
- S1/S2/S4 read/write/process、取消、跨轮生命周期、store、usage、
  watchdog/OOM 与 visibility/reload 回归全部保留。

## 失败、审查与修正

1. 初次 Codex suite：72 个失败，原因是两个 fake Pi 测试 harness 没有 events。
   改为真实 createEventBus 后通过；未让生产扩展静默忽略缺失 lifecycle API。
2. native Completions fixture 最初检查 `.name`，实际 custom tool 名字在
   `.custom.name`；修正断言后四条 Host/provider 路径全部通过。
3. 首次 Codex 隔离安装失败，日志 `install-codex.log`，暴露上述 Pi Jiti
   subpath alias 问题；使用独立 wire helper 后安装成功，最终两种 closure 再验证。
4. 独立审查发现 native Provider stream 可能漏过握手、search 在 auth await
   后可能采用下一轮元数据。分别补充 active native stream 检查、I/O 前快照，
   并添加实际 Pi/延迟 auth 回归。最终 wire focused review 无阻塞发现。
5. `apply_patch` queue fallback 收窄到模块加载；不将执行失败作为重新执行理由。
   原实现返回未 await 的 queue promise，不能将此描述为已复现的异步双写漏洞。

## 不承诺的范围

没有真实账号/远端 grammar 服务验证；HTTP 为 fixtures、WS 为 loopback，
Pi loader/codec/Host/文件系统/内核是真实的。固定模型 metadata 不是远端服务
能力证明。新 Pi 版本、跨平台和 strict-only 仍未验证/实现。
Host 监督不是用户权限沙箱；写入和外部服务效果不能靠终止自动撤销。
公开总线是可信扩展协作契约，不隔离恶意 provider/owner。
