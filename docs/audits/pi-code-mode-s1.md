# 独立 Code Mode S1 验证

日期：2026-09-18。基线：S0 提交 `63c46d972cda4940f5a2fe2617d69493bdf6796b`。
实施分支：`feat/code-mode-s1`。

**结论：授权范围内的 S1 已完成。** 新包可独立本地安装并运行；不代表已发布，
也不代表 S2 的 wait、第三方工具贡献或写入能力已经实现。

## 交付

新包：[pi-code-mode](../../pi-extensions/pi-code-mode/README.md)，初始版本 `0.1.0`。
它不依赖、不安装、不改写任何 `pi-codex-*` 包。

| S1 目标 | 实现 |
| --- | --- |
| 独立包 | 自有入口、flags、命令、授权、runtime、bridge、测试与文档 |
| 跨 provider 基线 | 普通 JSON function `exec({code})`，没有 grammar 或 provider shim |
| mixed | 保留原工具；已有 exec 名称冲突时拒绝覆盖 |
| 明确授权 | 默认没有 exec/Host；UI 确认或显式 `--code-mode-read-root` |
| 少量只读能力 | 自有 tools.read / tools.ls，不调用 Pi 的当前执行对象 |
| 权限边界 | 固定 root，descriptor-anchored traversal、O_NOFOLLOW，拒绝越界/特殊文件 |
| 有界执行 | 一次 exec；32 calls / 4 executing / 16 queued；24 KiB code / 128 KiB frame / 32 KiB text |
| 资源监督 | kernel memory=192 MiB、swap=0、tasks=64、CPU=1；执行期限及完整 cgroup 关闭 |
| 取消及状态 | 禁止迟到分派，逐 delegate signal 传递，等待已开始 I/O 收尾，失败清空 runtime |
| 分发验证 | 真实 npm tarball、锁定离线生产依赖、消费者 SDK、真实 Host 读取 |

配置仅为 CLI flags；不存在暗中的项目配置授权或持久权限。`/code-mode off`
立即使 grant 无效，并关闭已有工作。迟到的确认不能重新开启已关闭的权限。

## 运行环境与执行器

- Linux x64，Node `v24.13.0`，Pi `0.85.1`。
- Host：`rust-v0.145.0`，source
  `25af12f7e61572b0bc18ddb1008be543b91519b0`。
- Executable SHA-256：
  `60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8`。
- 复用 S0 已校验的本地 executable；生产实现还会独立检查大小与 SHA，
  将同一份已验证 bytes 写入私有 runtime snapshot 后执行，不执行可变源路径。
- 不下载 Host、不读取 provider 凭据、不修改系统配置、不要求 sudo。

每个 Host 是独立 user systemd service。运行代码前，核查真实
`memory.max`、`memory.swap.max`、`pids.max`、`cpu.max` 和 MainPID 的 cgroup
成员关系，而不只相信 systemctl 配置值。Host 通过 `env -i` 启动。

每个 exec 都创建独立身份的 35 秒 systemd kill timer，父进程另有 30 秒期限。
Host 最长运行 1 小时，空闲 5 分钟会关闭。timer 不是只保护整个 session 的
一次性启动计时器；每次执行重新建立，完成后拆除。

停止 service 失败或 cgroup 仍有进程时，保留执行 watchdog；不能以
systemd-run proxy 退出代替 Host 停止确认。控制面命令及 proxy 退出等待都有界。
无法确认清理的 runtime 不会静默重用。

## 实际检查结果

### 1. 类型、单元与 Pi 加载：11/11

命令：

```sh
npm run check --workspace @oai404iao/pi-code-mode
```

包括：

- 真实 Pi loader 默认关闭、显式 flag 激活、关闭后保留 direct tools。
- 已有 exec 工具不被替换。
- 等待 UI 确认期间 off，使旧确认失效。
- 文件 byte offset/limit、目录条数限制、绝对/相对越界拒绝。
- 内部/外部 symlink、FIFO 和特殊文件拒绝。
- 授权目录被 rename 并用 symlink 替换后，仍只读取已授权目录对象。
- 并发/队列/调用预算，以及执行未完成前不释放其槽位。
- 已取消的排队 delegate 不进行文件访问。
- 帧碎片、错误协议、过大帧、故障后禁止迟到分派。
- 默认拒绝、错误 Host 资产、撤权与 disposed session。
- Host 停止未确认时不解除 watchdog 的控制面 fixture。

### 2. 真实 Host 与 provider 协议链路：7/7

```sh
CODE_MODE_TEST_HOST=/absolute/path/to/pinned-host \
  npm run test:host --workspace @oai404iao/pi-code-mode
```

| 实验 | 实际结果 |
| --- | --- |
| 完整 runtime/read/store | 两文件 Promise.all、跨成功 exec 的 JSON store、新 JS 环境、路径拒绝通过 |
| 生命周期 | 输出超限、invalidate、取消 CPU loop、拒绝并行 exec、预算失败与后续重建通过 |
| OOM 后恢复 | 有限分配触发 Host 失败，Pi 进程存活，新 runtime 能继续执行 |
| 父进程期限 | 无限循环约 30 秒失败并清理，未无限悬挂 |
| 独立 OS timer | 不使用 Runtime.execute 父期限的底层 probe，约 35 秒被 timer 杀死，systemd Result=`signal` |
| 内核 OOM 证据 | 同一生产 supervisor 下的有限分配，实际 Result=`oom-kill`；不只断言非零退出 |
| OpenAI Completions | 真实 Pi 原生 adapter → fixture SSE → JSON exec → 真实 Host/read → 下一请求携带结果 |
| Anthropic Messages | 同样完整往返；实际声明 code schema，保留 direct bash，模型/provider 未被替换 |

表格部分行为合并在同一个测试中，因此不是每行一个 test。
两个 provider 都只替换 HTTP transport 为严格限定 origin 的内存 fixture；
Pi 原生序列化、流解析、agent loop、extension 和 Host 是真实实现。
**没有发送真实账号请求或验证外部 endpoint 权限。**

### 3. 独立生产 tarball 安装：通过

```sh
npm run test:code-mode-package -- --host /absolute/path/to/pinned-host
```

- npm pack 新包，投影根 lock 的生产/host-peer 闭包。
- 临时消费者执行 `npm ci --offline --omit=dev --ignore-scripts`。
- SDK 从消费者自己的 node_modules 加载，不链接回工作区。
- `node_modules/@oai404iao/` 中只有 pi-code-mode，没有 Codex 包。
- 使用 tarball 内 TypeScript 源码、真实 Pi loader 和真实 Host 完成 fixture
  文件读取，并验证下一模型请求含读取结果；最后执行 off。

被测试 tarball SHA-256：
`c9e019ab00692521e66e8608d3937e9d25bde83bcf8b8c8a2846bc281cb828ff`。
完整 SHA-512、probe hash 和日志保留在安装证据目录。

### 4. 全仓 CI：通过

```sh
npm run ci
```

包括 Pi baseline（含 loader/离线 CLI smoke）、Changesets、架构及其测试、
所有 workspace 类型检查与测试、发布脚本测试、许可证、全部 npm pack 文件清单、
17 组 Codex production tarball/真实 Pi loader 组合。

新包的 opt-in Host 测试和独立安装测试已另外运行；普通 CI 不需要外部 Host
或 user systemd。没有运行 Pi floor/target 双矩阵、其他 Node 版本或远程 CI。

## 实施中发现并修复的问题

- 首轮真实 Host 运行暴露了 systemd 在停止 timer 时回收未启动 service 的
  竞态：不能把“unit not loaded”一律视为停止失败，也不能直接忽略错误。
  现在核查 inactive/failed 状态和 Host cgroup 空状态。
- 评审发现的停止失败仍移除 watchdog、delegate cancel 没传至排队任务、
  迟到确认覆盖 off，均有明确修复及回归 fixture；只读复核确认闭合。
- 首次安装验证错误地假设 npm cache 在 `~/.npm`，离线安装报 ENOTCACHED。
  修正为在重绑定 HOME 前解析实际 npm cache（包括大写 env/config）。
  后续安装仍然是 offline，没有通过联网或工作区软链接绕过失败。
- npm 更新 workspace lock 时移除了五个既有 shrinkwrap integrity。
  原版本/URL 未变，恢复其原有精确 integrity；没有升级这些依赖。

## 留存证据

```text
/home/u/.local/state/agents/tmp/code-mode-s1.3IbKcXjR/
  check-1.log
  host-1.log
  install-1.log       # 首次 cache 解析失败
  install-2.log       # 修正后通过
  ci-1.log

/home/u/.local/state/agents/tmp/code-mode-s1-install-AmJF4D/
  manifest.json
  install.log
  probe.log
  package-lock.json
  *.tgz
```

失败的安装目录及各测试 fixture/runtime 目录均保留，没有清扫其他任务。
这些本机路径不构成项目构建依赖。仓库保存可复现测试，不提交二进制或日志。

## 剩余边界

- 包保留 `private: true` 与 `releaseStatus: blocked`；新增 changeset 用于
  版本记录，不授权发布。没有 push、merge 或 npm publish。
- Linux x64 + 有效 user systemd/cgroup v2 是首版硬要求；没有无监督 fallback。
- `store` 仅由 Host 整体内存约束，没有独立 per-key 配额或持久化。
- 只读 grant 可包含敏感文件；不会继承其他权限、审计或脱敏插件。
- root 是本地目录能力，不复用 SSH/container/SDK override。
- fs I/O 已开始后需收尾；不响应的内核/文件系统可能延迟 settlement。
- runtime snapshot 会保留，约 46 MB/个，需用户手动清理明确的闲置路径。
- 未验证模型真实账号、视觉/音频、安全逃逸、跨平台或未来 Pi API。
- wait/跨轮悬挂 cell、工具贡献协议、写入/进程工具、Codex grammar 和
  hide-bridged 留在 S2–S4，未夹带实现。
