# Code Mode：工具声明、内置工具接入与 Codex 协商设计

状态：**I0–I3 已实现并验收**。I3 按用户选择只含独立
inventory 查询示例和显式 opt-in 的 Pi builtin ls，不含 subagent 查询。
当前完成范围见第 16 节。正文第 0–13 节保留
`5328d3df` 的 Pi 0.86.1 设计/复核基线；首批历史记录见第 14 节，
I0 完成范围见第 15 节及[实施审计](../audits/pi-code-mode-i0.md)；历史章节中的
“尚未实现”不覆盖第 16 节的后续进度。

后续原生 API 精简：第 8.5 节的独立 `sections.code_mode` 已实现，稳定规则
不再混入动态 cell 列表，也不强制替换完整 prompt。这是从 I2 单独提前完成
的一项；后续分类 refresh、transport 声明与 I1–I3 实施见第 16 节。
本机全局 Pi 现已升级为 0.86.1；下文全局 0.85.1 记录仅描述历史复核环境。
实现、验证和其他扩展迁移见[原生 API 精简审计](../audits/pi-0861-native-apis.md)。

- 原 U0–U4 合并点：`972d2c2c`；旧版设计保留在 `fb4ff5e0`。
- 当前复核基线：用户更新后的 **`main@b02484ce`**，包含
  `bb7e5ea5` 的 Pi 0.86.1 适配，以及后续版本/metadata/test 提交。
- 项目实际解析的 coding-agent、agent-core、ai 均为 **0.86.1**，不是仅改 peer
  声明；Code Mode 现为 private `0.2.0`，Codex runtime/core 为 `0.3.0`。
- 以下区分“用户已完成的适配”和“本方案待实现内容”。不回退用户改动，
  不重新合并旧代码，不支持已退出项目 baseline 的 Pi 0.85.x。
- 前序：[U0–U4 实施契约](pi-code-mode-u0-u4.md)、
  [实施审计](../audits/pi-code-mode-u0-u4.md)、
  [当前 Pi 兼容边界](../pi-compatibility.md)。

## 0. 本次复核改变了什么

| 旧方案判断 | 0.86.1 复核后的处理 |
| --- | --- |
| owner 显式提供 executor，不按名字自动包装 | **保留**；ExtensionAPI 仍没有完整、继承 hooks 的注册工具调用 API |
| getAllTools 只有元数据 | **保留并限定范围**；SDK `AgentSession.getToolDefinition()` 是公共 getter，但不是原生调用管线 |
| loader 依赖 tool-result `addedToolNames` | **撤回旧解释**；现在由请求前的 system-message tool deltas 记录变化 |
| JSON/grammar 两种 transport 协商即可 | **扩展**：需区分 transcript 输入与有效 checkpoint/delta 投影、移除和同名重定义 |
| 只考虑 live active set 与 lease | **扩展**：`/tree` 会从历史声明恢复名称，并绑定当前 registry 的实现 |
| owner 恢复跨 tree 没实现 | 用户已修复 **released lease 的恢复被历史 omission 覆盖**；不得当成待重做任务 |
| `before_agent_start` 返回整个 systemPrompt | 仍可用，但成为本轮 forced projection；建议改用独立 `sections.code_mode` |
| schema/source 引用可作协作证据 | 当前 live registry 仍成立；transcript 的 cloned declarations **绝不可作 owner 证据** |
| 子会话可以继承已完成对话 | 保留；用户已排除 parent system authority，新的 intent metadata 也不得重新泄入 child |
| v1 审批协商、factory 异常路径 | **仍待解决**；升级 Pi 不会自动修正我们的互操作 ABI |

## 1. 结论

推荐 **owner 显式提供可执行 adapter，Code Mode 负责授权和编排**。
不要扫描工具名后自动包装，也不要给 Pi `ToolDefinition` 随便增加一个
`supportsCodeMode: true`，就声称能执行、继承权限或隐藏 direct 工具。

必须分开的三种声明：

1. **可嵌套执行**：实际 executor、参数与结果、效果、取消/结算契约。
2. **允许协作隐藏**：实际 direct owner 的注册证据、activation intent、lease。
3. **支持传输格式**：provider 的 JSON/grammar 编码，以及 TranscriptContext
   中 prompt sections/tool deltas 的投影能力。

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
| provider 输入 | `TranscriptContext`；Codex 已重放有效 prompt/tools，送入原 Standard/Lite complete-loadout encoder |
| Pi 元数据 | ExtensionAPI `getAllTools()` 没有 executor；SDK `getToolDefinition()` 可取 raw definition，但没有通用的 hook-preserving `invokeRegisteredTool()` |
| tool history | system-message `toolsAdded/toolsRemoved` 描述变化；不保存 executor、grants 或 lease |

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

Pi 证据（项目实际安装的 0.86.1 只读依赖，不纳入 vendor）：

- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`：
  `ToolDefinition`、`ExtensionAPI`、`ToolInfo`。
- coding-agent 的 `dist/core/agent-session.js`：`getAllTools()`、
  `getToolDefinition()`、`_preparePromptAndToolLoadout()`、
  `_installAgentForcedPromptProjection()`、`_restoreToolsFromTranscript()`。
- coding-agent 的 `docs/extensions.md`、`docs/session-format.md`、
  `docs/custom-provider.md`、`docs/sdk.md` 及相关 examples。
- pi-ai 的 `dist/types.d.ts`、`dist/utils/transcript.js`；
  agent-core 的 `dist/agent-loop.js`。

**环境差异：** 本机 `/usr/bin/pi` 与 `/usr/lib/node_modules/pi` 在本次复核时
仍是 **0.85.1**，不能作为新 baseline 的证据。此前
`code-mode-local-pi.fm058sNd/start-pi.sh` 固定执行 `/usr/bin/pi`，旧试用目录
未经 0.86.1 重新验收。本轮不改全局安装和既有测试目录。

## 3. 先修的协议缺口

这些是下一轮的修复目标，不是声称本轮已经修复。

### 3.1 mandatory 语义不能继续靠 v1 的新增字段

初版 `ac5c2e51` 与当前版本都使用 `discover/v1`，但初版 bridge 不识别
后加的 `approval`。新版 producer 向旧 consumer 提供带该字段的工具，
旧 consumer 可能正常接收并执行，却不履行审批。

**当前 U4 bridge 会检查审批**；问题是跨版本协作没有 feature acknowledgment。
同样不能依赖旧 consumer “应该会忽略不认识的功能但仍安全”。
这里引用初版作为协议演化证据，不表示 Pi 0.85.x 再次进入支持矩阵；
后续兼容测试应区分 **SDK 版本、包版本、互操作 ABI/feature** 三个维度。

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

Pi 0.86.1 仍没有给扩展暴露不变的 registration token。自己生成的 generation
不是 Pi 的身份认证凭证；相同来源、相同对象/元数据的恶意伪装不在安全承诺内。
owner 主动替换定义必须明确 dispose/re-register。未来 Pi 若 clone metadata，
应失去隐藏资格而非按名字退化认领。

0.86.1 还要严格区分：

1. `getAllTools()` 每次返回新的 ToolInfo wrapper，但其中 parameters 仍是
   当前已注册 schema 引用，不能比较 ToolInfo wrapper 的 `===`。
2. SDK getter 返回当前 raw definition，调用其 execute 不会经过 Pi native
   preflight/result/event/history/accounting 流程。
3. transcript 工具声明会 JSON-clone schema，只保留模型接口字段；
   sourceInfo、函数、owner identity 不在其中。不能拿历史 schema 引用、
   `getCurrentTools(messages)` 或同名 tool delta 来证明 ownership。

### 3.5 新增：历史 loadout 恢复不等于恢复 logical intent

用户在 `direct-binding.ts` 已加入 before-tree/tree handlers，保护：
lease 已释放并恢复 direct 后，历史中的 lease-hidden omission 不应再次隐藏它。
现有 regression 也覆盖了这一范围，应保留而不是重写掉。

但这不是完整的历史协调协议：

- **已复现：** 当前 owner `setActive(false)` 后，跳到历史里该名称 active 的
  loadout，Pi 可以把它重新激活；helper 并不在每种 tree 场景保留独立 logical intent。
- Codex activation 目前监听 session/model/thinking，尚未在 `session_tree`
  重算 profile/ownership 与 native edit/write suppression。
- fresh owner 看到一个历史 inactive 名称，无法知道它是用户关闭还是过去
  lease 的物理投影。不能靠这个布尔值重建授权、历史 owner 或恢复 receipt。
- `dispose()` 新增 tree subscription 解绑；如果解绑后 release 抛错，
  需要明确 retry/closing 阶段是否继续观察历史状态，不能把半拆除当成功。

这些属于下一轮需要明确并覆盖的边界；不声称完整 Codex resume/fork 路径
已经复现故障。第 8.3 节提出统一的仲裁规则。

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

不能简单 `adapter.invoke = definition.execute`，即使 SDK host 可以取得 raw definition：
execute 的参数、结果、hooks、进度、控制流和取消上下文并不等价。
Pi 0.86.1 原生 arguments/results 也收紧到 JSON，不意味着其执行语义与
Code Mode 的 JSON bridge 自动等价。
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
| 动态工具 loader | 仍建议保留 direct，但理由改为“它改变 executable/loadout 与未来 catalog”；0.86.1 已改成请求前 system tool deltas，不再依赖 tool-result addedToolNames |
| ask-user-question 等交互 UI | 默认 direct；Code Mode approval 只用于授权，不是通用问答工具替代品 |
| view_image / image_generation / 音视频 | 当前数据通道 JSON/text-only，不接受静默删媒体；等待单独的多模态设计 |
| `pi-tree-continue`、切模型/重载/compact | agent/session 控制，不进入普通 data adapter |
| external-thinking、keep-defaults、通知/展示 hooks | 本身不一定有可调用的数据工具；无须为了 Code Mode 强行造 tool |
| permission/redaction 扩展 | 提供显式 policy/approval，或抽取共享 guard；仅注册 Pi hook 不等于保护 nested calls |

0.86.1 中，nested adapter 若在闭包里调用 `setActiveTools()`，也可能改变下一次
请求的声明；仅拒绝未知 result 字段拦不住这件事。因此 data adapter 契约
明确禁止调用 agent/loadout 控制操作，违规属于可信 owner 契约违背。
不要把“结果是 JSON”当成对扩展副作用的安全隔离。

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

以下“旧/新”指互操作协议或包代次，不是允许 Pi 0.85.x 与 0.86.1 混装。
生产验收统一使用项目 0.86.1 floor/target；旧 ABI 行为可通过隔离 fixture
验证，不为已经退出 baseline 的 SDK 新增兼容分支。

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

另一个关键事实：Pi 0.86.1 的 `dist/core/event-bus.js` 仍会捕获并记录 listener
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
| provider transport | 声明具体 stream 的 JSON/grammar、TranscriptContext 投影能力 | 按实际 active stream/model/history 选择；preserve declarations/sections，auto 安全 fallback |

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

### 8.3 将 tree 的历史候选状态纳入 owner 仲裁

0.86.1 `/tree` 在发 `session_tree` **之前**调用 `_restoreToolsFromTranscript()`。
它重放历史工具声明的名称，并在**当前 registry**中查找 executor；历史
schema/description 不会还原出旧函数。未注册的名字被忽略。
目标历史没有 system message 时，该 helper 直接返回，不保证清空/重置工具。

所以必须拆开四份状态：

```text
历史 model declarations    只是 loadout 候选，不是 executor/grant
当前 owner logical intent 有来源/代次；不是每次都从 physical set 反推
当前 physical active set  owner projection + Code Mode lease 的结果
当前 cell catalog         已授权的、不可变的 executable snapshot
```

建议由实际 owner（Codex 则是 shared activation service）统一仲裁：

1. 首先验证当前 registration ownership；foreign replacement 不碰。
2. 当前 profile/global kill switch 等 availability 限制优先，历史不能复活禁用能力。
3. 当前代、经 owner 协作接口记录的最新显式意图优先于历史 physical 候选。
   合法的新 settings/model/user 操作仍可按 owner 原业务规则更新意图。
   不能把 Pi 的历史 replay 假装成一条新的 `setActive(true/false)`。
4. 没有显式意图时，owner 才按既有 autoEnable/初始 loadout 规则处理候选。
   不在 Code Mode 中重写 Codex 的业务配置规则。
5. 基于 logical apply_patch 重算 native edit/write suppression；
   再应用 live Code Mode lease，得到 physical set。
6. 只合并自己拥有的变化到 live set，单次写入，再 reconcile；不能回放旧全集。

应在 `session_tree` 协调 Codex activation，而不只是 helper 单独恢复一个名字。
要适配正反加载顺序：Pi replay → 撤销旧 cell/catalog → owner projection →
重新判断是否能持 lease。即使各扩展 handler 次序不同，结束状态应收敛，
不能在旧权限尚未撤销时先重开执行入口。

最低决策表：

| 状态 | 期望 |
| --- | --- |
| 当前 owner 显式 inactive，历史 active | 保持 inactive，除非有真正更新的 owner 意图 |
| owner/profile 禁用，历史 active | 保持禁用；nested offer 也不可用 |
| 当前 lease live，历史 active | direct 仍 hidden，不产生新 grant |
| lease 已成功释放且恢复 active，历史 omission | 保留用户这次升级已实现的恢复行为 |
| owner 已被替换，历史仍有同名工具 | 不隐藏/恢复 foreign tool；它由实际 owner 管理 |
| 无 system history 或 missing registration | 不虚构历史权限/函数，按有证据的 live state 处理 |

generation/revision 要贯穿 acquire/reconcile/release。旧 consumer 的 release
不能恢复新 owner。解绑 tree handlers、释放 receipt、切换 factory 也应纳入
retryable transition，不能在半拆除状态下声称已退出或已恢复。

Pi 没有全局 active-tools-changed 通知；不能承诺观察到每个第三方/用户界面的
所有 activation 意图。只有 owner 经协作 control 的意图有可靠因果关系。
这不是 strict-only 模式，也不是权限边界。

**resume/fork/new/reload 与同实例 tree 不相同。** 新实例不得复用旧 closure、
grant、approval 或 lease。首版不承诺跨 session 持久化所有 logical intent，
以当前 owner 配置、明确 CLI/loadout 和重新发现为准；无法判明历史 omission
来自用户还是 lease 时，不按历史猜测着恢复工具。
如果以后持久化非权限 intent hint，必须独立设计其 session/branch/owner scope，
不能让 child 将 parent 的 metadata 当自身 authority。

也不应笼统宣称“所有 resume/fork 都恢复历史 active set”：
当前 AgentSession 构造路径只有在 `initialActiveToolNames === undefined` 时
自动 restore，而正常 `createAgentSession()` 会提供初始数组。应分别测
普通 CLI/SDK、显式 tool allowlist、直接 session 构造路径，不用 tree 测试代替。

### 8.4 transport 协商增加 transcript 投影维度

**已完成的适配，不重复实现：**

- [provider-runtime.ts](../../pi-extensions/pi-codex-core/src/extension/provider-runtime.ts)
  接收 `TranscriptContext`；native fallback 使用原 transcript。
- [transcript.ts](../../pi-extensions/pi-codex-core/src/providers/openai-codex/transcript.ts)
  用 `getCurrentSystemPrompt/getCurrentTools` 得到有效 checkpoint，再交给现有
  Standard/Lite complete-loadout encoder；不修改持久化 transcript。
- [native-compaction.ts](../../pi-extensions/pi-codex-core/src/native-compaction.ts)
  保留有效 system checkpoint；
  [compaction-prompt.ts](../../pi-extensions/pi-codex-core/src/extension/compaction-prompt.ts)
  跟踪当前 run 的 forced prompt，在 settled/session 生命周期清除。

新协议应说明“格式”和“历史投影”两个独立方面，例如：

```text
input                normalized Pi TranscriptContext
tool wire formats    JSON function / raw JavaScript grammar
projection           effective checkpoint / supported transcript deltas
verified semantics   section patch, removal/redefinition, forced prompt,
                     compaction checkpoint, canonical exec call history
```

这些是 transport offer 的信息，不往普通 data adapter requirements 里塞
provider/SDK 内部细节。actual stream identity 仍需精确匹配，不按 provider 名猜。

当前 Codex 应声明 **effective checkpoint**，不能声称已实现原位 delta transport
或任意 prompt/tool 变化下的 cached-prefix 保留。原生 provider 能否保持 deltas
仍取决于 model/compat/transport；同名重定义、removal 等可能触发 SDK fallback。

0.86.1 transcript 的关键语义：

- system `content` 追加；`sections[name] = text` 替换，`null` 删除；
- 同条消息先 remove tools 再 add；同名 changed definition 可以是 remove+add；
- schema/description/`constrainedSampling` 的变化属于模型接口变化；
  **executor-only replacement 不保证产生 tool delta**；
- Code Mode JSON↔grammar 变化要测同名 exec 重定义与旧 call/result 的配对；
- 在 `context` hook 中过滤 system messages，可能同时抹掉 prompt 和工具声明。
  `projectExecHistory` 只能投影其负责的 exec arguments，不能顺手丢掉这些记录。

切换到 Anthropic 等 JSON 路径时，兼容的 data adapters 仍可使用；
`auto → json` 不应该额外撤销纯工具能力。反之，有 grammar 支持也不意味着
patch/search、权限、root 或某个账号的 endpoint 已可用。
transport/config/model 的实际撤销仍按现有 lifecycle 取消旧 cell。

鉴权由执行该请求的 owner 通过 Pi model registry 获取；Code Mode 不接收、
缓存或散播 Codex token。transport handshake 不做账号探测。

### 8.5 Code Mode prompt 改用独立 section，而非每轮 forced 全文

当前 `extension.ts` 仍返回 `{systemPrompt: event.systemPrompt + ...}`。
0.86.1 下这会设置 request-local `forceSystemPrompt`，仍可执行，但该全文
不是持久化的 structured prompt state，不能声称已利用 section deltas。

建议下一轮改成（片段示意，尚未改运行时代码）：

```ts
pi.on("before_agent_start", (event, ctx) => {
  if (!isCurrentlyAuthorized(ctx)) {
    delete event.systemPromptOptions.sections.code_mode;
    return;
  }
  event.systemPromptOptions.sections.code_mode = stableCodeModeInstructions(ctx);
});
```

确切 API 是 `event.systemPromptOptions.sections`，**不是**
`event.systemPromptSections`，也没有建议向原生 `ToolDefinition` 加未知字段。
只维护自己的 `code_mode`，不覆盖内置 tools/rules，也不使用禁止的 preamble。

两种 section 数据形状不能混淆：

| 场合 | 值 / 删除 / 排序 |
| --- | --- |
| builder `options.sections` | `Record<string,string>`，传未包标签的内容；赋值 upsert，`delete` 去掉贡献；空字符串被忽略 |
| transcript `SystemMessage.sections` | 已渲染的 opaque 字符串或 `null`；`null` 删除；不手工复制 builder 中的原文代替已渲染 checkpoint |

builder 会包装 `<code_mode>...</code_mode>`；不要自行双重包装。
`sections` 的 diff 比较值与是否存在，不应依靠仅调整 key 顺序触发更新。

section 放稳定规则、当前有效能力的说明；不要每轮写 cell ID、trace、
approval receipt、令牌或瞬态倒计时。cell 状态通过 exec/wait、status/cells
提供，既避免无谓 prompt 变化，也不把失效 cell 句柄当持久化状态复活。

transcript 是给模型的声明记录，不是 grants 存储。resume/compaction 后仍按
实际会话重新生成 section；历史里出现“已授权”不能给新的会话授权。
有其他扩展明确强制全文 prompt 时尊重其 exact projection，不主动抢回全文；
Code Mode 的执行 guard 与工具描述仍成立，不能依赖某段 prompt 来 enforcing 权限。

当前强制 prompt projection 在 `context` 之后，保留 replayed tools，再进入
provider normalization。迁移要覆盖 forced prompt 与 section 共存、手动/自动
compaction、/continue 的 recorded sections，以及两个扩展加载顺序。
`pi-tree-continue` 已按 0.86.1 审计，不为这次设计重新引入旧版私有 hook。

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
- Pi transcript 没有可序列化的 executor identity；不能仅凭“没有 tools delta”
  就认定没有语义变化，仍需要 owner registration revision 与撤销通知。
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

### 10.1 不把 native hooks 当作等价的 nested policy

本次核对的 Pi 0.86.1 原生顺序是：

```text
tool_execution_start → prepareArguments → schema validation → mutable tool_call
  → execute（期间可能有 tool_execution_update）
  → tool_result → tool_execution_end → tool-result messages/history
```

与 Code Mode 有几个重要区别：

- `prepareArguments` 同步、在验证前；tool_call 可以修改已验证参数，
  后面**不会再次校验**。
- tool_call 异常会阻止执行；tool_result handler 异常则会被记录并继续链路，
  不能把“redaction hook 抛错”当作已阻断原始结果。
- start/progress events 已发生在 result hooks 之前；最终 tool_result redaction
  不能追溯保护此前的 args/partial updates。需要保密的进度应在 owner 发出前过滤。
- preflight 就失败的调用不经过正常已执行工具的 result-hook 路径。
- 并行工具按 source order preflight，结果 hooks 可按完成顺序交错，
  最终 tool result messages 仍按 source order；不是一个可随意内联的函数。
- `terminate` 是真实 tool batch 的控制语义，不是 data adapter 的普通字段。

所以保持独立的冻结参数/显式审批/共享调度管线。需要 fail-closed 的敏感
过滤放入有明确失败语义的共享 executor 或 Code Mode after-policy，
不要通过伪造 native events 声称获得相同保护。

### 10.2 Code Mode data-plane

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
- 吞掉当前 `terminate` 或 legacy envelope 的 `addedToolNames`，假装控制语义保留；
  后者已不属于 0.86.1 native tool result 契约，不能再用它实现新 loader；
- 执行 adapter 时隐式 setActiveTools/切模型/重载，再把结果伪装成纯 JSON 查询；
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
| I0：先修兼容/生命周期 | mandatory feature 老新门禁、owner transition 可重试、live-control 预算、exec/wait 身份一致性；补完历史候选/当前 intent 仲裁 | 旧 ABI 忽略新字段仍不能绕过审批；tree 不复活禁用/替换的 owner；失败释放可重试、live controls 不泄漏 |
| I1：冻结声明契约 | v2 types/structural client、示例、result mapping、public unsettled error、conformance fixtures；区分 live definitions 与 transcript declarations | 无 Code Mode 时 owner 不变；无硬依赖；不复制 native mutable hooks 或把历史声明当权限 |
| I2：协商与可诊断 refresh | owner/revision receipts、分类/合并失效；Codex 接入；Code Mode 独立 prompt section；transport projection capability | 正反加载、profile/tree变化、旧 lease、重复通知；observer 不丢 store；sections/forced prompt/grammar/compaction 不串层 |
| I3：首批工具试点 | 一个普通第三方查询 adapter；明确选择的 Pi 文本 builtin adapter；可选 subagent 查询 | overrides 不被绕过、路径/输出语义保留、显式 grants、direct/nested 共享业务检查 |

I2 不重做用户已经完成的 Codex TranscriptContext/compaction 适配，而是在其
基础上声明并验证互操作边界。I0 的 tree 仲裁也保留现有 released-lease 修复。

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
10. Pi **0.86.1** floor/target matrix、root CI；不以真实账号/网络探测充当 discovery。
11. tree 到历史 active/inactive/无 system message、同名替换、缺失 registration；
    当前显式 inactive/profile-disabled 不被历史复活；Codex suppression 重算。
12. CLI/标准 SDK/显式工具 allowlist/直接 session 构造的 resume、fork、reload
    分别测试；不将“SDK始终重放历史loadout”作为前提。child 不继承 parent system
    declarations，也不从将来的 intent metadata 获得权限。
13. getAllTools wrapper 与 schema 引用、SDK raw definition、
    transcript cloned declaration 三种身份；executor-only 替换没有 tool delta
    时仍须正确撤销旧 adapter。
14. builder section upsert/delete/空字符串、transcript section null、
    同名工具 remove+add、constrainedSampling 切换；仅顺序变化不能当撤销通知。
15. context 投影保留 system declarations；forced prompt 与 sections 共存；
    manual/auto compaction 的 checkpoint、/continue 保留的 recorded sections；
    Codex effective-checkpoint 与 native provider fallback 的不同路径。
16. tool_call 修改后不重验、tool_result 抛错继续，以及 preflight failure 无常规
    result-hook：不能把这些原生行为误当 nested fail-closed guard。

以上是下一轮实现的验收目标，不声称本次已经全部通过。

## 13. 0.86.1 复核记录与限制

本轮不修改生产实现、package manifests、lock、全局 Pi 或旧试用配置。
设计基于用户当前 main 派生；原 0.85.1 设计分支保留作历史，不把旧代码
cherry-pick 回新 main。只承接原文档提交并修订。

已完成：

- 对比 `972d2c2c..b02484ce`，复核 `bb7e5ea5` 的运行时代码改变。
- 实际解析 workspace coding-agent/agent-core/ai 版本均为 0.86.1；
  项目 CLI `node node_modules/@earendil-works/pi-coding-agent/dist/cli.js --version`
  输出 0.86.1，而全局 `/usr/bin/pi --version` 输出 0.85.1。
- 完整阅读项目安装的 Pi README、extensions、session-format、custom-provider、
  SDK 与相关 sessions/compaction/ai 文档；用实现补足省略或易混淆之处。
  例如 session-format 的简略 SystemMessage interface 漏列 sections，但实际
  types、示例、实现均有该字段，不能照简略摘录断言功能不存在。
- 独立 review 的 visibility unit suite **12/12**。
- 本轮针对性测试 **24/24**：
  `pi-codex-minimal-tools/tests/pi-transcript.test.ts`、
  `pi-code-mode/tests/protocol.test.ts`、`pi-code-mode/tests/visibility-pi.test.ts`。
- credential-free probe 验证 live metadata/reference、真实 SDK tree 重新激活
  显式 inactive 工具、factory 65th allocation、失败 owner transition 不重试。
  fresh-owner 丢失旧 intent 的部分是独立 fixture，不冒充完整 resume/fork 验证。

本机保留证据：

```text
~/.local/state/agents/tmp/code-mode-0861-design.p3Vkmew6/focused-tests.log
~/.local/state/agents/tmp/code-mode-0861-review.0Ezx5uW3/probe.mts
```

未运行：完整 CI/Pi matrix、真实 Host suite、真实 provider/账号请求、完整 Codex
resume/fork 集成；不把旧基线的 U0–U4 测试数字改名为 0.86.1 验收。
文档另检查本地链接、代码围栏与 whitespace。下一轮临时试用环境必须使用
实际锁定的 0.86.1 CLI/依赖，不能继续由旧 `/usr/bin/pi` 驱动新工作树。

## 14. I0 首批实现

本节是 `af0eef5d` 的历史检查点；其中 requiredPolicies 等未完成项已由
第 15 节补齐，不代表当前 I0 仍未完成。

本批实现，不代表 I1–I3 或第 12 节完整验收矩阵已经完成：

- 新增 `discover/v2` 的**审批门禁子集**：consumer 显式确认 `approval/1`；
  新 producer 不向旧 v1 consumer 暴露审批工具 closure，审批 policy 则提供
  v1 `before` deny guard。新 consumer 继续接受已审计 v1。
- 同一次 discovery 的 consumer hello、producer instance/revision 精确 receipt
  用于抑制 legacy mirror；复制对象、旧 revision、其他 hello 不能代替 receipt。
  此处 hello 是单次收集身份，**还不是 I1 的完整 session-generation ABI**。
- 工具 refresh 先置 not-ready 并通知 v1 撤销，再发布新 revision；依然使用
  全量失效，尚未实现 changed/v2、observer/presentation 分类或 teardown 合并。
- owner dispose/create 失败保留可重试状态，禁止同步重入；包括“原 factory
  消失、释放失败、原 factory 重新出现”的路径，以及无效新 control 的清理。
- factory 按 live controls 计数；成功释放才移除，关闭失败仍拒绝新 acquisition。
- exec/wait 使用实例级 schema 引用与 live source/metadata fingerprint，
  不再按 description 认领、刷新或停用同名工具。
- direct helper 保存协作接口记录的显式 intent；tree replay 不能覆盖它，
  live lease 仍隐藏，保留先前 released-lease omission 修复。释放失败不提前
  解绑 tree handlers。Codex 在 tree 重算 profile、logical activation 与原生
  edit/write suppression，并刷新 adapter context；Code Mode 在 before-tree
  先撤销旧 cells，树跳转取消也不会恢复已撤销的 cells。

尚未实现：完整 requiredPolicies 期望集合、通用 requires/availability、
session generation/revision 回退检测、完整 structural v2 client、public
unsettled-effect error、分类 refresh、独立 prompt section、transport projection
声明，以及 I3 adapter 试点。不支持“必需 policy 根本没加载也自动阻断”的配置；
注册的审批 policy 的 legacy deny guard 不能被描述成这种保护。
不新增 builtin 授权、不更换 Host、不改全局 Pi/旧测试目录，不发布或合并 main。

本批验证：

- `npm run ci` 通过：Code Mode **101/101**、runtime **6/6**，包括其余
  workspace、architecture/release/license/pack checks 和 Codex **17 种**
  production tarball/Pi 组合。
- `npm run ci:pi-matrix`：floor 与 target 均为实际安装的 **0.86.1**，
  两轮完整 CI 均通过；不是由全局 Pi 版本或 peer 声明推断。
- `npm run test:host -w @oai404iao/pi-code-mode`：真实固定 Host、
  systemd/cgroup 回归 **52/52**；provider 流量为 fixture，不使用真实账号。
- 独立 review 发现的“失败释放后原 factory 重现”问题已修复并加入回归；
  初次 61 项 focused 测试通过并未覆盖该路径，不能替代新增测试。
- 未运行 Code Mode 专用 production installation probe、真实 provider/UI
  验收或第 12 节完整后续矩阵。全局安装与旧试用环境不构成本批验收。

保留日志：`~/.local/state/agents/tmp/code-mode-interop-i0.WFycHofx/` 下的
`ci.log`、`pi-matrix.log`、`host.log` 和 matrix 子目录。

## 15. I0 完成验收

I0 五项工作均已完成；本阶段不是把完整 I1 v2 ABI 提前宣布稳定：

| I0 项 | 完成内容 |
| --- | --- |
| mandatory 老新门禁 | v2 审批 feature acknowledgment、精确 receipt/v1 deny fallback；新增有界 `requiredPolicies`，producer 未加载、offer 前抛错、policy not-ready/failed/incompatible、缺审批 provider 时均阻止全 catalog 准入 |
| owner transition | dispose/create/invalid control 的失败可重试；foreign/missing/SDK/builtin replacement 也不丢 pending cleanup；discovery/dispose/create 的同步回调触发 shutdown 或替换时重新核验，不再创建/返回已失效 owner |
| live-control 预算 | 成功 dispose 才移出 live Set；factory 先关闭所有 control 的 acquisition，再逐一释放；失败聚合报告，其余 cleanup 不跳过，可重试 |
| exec/wait 身份 | 延续首批实例级 schema/source/fingerprint 校验；同描述、clone 或替换不能被认领、刷新、停用，也不能继续使用旧 exec 入口 |
| tree/intent 仲裁 | 当前协作意图、profile 禁用与 live lease 优先；Codex 重算 native suppression；覆盖正反加载、autoEnable:false/显式 allowlist、无 system history，以及 before-tree 撤销后导航取消不能复活 cells |

补充的全局保护不是自动 grant：`config.json.requiredPolicies` 最多 16 个
不同的精确 policy ID，支持既有单段 ID 及 `owner__policy`，缺失时连本地
read/ls/write/bash 也不能启动。`registerCodeModePolicy` 可以先声明 not-ready
再同步 resolve；错误转换成固定、有界 failed 记录，legacy consumer 得到
deny guard。policy `refresh()` 先通知旧代撤销再发布新 revision。
需要“producer 缺失也阻断”的配置必须使用本实现；旧 consumer 无此独立期望，
不承诺透明降级。旧 ABI fixture 忽略新字段仍不能拿到审批 closure，已运行
legacy cell 的排队/后续 effects 也受同步 v1 撤销保护。

关闭处理先撤销准入，再等待 probe/效果结算；visibility、factory、各 Codex
owner 及 native edit/write 恢复独立尝试。失败不清空其 receipt，也不假装已恢复。

最终验证通过：

- 根 `npm run ci`：Code Mode **111/111**、runtime **18/18**、
  Codex compatibility **319/319**，以及其他 workspace 与 release/pack 检查；
  **17 种** Codex production tarball 组合通过。
- Pi **0.86.1 floor / target** 两轮完整 CI。
- 真实 Host/systemd/cgroup suite **53/53**。
- Code Mode 独立生产 tarball probe（含 required policy、审批协商和 legacy
  deny gate）及 Code Mode + Codex production probe 均通过。

日志、初次失败与修复、fixtures 和验收边界见[审计](../audits/pi-code-mode-i0.md)。
没有真实 provider/账号/UI/发布验证，没有修改全局 Pi 或旧试用配置。

I1–I3 保持待实现：完整通用 `requires`/availability、session-generation ABI
与跨收集 revision 回退检测、structural v2 client/public unsettled error、
classified refresh/去重、prompt section、transport projection 声明、工具试点。
本批不新增 builtin adapter，不持久化跨实例 intent/grants/leases。

## 16. I1–I3 实施

基于 `b4ca1ad0` 的原生 API 精简继续；不回退 I0 安全门禁，也不重复实现
已迁移的 prompt section。用户明确选定：独立查询示例、Pi 文本 builtin
仅 `ls`、暂不接入 subagent 查询。

| 阶段 | 本批实现 |
| --- | --- |
| I1 声明契约 | 公开 v2 offer/receipt/feature/availability 类型；工具级 requiredPolicies；policy/approval/observer 独立记录；稳定 consumer instance/generation、有界 revision 高水位和撤销墓碑；旧 consumer 的新语义门禁；跨安装结构化 unsettled-effect 错误；helper/Codex structural client 共用 conformance 测试 |
| I2 refresh/协商 | changed/v2 分类及 v1 撤销镜像；语义通知去重、同步撤销和异步 teardown 合并；展示分类比对 executable snapshot，diagnostic 查询不能更新已准入权限基线；observer/presentation 保留 cells/store；Codex v2 可选贡献及有效 checkpoint transport 声明 |
| I3 试点 | 可独立加载、无 Code Mode 硬依赖的 inventory 双入口示例；`registerPiBuiltinLs()` 与 `/builtin-adapters` 导出；两者均需 exact grant，默认不加载，不隐藏当前 builtin/SSH override |

最新 API 和使用方式见
[Code Mode README](../../pi-extensions/pi-code-mode/README.md#v2-author-contract)。
注册 closure 不是原生 hooks 调用管线；历史 declarations 不提供 grant 或 owner
凭证。Pi builtin ls 明确是新建的本地实现，不能冒充已安装的 remote override，
也不宣称受 Code Mode read-root 限制。没有新增 package/publication 授权。

验证、初次失败、评审修复与边界见[实施审计](../audits/pi-code-mode-i1-i3.md)。
本批最终根 CI、Pi 0.86.1 floor/target 两轮完整 CI、真实 Host **55/55**
和独立/组合生产 tarball 验证均通过；没有真实账号/UI/发布或 main 合并。
