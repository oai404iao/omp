# Code Mode：工具声明、内置工具接入与 Codex 协商设计

状态：**设计提案，尚未实现**。本轮只合并既有 U0–U4，并分析下一步协议。

- 已本地 squash 合并：`main@972d2c2c`，来源 `feat/code-mode-u0-u4@bb5592d8`。
- 合并后的文件树与已验收的功能分支一致；未推送、发布或改变 Pi baseline。
- 本文的现状以该提交和本地安装的 **Pi 0.85.1** 为准，不推断其他版本。
- 前序：[U0–U4 实施契约](pi-code-mode-u0-u4.md)、
  [实施审计](../audits/pi-code-mode-u0-u4.md)。

## 1. 结论

推荐 **owner 显式提供可执行 adapter，Code Mode 负责授权和编排**。
不要扫描工具名后自动包装，也不要给 Pi `ToolDefinition` 随便增加一个
`supportsCodeMode: true`，就声称能执行、继承权限或隐藏 direct 工具。

必须分开的三种声明：

1. **可嵌套执行**：实际 executor、参数与结果、效果、取消/结算契约。
2. **允许协作隐藏**：实际 direct owner 的注册证据、activation intent、lease。
3. **支持传输格式**：provider 的 JSON/grammar 编码及历史兼容能力。

另外两种决定不属于工具自我声明：

- **用户授权**：是否 grant 某个 adapter，仍由 Code Mode 管理。
- **本次准入**：协议、policy、approval、revision、预算、会话状态是否全部满足。

安装、声明、兼容、授权、隐藏，任何两个都不能互相替代。
这仍是可信扩展间的协作协议，不是对恶意扩展的进程隔离或身份认证系统。

## 2. 已核实的现状

| 事项 | 当前实现 / 边界 |
| --- | --- |
| 工具注册 | `registerCodeModeTools(pi, {id, tools})`；注入真正的 `invoke`，不是工具名映射 |
| 输入 | object schema；顶层空参归一化；`prepare` 后冻结、校验，再执行 policy/approval |
| 输出 | 有界 JSON `{value, usage?}`；`outputSchema` 只是展示契约，不是输出校验器 |
| 副作用 | `read/write/process`；只有 `read + parallel:true` 可并行；其他独占共享 scheduler |
| 授权 | CLI exact `owner__tool` grants；注册不会自动授权 |
| direct | 可选 `direct` binding；无绑定不隐藏；builtin/SDK 来源不能被当前 helper 认领 |
| 生命周期 | cell 捕获 catalog；现有 `CHANGED {version:1}` 导致全会话失效 |
| Codex | core 提供 patch，web 提供 standalone search；hosted/image 仍 direct |
| provider | `transport/v1` 比对实际 `streamSimple` 引用，再结合 model/API metadata 和历史 |
| Pi 元数据 | `getAllTools()` 没有 executor，没有通用的 public `invokeRegisteredTool()` |

主要源码：

- [贡献契约](../../pi-extensions/pi-code-mode/src/contributions.ts)、
  [catalog](../../pi-extensions/pi-code-mode/src/catalog.ts)、
  [调用管线](../../pi-extensions/pi-code-mode/src/bridge.ts)、
  [授权与 session](../../pi-extensions/pi-code-mode/src/session.ts)。
- [direct binding](../../pi-extensions/pi-code-mode/src/direct-binding.ts)、
  [owner factory](../../pi-extensions/pi-code-mode/src/owner-factory.ts)、
  [transport](../../pi-extensions/pi-code-mode/src/protocol.ts)。
- [Codex structural client](../../pi-extensions/pi-codex-runtime/src/code-mode-contributions.ts)、
  [owner client](../../pi-extensions/pi-codex-runtime/src/code-mode-owner.ts)、
  [activation](../../pi-extensions/pi-codex-runtime/src/tool-activation.ts)。

Pi 证据（机器上的只读依赖，不纳入 vendor）：

- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`：
  `ToolDefinition`、`ExtensionAPI`、`ToolInfo`。
- `dist/core/agent-session.js` 的 `getAllTools()` 返回描述、schema、guidelines、
  sourceInfo，不返回 execute。
- `/usr/lib/node_modules/pi/packages/coding-agent/docs/extensions.md`：
  Tool Events、Custom Tools、Remote Execution、Dynamic Tool Loading。
- 对应 `examples/extensions/tool-override.ts` 与 `ssh.ts` 展示了同名工具
  可以换成访问控制、SSH/backend operations，名字不能证明执行位置。

## 3. 先修的协议缺口

这些是下一轮的修复目标，不是声称本轮已经修复。

### 3.1 mandatory 语义不能继续靠 v1 的新增字段

初版 `ac5c2e51` 与当前版本都使用 `discover/v1`，但初版 bridge 不识别
后加的 `approval`。新版 producer 向旧 consumer 提供带该字段的工具，
旧 consumer 可能正常接收并执行，却不履行审批。

**当前 U4 bridge 会检查审批**；问题是跨版本协作没有 feature acknowledgment。
同样不能依赖旧 consumer “应该会忽略不认识的功能但仍安全”。

处理：

- 新增安全要求必须有 consumer 明确确认；缺失即不给可执行 adapter。
- 不能只新增 `requires` 字段再发给旧 `discover/v1`：旧版也会忽略它。
- mandatory policy 不能因“不兼容”而静默退出，否则其他工具失去保护。
- 新 ABI 与旧 ABI 的迁移规则见第 7 节。

### 3.2 owner replacement 的失败要可重试

当前 Codex owner client 先清空旧 control、更新 factory，然后 `old.dispose()`。
如果 dispose 抛错，旧 handle 丢失，新 factory 已记录，下一次可能既不重试
释放，也不创建新 control。

应引入小型、同步的转换状态：

```text
active(old)
  → transitioning（禁止重入 acquisition；保留 old receipt）
  → old.dispose 成功
  → 创建/校验 new control
  → active(new)

dispose/create 失败 → 可诊断、可重试；不得假装已恢复或已接管
```

注意 disposal 会触发 visibility 通知，必须防同步重入。
旧 receipt 成功释放之前，不提交“旧 owner 已消失”的状态。

### 3.3 factory 预算应该统计 live controls

当前 factory 的 Set 直到整体 shutdown 才清空；单个 control.dispose 不移除
记录。连续 create/dispose 64 次可能耗尽容量，即使没有活跃 control。

应在**成功 dispose 后**移出 live 集合；失败的 receipt 保留以便重试。
factory 关闭期间禁止新 acquisition，不能被通知回调重新补入 controls。

上述两种 owner failure 路径经独立 review 的内存 fixture 复现。
常规正反加载和 hide/off 测试通过，不代表这两个异常路径已覆盖。

### 3.4 所有 owner 使用一致的证据

Codex 已比对自己注册的唯一 schema 引用及 source/fingerprint。
Code Mode 自己的 `exec`/`wait` 部分检查仍主要依赖 description，应该统一加强。

协作证据建议包括：

- producer instance、registration generation；
- owner 保存的实际 definition/schema 引用；
- Pi public sourceInfo 和必要的 metadata fingerprint。

Pi 0.85.1 没有给扩展暴露不变的 registration token。自己生成的 generation
不是 Pi 的身份认证凭证；相同来源、相同对象/元数据的恶意伪装不在安全承诺内。
owner 主动替换定义必须明确 dispose/re-register。未来 Pi 若 clone metadata，
应失去隐藏资格而非按名字退化认领。

## 4. 其他扩展现在如何声明

### 4.1 推荐：一个业务 executor，两个入口

```text
                  ┌─ Pi direct ToolDefinition.execute
owner executor ───┤
                  └─ Code Mode adapter.invoke
```

共享：业务校验、owner 自身的权限检查、backend 选择、取消与资源结算。
不共享/不伪装：Pi 的 tool_call/tool_result 分发器、UI renderer、agent 控制结果。

下面使用**当前已有 API**；适合已安装本地 `pi-code-mode` 的扩展。
例子无审批需求，不包含文件、网络或其他副作用：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerCodeModeTools } from "@oai404iao/pi-code-mode/contributions";

const parameters = Type.Object(
  { name: Type.String() },
  { additionalProperties: false },
);
const values = new Map([["sample", "example"]]);

async function lookup(input: { name: string }, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return { name: input.name, value: values.get(input.name) ?? null };
}

export default function inventory(pi: ExtensionAPI) {
  pi.registerTool({
    name: "inventory_lookup",
    label: "Inventory lookup",
    description: "Look up an item in the example catalog.",
    parameters,
    async execute(_id, input, signal) {
      const value = await lookup(input, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        details: value,
      };
    },
  });

  const registration = registerCodeModeTools(pi, {
    id: "inventory",
    tools: [{
      name: "lookup",
      description: "Look up an item in the example catalog.",
      parameters,
      effect: "read",
      parallel: true,
      outputSchema: Type.Object({
        name: Type.String(),
        value: Type.Union([Type.String(), Type.Null()]),
      }),
      async invoke(input, ctx) {
        return { value: await lookup(input as { name: string }, ctx.signal) };
      },
    }],
  });
  pi.on("session_shutdown", () => registration.dispose());
}
```

用户显式 grant `--code-mode-tools inventory__lookup` 后，才出现
`tools.inventory__lookup({name:"sample"})`。这里没有 direct binding，因此
`inventory_lookup` 仍 direct，即使 Code Mode 配置为 hide-bridged。

`outputSchema` 未使用并不放宽 runtime 的有限 JSON/字节预算；也不能将
例子的 `as` 视为验证，实际参数校验由两条调用管线及 owner 业务检查完成。

### 4.2 声明最少需要什么

| 项目 | owner 的义务 |
| --- | --- |
| 身份 | 稳定 namespace/tool ID；不能只提供一个可能同名的 direct 名称 |
| 参数 | 严格 schema；如有旧格式，提供纯 `prepare`，不做 I/O/审批 |
| executor | 真正函数引用，使用共享业务实现；不得偷偷重新 resolve 同名当前工具 |
| effect | 如实声明，未知/复合副作用按 exclusive；`parallel:true` 不是 Pi executionMode 的机械复制 |
| 结果 | 明确映射成 JSON；不要默认把整个 `details` 当可向模型披露的数据 |
| usage | 嵌套模型费用完整交付一次；不要和 direct/native tool_result 双重计费 |
| cancellation | 响应 signal；Promise 结算必须如实代表调用效果结算，不能只 race 超时就丢后台任务 |
| guard | 必要保护放在共享 executor 或显式 Code Mode policy/approval，不能只留在 Pi hooks |
| lifecycle | refresh/dispose；不得保留旧 session ctx；backend/profile 变化必须更新 revision |

有强制审批时，当前 U4 可以用 `approval:"user"` 或注册自定义 provider。
这不让 direct 入口自动获得审批；direct 仍须走其 owner/Pi 的原保护。
面向未知版本 consumer 分发时，应先完成第 3、7 节的兼容门禁。

建议公开一种“effects unconfirmed”的稳定报错契约，供第三方在不能确认
本地任务已停止时阻塞会话。目前内部 `UnsettledEffect` 的类身份不适合作为
多份安装之间的公共 ABI。新 helper 可以构造 Error，但跨模块识别应使用
经校验的结构化 code/version，而不是错误文本或依赖单一 class identity。

### 4.3 简化 authoring，但不修改 Pi 的类型假装原生支持

后续可提供 `registerCodeModeCapableTool()` **helper（提议，不是现有 API）**：

- 接受一个正常 Pi definition，加一个独立 `codeMode` sidecar；
- helper 自己消费 sidecar，向 `pi.registerTool()` 只传合法 Pi 字段；
- 复用 description/schema/prepare，nested 的 result mapping、effect、
  mandatory features 必须明确；
- 可以由同一 helper 创建 owner control，减少忘记同步 activation 的风险；
- 未安装 Code Mode 时照常注册 direct，且不启动任何 Host。

不能简单 `adapter.invoke = definition.execute`：
execute 的参数、结果、hooks、进度、控制流和取消上下文并不等价。
不要注册第二套权限模型，也不要全局 monkey-patch `registerTool`。

### 4.4 可选集成不应强制安装 private runtime

当前 `/contributions` helper 可供本地已安装包使用，但 Code Mode 仍 private。
其他可独立分发扩展不应硬依赖它，也不应 import Codex `internal/*`。

短期：稳定 protocol 文档 + 小型 structural client + 共用 conformance fixtures；
现有 Codex 已使用这条方向。未发现 consumer 时无操作，direct 行为不变。

当有独立外部 adopter 时，再评估单独的 `pi-code-mode-contracts` 小包：
仅 wire types/纯注册 helpers/验证，不包含 Host、provider、文件或进程执行器，
不自动注册任何 Pi tool。发布这个包属于另一次明确授权，不在本轮新增。
不为了消除几十行结构契约，马上拆出一个新的“大型通用工具平台”。

## 5. Pi 内置工具：三种不同的事情

### 5.1 当前 local tools，不是“接管 Pi 内置 tools”

现有 [builtin-tools.ts](../../pi-extensions/pi-code-mode/src/builtin-tools.ts)
里的 `tools.read/ls/write/bash` 是 Code Mode 自己的已授权实现：

- read 的 offset 是 **字节**；不是 Pi read 的 **1-based 行号**；
- read/ls/write 有 root 与 symlink 约束；
- bash 有自己的干净环境、systemd 监督和输出预算；
- 不继承 Pi read 的图片输出、shell startup、SSH operations 或原 hooks。

保持现有名字以免破坏调用历史，但文档与模型 prompt 必须明确实现身份。
不能因为名字相同就隐藏 Pi builtin `read/bash`。

### 5.2 显式使用 Pi builtin factories 的 adapter

Pi 提供 `createReadTool/createEditTool/createWriteTool/createBashTool` 等工厂。
我们可以做一个**显式 opt-in、明确语义**的 adapter，例如 `pi_builtin__grep`。
这代表“新建的、指定 operations 的 Pi builtin 实现”，不是“当前注册实例”。

| 工具 | 接入条件 / 首批建议 |
| --- | --- |
| ls/find/grep | 适合优先适配文本/目录查询；保持路径、分页、truncation 元数据，禁止无界结果 |
| read | 只接受已声明的文本模式；不能 silently 丢图片，也不能把行号当字节偏移 |
| write/edit | 单独 grant；完整 mutation window 进入 Pi `withFileMutationQueue`，不能只锁最终 write |
| bash/powershell | owner 显式选择 operations/env/timeout/进程管理；不能声称继承 Code Mode cgroup 监督 |

factory 的缺省本地实现可能有超出 Code Mode root 的权限。
应使用独立 exact grant 和清楚的 authority 描述，不能借 read-root grant 偷扩权。
authority 描述是披露，不是由一个字符串自动提供的 sandbox。

首批只做适配文档/fixture；是否新增这些实际工具，应逐个授权，不一次包办所有 builtin。

### 5.3 当前已安装的 override：必须由实际 owner 参与

用户可能把 `read/bash` 换成 SSH、容器、远程工作区或审计实现。
`getAllTools()` 只能看元数据，无法拿到那条受保护的 execute 管线。

因此：

1. 原 owner 从相同 backend executor/operations 提供 nested adapter；
2. 未声明时保持 direct，明确报告“未提供可执行 adapter”；
3. 不因无法调用远程 override 就 fallback 到本机 builtin；
4. 若提供专门的 builtin-owner 扩展，必须是用户明确启用、注册前检测冲突，
   不能无声覆盖已有 SSH/sandbox owner；
5. 只有该扩展真正拥有 direct registration，才考虑协作隐藏。现有 helper
   禁止认领 builtin/SDK source 的规则保持不变。

长期若需要“调用当前工具且自动继承所有 Pi hooks”，应向 Pi 提交正式 API
提案：注册代次 token、可取消调用、preflight/结果 hooks 的语义、嵌套计费、
递归/控制流限制。不能现在使用私有 registry 或伪造 tool events 代替它。
例如 `pi.invokeRegisteredTool` 只是需求名，**当前没有这个公共 API**。

## 6. 哪些其他扩展暂时不该包装

| 类型 / 本仓库例子 | 建议 |
| --- | --- |
| 纯查询、结构化 API、文本数据转换 | 首批 adapter；JSON、预算、signal 明确即可 |
| `pi-subagent.list_agents` | 可作为后续查询 adapter；从 coordinator 获取受限结构数据，不解析显示文本 |
| subagent / fork / followup / wait_agent | 默认保留 direct；涉及子会话、durable mailbox、消费 receipt、上下文/费用及生命周期，不是普通“read” |
| 动态工具 loader | 保留 direct；Pi 用真实工具执行记录 additive activation/addedToolNames，nested 调用不能冒充该流程 |
| ask-user-question 等交互 UI | 默认 direct；Code Mode approval 只用于授权，不是通用问答工具替代品 |
| view_image / image_generation / 音视频 | 当前数据通道 JSON/text-only，不接受静默删媒体；等待单独的多模态设计 |
| `pi-tree-continue`、切模型/重载/compact | agent/session 控制，不进入普通 data adapter |
| external-thinking、keep-defaults、通知/展示 hooks | 本身不一定有可调用的数据工具；无须为了 Code Mode 强行造 tool |
| permission/redaction 扩展 | 提供显式 policy/approval，或抽取共享 guard；仅注册 Pi hook 不等于保护 nested calls |

任何未来 subagent 适配都要先证明：child 不继承比原设计更多的 grants、不递归
触发 exec、并发/深度预算不被放大、usage/完成 receipt 不重复、不把 parent
控制结果吞成 JSON。业务上的发送、消费、启动、终止通常不是并行 read。

## 7. 下一版协商协议

### 7.1 建议采用 v2 控制面，沿用 v1 的安全 data-plane 形状

独立 `@oai404iao/pi-code-mode:discover/v2`；不把强制语义偷偷塞回 v1。
继续使用同进程、同步、无 I/O 的事件发现，不新建网络 broker 或全局 singleton。

示意类型（提议，不是可以直接 import 的现有 API）：

```ts
interface ConsumerHello {
  protocol: 2;
  instanceId: string;
  generation: number;
  features: readonly string[];
  limits: { resultBytes: number; callsPerCell: number; maxCells: number };
}

interface Registration {
  owner: string;
  instanceId: string;
  revision: number;
  requires: readonly string[];
}

interface DiscoveryV2 {
  hello: ConsumerHello;
  offer(value: {
    registration: Registration;
    availability: { state: "available" | "unavailable"; reason?: string };
    tools: readonly DataToolAdapter[];
  }): {
    status: "compatible" | "incompatible" | "unavailable" | "conflict";
    missing?: readonly string[];
  };
}
```

`DataToolAdapter` 沿用现有 name/parameters/prepare/effect/parallel/invoke、
output hints、usage、approval/direct 元数据，并增加 tool 级 `requires`、
availability；同一 owner 可以只有部分工具在当前 profile 下可用。
不兼容的 offer 仅提供状态/缺失列表，不给旧 consumer 暴露可执行 closure。
policy、approval、observer 分别有对应的记录类型，不能伪装成普通工具。

**compatible receipt 不是 grant、审批通过或执行准入**。
consumer 最终仍要收齐并验证整个 catalog、mandatory policy、预算、grants。
任何扩展都不能通过“声明了某权限”替用户授权。

示例 feature IDs：

```text
json-result/1
prepared-frozen-args/1
abort-settlement/1
exclusive-scheduler/1
usage-accounting/1
approval/1
direct-lease/1
observer-receipt/1
```

共同 baseline 可以隐含于 ABI v2；额外 features 只用来表达真实独立差异，
不要把所有内部实现细节变成 public feature。
未知必需 feature 拒绝；未知展示 hint 可以省略。Feature 名必须有可验证的
行为定义和 conformance test，不是双方对同一个字符串点头即可。

### 7.2 老新组合与 mandatory policy

| producer / consumer | 规则 |
| --- | --- |
| 旧 producer + 新 consumer | 可以支持已审计 v1 baseline；明确标记 legacy，不凭空声称有新 capability |
| 新 producer + 旧 consumer | 只允许明确等价的 legacy-safe adapter；有新强制语义则不发布可执行工具 |
| 新 producer + 新 consumer | v2 必需 features 双向检查；同 registration 只选择一个版本 |
| 没有 consumer | 只保留 owner direct；不启动 Host，不改变默认工具 |
| 两个冲突 consumer/owner | fail closed；不依加载顺序挑一个；可恢复的 direct 工具留在原位 |

同一 producer 若维护 v1 mirror，在 legacy discovery 看到新 consumer 对自己
精确 registration/revision 的 receipt 后，应主动不重复发布 mirror。
consumer 不能仅因两个 offer 名字一样就静默挑 v2；无法证明同一代注册时
仍按冲突处理，尤其不能因此丢掉另一个 owner 的 policy。

**global mandatory policy 是特殊的安全门，不能“没有 offer 就当不存在”。**
新 policy producer 若要求旧 consumer 不具备的语义，应同时提供一个
兼容 v1 `before` 的 fail-closed guard，明确拒绝 nested calls，而不是略过策略。

另一个关键事实：Pi 0.85.1 的 `dist/core/event-bus.js` 会捕获并记录 listener
异常，`emit()` 的调用者不能用 try/catch 感知“producer 在 offer 前失败”。
因此必须建立**独立于本次成功 offer 的 mandatory-policy 期望集合**：

- v2 增加显式保护要求，例如用户配置 `requiredPolicies:
  ["permission__guard"]`（**提议，当前配置尚不接受**）。只收紧准入，不授予能力。
- 某工具也可要求明确 policy ID；缺失时该工具不可准入。global required policy
  缺失/not-ready/incompatible 则阻断全部 nested effects，不是只隐藏其自身。
- 注册 helper 先登记 required/not-ready 的最小记录，再解析上下文；
  回调错误转换成有界的 `unavailable`/`failed` 记录，不能只 throw。
- 即使 helper 或整个 producer 根本没运行，consumer 仍会发现用户声明的
  required policy 缺失。普通 discovery 自身无法推断未安装的未知保护扩展。
- 收集失败、超限、重复冲突、required 集合未满足，一律不提交执行 snapshot。

迁移顺序：

1. 新 consumer 先收集、验证 v2 policy，并准备实际 enforcement snapshot。
2. 随后的 legacy discovery 携带同 consumer generation 下、已接受的精确
   policy registration/revision receipts。
3. 只有 producer 看到自己的该代 policy 已明确受保护，才可省略 v1 fallback
   deny guard；旧 consumer 没有 receipts，一律收到 deny guard。
4. receipts 不能只有模糊的 `supportsPolicies:true`，不能跨 generation/revision
   复用。任何收集失败阻断准入，不使用半成品 catalog。
5. 加测试证明旧 consumer 忽略未知字段时，仍然不能产生效果。

这是对合作扩展的安全降级契约；不能补救一个只向 v2 发布、却从不提供
旧版 fail-closed 保护的未知第三方 policy。旧 consumer 也不具备 required
期望集合的语义：需要“producer 缺失/初始化失败也阻断”的保护配置，应要求
v2 consumer，由安装/运行前版本检查拒绝旧组合，不列入透明降级支持。
不能声称一个从未获知必需 guard 的旧 consumer 会自动知道要停止。

### 7.3 有界的身份与状态

区别以下身份，不能只拿包名充当所有代次：

- consumer session generation；
- producer installation/instance；
- registration revision；
- direct definition generation；
- cell 的 immutable catalog/epoch snapshot。

ID 是协作关联键，不是权限凭证。重复、回退 revision、旧 generation、
未知 lease、超限 offer 都明确拒绝。
新 generation 的 revision 从新基线开始，不把包版本当 runtime generation。
继续限制 provider/tool/policy 数量、schema/description/reason 大小；
不让 discovery 变成无界数据通道。

diagnostics 应分别报告：

```text
declared → available → protocol compatible → granted → admitted
                                             └─ direct lease held?
```

例如：registered-but-hosted、owner-not-ready、ungranted、
missing-approval-feature、foreign-direct-owner、stale-registration。
这些理由留在 doctor/status，不向模型塞入未授权工具的完整 schema。
发现阶段不访问网络、不读取解析后的 credentials、不尝试真实 API。

## 8. Codex 与 Code Mode 的职责协商

### 8.1 保持三条独立协议

| 协议 | Codex 的职责 | Code Mode 的职责 |
| --- | --- | --- |
| tool contribution | 提供真实 client executor、profile availability、result conversion、owner guards | grants、schema/policy/approval、cell 调度与预算、usage/结果交付 |
| direct-owner lease | 保存 logical activation intent、实际注册证据；投影 physical active set | 对兼容且已授权的 adapter 申请/释放隐藏；失败保守恢复 |
| provider transport | 声明具体 stream 的 JSON/grammar/history 能力 | 按实际 active stream/model/history 选择格式；auto 安全 fallback |

继续维持包依赖：

```text
pi-codex-core / web-search / imagegen → pi-codex-runtime

pi-code-mode       ← optional structural event contracts → Codex owners
```

Code Mode 不调用 Codex 内部工具实现；Codex 不管理 Host/cell/store/grants。
不把独立 Code Mode 重新塞回 Codex bundle；也不因 Codex 安装就自动启用它。
Codex 内部 broker 的“ABI + 相同 runtime package version”检查继续保留；
跨 Code Mode 的互操作只协商 wire ABI/features，不要求两个产品版本相同。

### 8.2 availability 与 activation 不混用

- core patch：只在 owner/profile 允许且真实 executor 可用时提供。
- standalone search：web owner 可独立提供，不要求 core 一起安装。
- hosted search：服务端在 provider turn 内执行的工具，不是可在 JS 中 await
  的 client function；不得把 placeholder 或不同的 fallback 后端冒充同一能力。
- image/view_image：JSON-only 基线下保持 direct，不因有文件路径就声称等价。

`autoEnable:false`、用户的 direct 选择、被 lease 隐藏的 physical inactive，
不能机械地解释为 backend 不可用或 nested grant 已撤销。
owner 要分别提供 capability availability 与 direct activation intent；
owner 的禁用/profile kill switch 则应同时撤销其可执行 offer。
已有 exact grants 是 nested 授权，不从 `getActiveTools()` 推断授权。

### 8.3 lease 是协调状态，不是全局 active-tools 拦截器

仍采用当前合理的 logical/physical 分离：

1. Codex 按 settings/profile/owner intent 算 logical set。
2. 基于 logical apply_patch 判定 native write/edit suppression。
3. owner `projectActive()` 把已持有 lease 的名字投影成 physical inactive。
4. 合并 live registry 后只写一次 active set，随后 reconcile。
5. Code Mode off/协议失败/owner撤销释放自己的 receipt，不回放旧工具全集。

generation/revision 要贯穿 acquire/reconcile/release，旧 consumer 的 release
不能恢复新 owner。owner失去注册资格即停止隐藏，不重新按名字抢占。
修复第 3 节的失败重试、重入和 live-control 预算。

Pi 没有全局 active-tools-changed 通知；不能承诺观察到每个第三方/用户界面的
所有 activation 意图。只有 owner 经协作 control 的意图有可靠因果关系。
这不是 strict-only 模式，也不是权限边界。

### 8.4 transport 不成为“Codex 模式”的授权开关

继续确认 actual stream identity，不按 provider 名字猜。
下一版 transport metadata 可以说明已支持的 JSON function、
raw-JavaScript grammar、canonical history projection 和 wire variants；
只有实际已验证的组合才声明支持。

切换到 Anthropic 等 JSON 路径时，兼容的 data adapters 仍可使用；
`auto → json` 不应该额外撤销纯工具能力。反之，有 grammar 支持也不意味着
patch/search、权限、root 或某个账号的 endpoint 已可用。
transport/config/model 的实际撤销仍按现有 lifecycle 取消旧 cell。

鉴权由执行该请求的 owner 通过 Pi model registry 获取；Code Mode 不接收、
缓存或散播 Codex token。transport handshake 不做账号探测。

## 9. refresh 协议：减少误伤，但不放宽撤销

当前所有 CHANGED 都全量 invalidate，连 observer 注册也可能丢 store。
建议独立 `changed/v2` 的新 change 记录：

```ts
{
  protocol: 2,
  owner, instanceId, revision,
  kind: "execution" | "policy" | "approval" | "presentation" | "observer"
}
```

- execution/policy/approval/revoke：立即关闭旧代准入并取消受保护的旧工作；
  首版仍保守全会话失效，不立即引入复杂的逐 cell dependency graph。
- 同一代重复通知、model_select 与 owner refresh：合并 teardown/recollect，
  不能简单 debounce 后再撤销，给旧权限留一个继续执行窗口。
- presentation：只 reconcile direct visibility/prompt，不重启 Host。
- observer：只影响后续诊断 snapshot；对旧 observer 的 disposal 要明确，
  但绝不能因此取消业务效果或丢 store。
- 参数 schema/effect/prepare/executor/required feature 的变化不是展示变化。
- owner 不能谎报 presentation 来替换 executor；consumer 比对实际契约摘要，
  对不符合类别的变化升级失效或拒绝。
- reload/new/fork/shutdown：代次整体作废；旧 context、receipt、lease 不复用。

有 legacy offer 的 producer 在注册、语义 refresh、撤销/注销时，必须**同时**
发送原 `changed/v1 {version:1}`。不能向旧 channel 只发 `{protocol:2}`：
现有 consumer 会忽略它，已运行 cell 仍持有旧的 executable snapshot。
尤其“原来 legacy-safe → 现在要求 approval”的转换，要先通知旧代撤销，
再完成新 revision 的发布：先让 not-ready/revoked 状态可见，再发撤销通知，
新定义就绪后另发 ready revision。不能只是不再响应未来的 v1 discovery。
新 consumer 对双通知去重，但安全撤销动作立即生效、不延迟到 debounce。
只提供 v2 的 observer/presentation 更新不额外伪装成 v1 execution change；
若确实修改了曾对旧 consumer 发布的记录，仍履行它的 legacy 通知义务。

先去重与区分诊断/展示，再评估“纯新增工具只影响未来 cell”。
不要在没有撤销/引用寿命证明时直接保留所有旧 cells。

## 10. 必须保持的效果与结果边界

建议固定执行顺序：

```text
授权 + generation/revision
 → normalize/prepare/freeze/validate
 → mandatory policy（含显式贡献的 owner preflight guard）
 → approval（同一冻结参数，等待不占 worker）
 → shared scheduler
 → 再检查 abort/revision
 → invoke owner executor（共享业务授权/实际 backend 条件再检查）
 → 结果有限 JSON 检查 / redaction
 → receipt + usage（包括错误路径产生的用量）
```

与当前一致，已经产生的 usage 即使结果无效或后续 redaction 失败也不能丢失；
图里的最后一步是交付，不是把记账推迟到业务成功。

禁止通用转换器做这些事：

- 盲信 `details` 可披露，泄露内部上下文/凭据；
- 把图片直接丢掉或伪造成成功的空字符串；
- 吞掉 `terminate`、`addedToolNames`，假装 Pi 控制语义保留；
- 超时返回后放任原 invoke 的文件/进程效果继续，仍报告“已终止”；
- 用 Promise.all 绕过共享 scheduler，或把带写操作的工具标成并行 read；
- 将 direct 与 nested 都写入 native tool results，导致用量与历史重复；
- 把纯观察 callback 当 policy 或独立业务效果执行器。

共享 scheduler 只覆盖该 Code Mode session，不锁住任意 direct 工具。
文件类 owner 应继续使用 Pi 文件 mutation queue 保护跨入口同文件操作；
其他资源的并发一致性由业务 owner 负责，不由“supports Code Mode”解决。

## 11. 建议实施顺序

| 阶段 | 工作 | 验收重点 |
| --- | --- | --- |
| I0：先修兼容/生命周期 | mandatory feature 老新门禁、owner transition 可重试、live-control 预算、exec/wait 身份一致性 | 旧 consumer 忽略新字段仍不能执行应审批的效果；失败释放可重试；循环创建不会泄漏 |
| I1：冻结声明契约 | v2 types/structural client、示例、result mapping、public unsettled error、conformance fixtures | 无 Code Mode 时 owner 不变；无硬依赖；参数/usage/取消/unsupported controls 符合契约 |
| I2：协商与可诊断 refresh | owner/revision receipts、capability status、duplicate fail-closed、分类/合并失效；Codex 接入 | 正反加载、多份模块、缺包/hosted/profile变化、旧 lease、重复通知、observer 不丢 store |
| I3：首批工具试点 | 一个普通第三方查询 adapter；明确选择的 Pi 文本 builtin adapter；可选 subagent 查询 | overrides 不被绕过、路径/输出语义保留、显式 grants、direct/nested 共享业务检查 |

I3 不是自动启用全部工具的承诺。subagent 控制面、多模态、native hooks 的完整
嵌套调用，继续作为独立设计，不捎带放进本轮。

## 12. 验证矩阵

除了现有 U0–U4 回归，新增：

1. old/new producer × old/new consumer；legacy unknown-field 行为；
   critical policy 不兼容不能导致无保护运行；required policy 在 offer 前
   throw/未加载也阻断其他 nested tools。已有 v1 cell 跨越 legacy-safe →
   approval-required revision 时，旧 closure 必须失效。
2. 两种加载顺序、重复安装、不同物理模块根、shared bus reload、
   consumer 消失/重现、generation/revision 回退。
3. grant/available/direct-active/hidden 的组合；隐藏不授权，inactive 不冒充禁用。
4. dispose throw、create throw、重入通知、64+ 次 create/dispose、旧 lease 晚释放。
5. 外部同名注册先赢、后替换、metadata clone、exec/wait 假同描述。
6. native builtin 与 SSH/sandbox override 并存；拒绝 silent local fallback。
7. prepare 与 approve/invoke 参数一致；policy/redaction 同步或异步失败，
   headless/late approval、跨轮取消、stop unconfirmed、多 cell shared fault。
8. observer/presentation refresh 保持 cells/store；语义变化立即撤销，
   coalescing 不延迟安全动作。
9. standalone Code Mode、仅 core、仅 web、bundle、无 Code Mode、缺必要 feature
   的 production tarball 组合。
10. Pi floor/target matrix、root CI；不以真实账号/网络探测充当 discovery。

本设计阶段不重跑已经通过的业务测试，也不声称上述新增矩阵已经通过。
合并只验证文件树等价和 diff 完整性；文档验证检查链接与 whitespace。
