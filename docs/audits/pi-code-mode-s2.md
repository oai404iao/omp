# Pi Code Mode S2 验证记录

## 结论与范围

S2 完成：独立包提供 JSON exec/wait/terminate、跨轮 cell 生命周期、
版本化扩展贡献/策略协议、单独授权的原子写入与受监督进程适配。
源码位于 `pi-extensions/pi-code-mode/`，不修改任何 Codex 扩展。

基线：S1 `43d701098e4f4738327e979264af00332ad9dd4c`；
开发分支 `feat/code-mode-s2`。包仍 `private: true`、release track `blocked`，
版本不手动递增，附独立 minor changeset。没有发布、推送或合并。
S3 grammar/Codex adapters、S4 tool hiding 不在此次授权范围。

完整接口、安全说明及使用示例见
[包 README](../../pi-extensions/pi-code-mode/README.md)；
阶段决策已回写[原设计](../plans/pi-code-mode.md#s2-落地决策)。

## 固定环境

- Pi SDK/native provider adapters `0.85.1`，Node `24.13.0`，Linux x64。
- systemd user manager、cgroup v2 memory/pids/CPU 实际可用。
- Host `rust-v0.145.0`，源码
  `25af12f7e61572b0bc18ddb1008be543b91519b0`。
- 二进制 SHA-256
  `60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8`，
  46,139,288 bytes；固定资产/许可证沿用 S0/S1。
- 测试使用已验证的本地可执行文件：
  `/home/u/.local/state/agents/tmp/code-mode-s0-nlgsDZ/codex-code-mode-host-x86_64-unknown-linux-musl`。
- 当前 Codex 研究树不是该 Host 的源码版本，未把新版本行为套用于旧二进制。

## 交付与证据

| 交付 | 实现/验收 |
| --- | --- |
| exec/wait | 单 cell、单 observer、opaque ID、观察窗口/总期限分离、分页保留 UTF-8/空白、终态消费与 stale ID |
| terminate | 停止分派、传播 abort、Host 显式 terminate、effects 收尾；未确认停止 poison 并保留 watchdog |
| 跨轮 | 真实 Pi 多 model turn、多用户 prompt；normal agent_end 保留 cell，Esc 独立取消 |
| 会话失效 | 实际 Pi 模型切换、tree navigation、reload；旧 ID/store 失效且不重放 |
| 贡献协议 | 公开 TS 子路径、版本化事件、顺序无关发现、重复/歧义名称拒绝、精确 grants、冻结快照、refresh/dispose |
| 策略与调度 | final args 冻结/校验、before 拒绝/异常/abort、after 脱敏、FIFO writer 屏障、4 active/16 queued |
| 写入 | 默认不暴露；root 内 atomic replace、实际 128 KiB 写入、越界/symlink/超限拒绝 |
| 进程 | 单独授权、gate 后执行、独立 cgroup/watchdog、实际 exit 7、输出超限、超时、拒绝 TERM 的任务收尾 |
| usage | 跨 prompt native totals 恰好一次；取消观察不消费；失败仍携带 receipt；刷新丢弃为 audit-only；迟到 receipt 与 teardown 竞争回归 |
| 特殊控制 | `terminate`/`addedToolNames` 等额外 envelope 字段明确拒绝，不冒充兼容任意 Pi 工具 |
| provider 通用 | OpenAI Completions + Anthropic Messages 原生流解析器，真实 Pi/Host 的 exec→wait→最终回答 |
| 独立安装 | 生产 tarball、离线 npm ci、真实 Pi loader 导入公开贡献子路径、真实 Host；无 Codex 包依赖 |

`store/load` 实测：正常 terminate 保留之前已提交键，当前 pending 键消失。
脚本错误/会话失效采用整体 runtime reset；外部写入与进程不回滚。
若 Host Result 已提交但副作用尚在收尾，取消仍报告 terminated，而不声称
提交可以撤回或整个操作成功。

## 实际执行的检查

日志根目录：
`/home/u/.local/state/agents/tmp/code-mode-s2.vekKr1ii/`。
这些路径是本机保留证据，不是仓库依赖或跨机器可用的构建输入。

1. `npm run check --workspace @oai404iao/pi-code-mode`
   - 中间完成版 `check-3.log`：typecheck + **24/24** 通过。
   - 后续新增 teardown/observer 竞争回归后，完整 CI 内 **25/25** 通过。
2. `CODE_MODE_TEST_HOST=… npm run test:host --workspace @oai404iao/pi-code-mode`
   - `host-3.log`：**18/18**，无 skip，真实 Host/内核/两种 provider fixtures。
   - 之后在已有模型/reload 测试加入真实 tree navigation；仅重跑该变更测试，
     `tree.log`：**1/1** 通过。未把同一案例重复计作第 19 个测试。
3. `npm run test:code-mode-package -- --host …`
   - `install-2.log`：生产隔离安装成功，公开贡献导入与 exec/wait 成功。
   - 独立 consumer：
     `/home/u/.local/state/agents/tmp/code-mode-s1-install-1lM9hK`。
     目录前缀沿用 S1 脚本，不代表运行的是 S1 产物。
4. `npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund`
   - `lock.log`：仅同步新增 pi-ai peer/optional metadata，无依赖升级。
5. `npm run changeset:sync`，随后 **`npm run ci`**
   - `ci.log` 完整通过：各包 typecheck/tests、architecture、changesets、
     release infrastructure、license、pack、Codex 生产安装回归。
   - Code Mode pack：22 files、99,873 bytes unpacked、blocked；
     Codex 安装回归：**17** 种 production tarball/Pi 0.85.1 组合。
6. 最后检查 `systemctl --user list-units 'pi-code-mode-*' --all --no-legend`：
   无残留单元。没有清理其他任务或删除保留工作目录。
   `git diff --check` 与 staged diff 检查均通过。

未运行新的 Pi floor/target matrix：本阶段未变更 Pi 兼容基线；
所有上述 Pi 实测固定为 0.85.1。没有真实 provider 账号、计费请求、
跨平台测试或生产权限插件生态兼容验证。

## 实施中发现并修复的问题

独立审查与回归发现：

- unconfirmed process stop 原先在 scheduler 释放后才 poison，可能先启动
  下一写操作；改为在 scheduler callback 内阻断，回归确认零后继副作用。
- public observation 返回 running 后，live cell 恰好 terminal 会导致结果
  提前消费；改用已交付 snapshot 的 terminal 状态。
- `owner__tool` 分隔符存在碰撞；组件禁止连续/末尾下划线。
- 输出分页 `trimEnd()` 丢空白；去除裁剪、仅在不同 text items 之间插分隔符。
- Host Result 的 effects 收尾期间取消可能变成 completed；
  收尾后复查 signal，保留取消终态。
- 初次 observer 取消未交付 ID，后续 exec 仅报 busy 无法恢复；
  busy 错误现在提供 retained cell ID。
- teardown 不能抢第二 observer 或重复消费 usage；直接原子 take ledger。
  超过五秒仍未收尾时保持 blocked，并在迟到收尾时输出一次 audit receipt；
  stale Pi runtime 仅 stderr fallback，不调用替换会话上下文。

测试开发期间也出现了可见失败，没有把它们计作通过：

- 初始测试适配遗留 ReadBridge 导入及可空断言参数类型错误，已修复。
- 新 fixture 使用超出当前 TS lib 的 `findLast`、错误 `store.get/set`，
  以及“选择同模型不会触发 model_select”的错误前提，均已修正。
- 初版 Esc HTTP fixture 假设 SDK 一定向 mock fetch 传递 abort，测试挂起；
  改为显式结束 fixture response，同时在真实 Pi agent 上发起 abort，
  独立验证 contribution signal 与后续 wait 的失败/usage。
- 初版安装 probe 用裸 Node 导入 node_modules 的 `.ts`，触发
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。公开接口面向 Pi TS 扩展，
  最终 probe 通过实际安装的 Pi loader 加载消费者 `.ts`，验证真实导入路径，
  不是用 workspace alias 或仓库开发依赖掩盖错误。

## 明确限制

- 独立本地 grants 不继承 Pi 原生 hooks/SSH/container overrides；
  贡献回调/策略是可信扩展代码，不是可隔离的不可信插件。
- process grant 是完整当前用户权限。cgroup 仅限制资源/监督本地进程树，
  不能撤销远程请求、外部服务启动的进程或已提交文件。
- 不支持 Windows/macOS、图片/音频/notify、任意 import、通用自动包装、
  grammar、工具隐藏、多活动 cell、durable store、重放恢复。
- 非协作扩展/不可中断 I/O 可延迟 effects 收尾；未知停止状态禁止新 cell。
  五秒 teardown 上限不是强行杀死 Node 内回调。父进程死亡或永不返回的
  扩展无法保证最后 receipt；stderr fallback 不是持久化或 native totals。
- `max_tokens` 是数据字节估计；IPC ceiling 提升只容纳写入 JSON 转义，
  不是放宽 cell text/bridge result 的输出预算。
- Provider 测试是 fixture HTTP + 原生适配器，不是远程服务支持/成本收益证明。
