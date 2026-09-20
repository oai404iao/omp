# Pi Code Mode S0 验证记录

日期：2026-09-18。范围：[独立扩展设计](../plans/pi-code-mode.md) 的 S0。
**S0 已完成；没有实现或发布 S1 扩展。**

## 决策

1. **Go：可以继续做独立、通用 JSON 协议的 S1。**
   实际 Pi→外层工具→固定 Host→显式 adapter→返回 Pi 的闭环已运行，
   不依赖现有 Codex 扩展、不访问任何 provider 服务。
2. **S1 初始执行平台限 Linux x64，必须强制有效 OS 内存/时间限制。**
   此次验证了 user systemd/cgroup v2 的可用路线；生产封装、启动失败处理、
   安装诊断和完整生命周期仍属于 S1/S2，不直接把实验 client 发布出去。
   没有对应监督能力的主机明确不支持，不能无监督回退。
3. **No-go：原样分发 Host 后宣称内存安全、跨平台、任意 Pi 工具自动兼容。**
   固定 Host 缺少有效输出预算及可配置 heap 限制；Pi 公开 API 不提供原
   生命周期下的通用工具执行接口。其他 OS 的支持必须先补相应约束并实测。
4. **工具接入采用显式 adapters 和独立授权，不声称继承现有权限插件。**
   首版只读仍需授权；factory 是新本地能力，不冒充当前远程/包装工具。
5. **Codex 同样先使用 JSON/mixed。**
   Grammar、hosted 工具和 active-tools 协作保留在后续阶段。

“支持其他 provider”是模型工具协议维度，不等于“支持所有操作系统”。
这里的 Linux 平台限制不会要求用户使用 Codex provider。

## 实验身份

| 项目 | 实际值 |
| --- | --- |
| OMP 基线 | `3304952c7184c31d6a813de1c4c82e432d797b1a` |
| 实施分支 | `feat/code-mode-s0` |
| Pi | `0.85.1` |
| Node | `v24.13.0` |
| OS/架构 | Linux x64，user systemd + cgroup v2 |
| Host release | `rust-v0.145.0` |
| Host source | `25af12f7e61572b0bc18ddb1008be543b91519b0` |
| 协议 | V1，capabilities `[]` |
| archive SHA-256 | `ac23177956c30cc1f9f180c27bd80f5bb5b76780db55fb94dcc22644d490852e` |
| binary SHA-256 | `60bf16414be5333f09ff082540082304c7352931ef64bdeb170d4c35a82e6ef8` |

完整固定资产信息：[host-lock.json](../../scripts/code-mode-s0/host-lock.json)。
实际使用既有本地缓存，校验后复制到隔离目录运行，没有网络下载、登录、
新增凭据或系统安装。摘要一致性不是供应商签名或可复现构建证明。
较新的 Codex 研究树与该二进制版本严格分开。

## 可复现命令

```sh
npm run test:code-mode-s0 -- --archive /absolute/path/to/pinned-host.tar.gz
```

命令、依赖、隔离、协议和实验辅助代码限制详见
[S0 lab README](../../scripts/code-mode-s0/README.md)。
缺少匹配资产或 OS 监督能力会失败，不跳过安全测试。

## 实测矩阵

最终实验：**23 tests，23 pass，0 fail，0 skipped**。
这是 Node test runner 的断言结果，不是 23 个真实 provider 请求。

| 项目 | 观察及结论 |
| --- | --- |
| 真实 stdio Host | 握手、session/open、exec、回传通过；不兼容 V1 握手被拒绝 |
| JS 隔离 | `process/require/fetch/Deno/console` 不存在；静态/动态 import 拒绝 |
| 状态 | 新 cell 不保留 global；JSON store 跨 cell 存在、跨 session 隔离 |
| 脚本失败 | 返回真实 error；**异常前 store 写入仍提交**，不能宣传事务回滚 |
| 终止状态 | terminate 丢弃该 cell 尚未提交的 store，closed cell 再 wait 报 not found |
| 工具委托 | 真 Host 的 Promise.all 调用抵达显式 adapter；JS 能捕获审批拒绝 |
| wait/terminate | yield 后可 wait；terminate 将取消传递给待完成的 delegate |
| 无限 CPU | while(true) 可由 V8 terminate 终止，随后同 Host 可继续执行 |
| execute cancel | **execution/started 后的 operation/cancel 不取消 initialResponse** |
| wait cancel | 取消 pending wait 只结束观察，cell 继续存在，需要显式 terminate |
| 输出预算 | max_output_tokens=5 仍完整返回 20,000 个字符；Host 没有限制它 |
| IPC 预算 | lab 的 32 KiB 帧限制拒绝 64 KiB 输出；不是上游自动提供的防护 |
| 调用预算 | 有限 32-call fanout 被 bridge 的调用/并发配额拦住，最多 2 个执行 |
| heap 字段 | max_heap_size_bytes 是 V1 未知字段，连接失败；不能发送它来设限制 |
| OS 内存 | 192 MiB、swap=0 的 cgroup 实际触发 `oom-kill`，peak=201,326,592 B |
| OS 时间 | 不调用 terminate 时，2 秒独立 watchdog 终止无限循环，Result=`timeout` |
| Host 故障 | 外部 SIGKILL 导致 pending 请求失败；新 Host 不继承旧 store |
| 故障后分派 | client 进入 failure 后，迟到 delegate/request 不会启动 adapter 副作用 |
| 图片 | Host 返回 input_image 结构；仅协议形状，不是解码或模型看图测试 |
| Pi 元数据 | 真实 getAllTools 不含 execute；ExtensionAPI 没有 executeTool |
| Pi 权限钩子 | direct secret 被 tool_call 拒绝；嵌套 secret 不触发原钩子 |
| Pi 脱敏钩子 | direct 结果被 tool_result 改写；unsafe nested 结果未被改写 |
| 显式策略 | 无授权、拒绝、异常、超时、非法参数均零工具副作用；独立脱敏生效 |
| 审批后参数 | 使用经规范化/校验的冻结参数，执行收到的是同一批准对象 |
| 取消收尾 | 忽略 signal 的模拟执行完成前不释放槽位；迟到审批不启动工具 |
| extension override | direct read 命中扩展 backend，重建 factory 读取的是本地 fixture |
| SDK base override | sourceInfo 仍为 builtin，但 direct backend 与新 local factory 不同 |
| shell 配置 | Pi direct bash 保留 shellCommandPrefix，新 factory 丢失该前缀 |

### 一个关键版本修正

之前只读研究中“cancel 会拒绝初始执行观察”的推断过宽。第一轮实际实验失败，
随后检查固定版本 `code-mode-host/src/lib.rs`：Execute 只在启动前检查取消；
启动后等待 initial response 不再选择取消分支。Wait 则有独立 cancellation
分支。最终测试分别锁定这些语义，不以放宽超时或忽略断言掩盖差异。

旧 Host **完全没有 heap 字段**，而较新 Codex 源码是“字段存在但被置 None”；
两者不能混写成同一个事实。

## 安全与证据边界

真实 Host 的压力测试全部在已核查属性的独立 cgroup 内：192 MiB、swap=0、
64 tasks、100% CPU quota、20 秒总寿命（watchdog 个案 2 秒）、禁止 core dump。
内存测试使用有限分配，而不是无限占用主机内存。只杀本次测试自己创建的服务。
开始前不仅检查 systemd 配置值，还读取实际内核 `memory.max=201326592`、
`memory.swap.max=0`、`pids.max=64`、`cpu.max=100000 100000` 并验证 Host PID
归属。控制面命令有显式超时，外层实验也有 120 秒总期限；异常退出只尝试
终止本轮记录的服务，不扫其他服务。

Pi 进程使用隔离 HOME/Pi/XDG 目录、内存 credentials、禁用资源发现和拒绝网络
的 fetch。读取/执行仅针对新建 fixtures；“secret”是固定测试字符串。
模型响应由内存 fixture 生成，仍经过真实 agent loop 和 extension hooks。

lab bridge 的授权、并发和结果预算是实验实现，**不等于生产执行器安全完成**：

- 没有生产级背压、全面 IPC schema 校验、工具发现、UI、generation 和 reload。
- 元数据不能恢复原工具实例、原 operations 或原权限策略。
- Host 语言隔离不是 OS 文件/网络 sandbox；OS 资源限制也不是工具授权。
- 任意大结果在序列化前的预算、长期 store 配额、复杂 usage/terminate/动态工具
  契约与写工具互斥仍需后续实现。
- 本次 cgroup watchdog 是 Host 服务总寿命，生产需要定义 session/cell 的
  总期限和重置策略；不能直接把实验的 20 秒 Host 寿命当作最终产品语义。

## 留存记录

最终（第三轮）成功实验目录：

```text
/home/u/.local/state/agents/tmp/code-mode-s0-nlgsDZ/
```

其中 manifest 记录源码摘要，覆盖未提交源码，避免只凭 Git 基线误认实验版本。
`tests.tap`、`result.json`、`limits.jsonl`、`memory.jsonl`、
`watchdog.jsonl`、`pi-api.jsonl`、`units.jsonl` 均保留。

第一轮目录 `code-mode-s0-07gQ25` 同样保留：18/20 通过，两个失败分别为 import
错误文案大小写及 execute cancel 行为假设。第二轮修正后 22/22 通过，并补充
独立 watchdog 和崩溃重建实验，目录 `code-mode-s0-1wShlK` 保留。
评审后增加内核级限制核验、故障后拒绝分派、cancel 往返屏障和控制面期限；
第三轮 23/23 通过。没有删除失败日志或使用重试掩盖失败。

这些目录是本机证据，不是仓库依赖；他人运行会生成自己的目录。
仓库保留可执行实验和本报告，不提交二进制、日志、机器配置或真实凭据。

## 仓库检查

以下检查实际通过：

- `npm run check:pi-baseline`（含现有 private-hook loader 与离线 CLI smoke）
- `npm run changeset:check`
- `npm run check:architecture`
- `npm run license:check`
- `git diff --check`

运行后查询本次命名前缀的 user services，未见残留单元。没有新增可发布包，
没有改变已发布包行为或 tarball 文件，因此无需 changeset。完整仓库 CI 与
Pi floor/target 双矩阵没有运行；不将这些定向检查称作完整 CI。

## 未声称验证

未运行真实 OpenAI/Anthropic/Google 请求、其他 provider wire、Codex grammar、
远程账号权限、图片解码/视觉、macOS/Windows、其他 Node/Pi 版本、交互 UI、
npm 发布、生产新包安装矩阵或全仓 CI。S0 不是安全逃逸审计，不证明无未知漏洞。
后续是否开始 S1，以及平台范围扩展，仍需用户授权。
