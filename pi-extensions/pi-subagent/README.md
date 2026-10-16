# @oai404iao/pi-subagent

让 Pi 把边界明确的任务交给可复用的子代理，自己继续工作，随后通过消息汇总结果。
子代理可以继续委派、相互通信，并在后续任务中保留身份和对话历史。

这是**异步多代理树**，不是调用后等待完整答案的同步 runner。实现独立适配 Codex
multi-agent v2，工具参数使用普通明文 JSON，不使用加密参数。
要求 Node.js ≥22.19.0、Pi ≥1.2.0；兼容性下限与开发目标均为 Pi 1.2.0。

<a id="install"></a>

## 开始使用

```bash
pi install npm:@oai404iao/pi-subagent
```

重启 Pi 或运行 `/reload`，然后直接向 Pi 描述分工：

```text
请启动一个子代理，只读检查 src/auth.ts 的认证逻辑，报告具体缺陷和文件位置。
你继续检查对应测试。不要同时修改同一文件；等双方结果齐全后再给出结论。
```

无需先创建配置或角色目录。未指定角色时，子代理使用默认工具策略，并继承调用者当前的
模型和思考级别。扩展不会自动写入预设或配置文件。运行 `/subagents` 可以查看当前代理树。

也可以先仅本次加载，或使用本地源码：

```bash
pi -e npm:@oai404iao/pi-subagent
pi -e /absolute/path/to/omp/pi-extensions/pi-subagent
pi install /absolute/path/to/omp/pi-extensions/pi-subagent
```

委派要求根会话已持久化，不能使用 `--no-session`。子代理与主代理共享进程、工作目录
和文件系统，**不提供操作系统沙箱或独立 Git worktree**。请在任务中明确文件所有权，
并仅加载可信扩展。Pi 的包安装和项目授权说明见
[Pi 包文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)与
[安全说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)。

## 完成一次委派

以下 JSON 是对应模型工具的参数，不是 shell 命令，也不是可以放进 codemode 的调用。
根代理和子代理使用相同的七个 `model-only` 工具；它们只能由模型直接调用，不能通过
codemode 或嵌套工具执行。

**1. 创建子代理：`spawn_agent`**

```json
{
  "task_name": "auth_review",
  "message": "只读检查 src/auth.ts 的认证逻辑；报告具体缺陷、位置和证据，不修改文件。",
  "fork_turns": "all"
}
```

返回包含规范路径的接收确认，例如 `task_name: "/root/auth_review"`，不是审查结果。
主代理此时可以继续独立工作。

**2. 补充信息：`send_message`**

```json
{"target":"auth_review","message":"补充：相关测试在 tests/auth.test.ts。"}
```

这只排入消息，不会启动空闲代理的新一轮执行。运行中的代理会在安全对话边界收到它。

**3. 没有独立工作后等待：`wait_agent`**

```json
{"timeout_ms":300000}
```

等待的是**自己的收件箱活动**，不是某个指定子代理完成。实际正文会以单独、带来源的上下文
消息送入对话。超时不会取消子代理，也不代表任务失败。

**4. 复用代理继续工作：`followup_task`**

```json
{"target":"auth_review","message":"主代理已修复上述缺陷；请只读核对修复和回归测试。"}
```

这次任务直接放在 `followup_task.message` 中，不需要先 `send_message` 再启动。
子代理最终成功或错误结果会自动排入其**结构父代理**的收件箱；不会自动启动空闲父代理。

<a id="configuration"></a>

## 配置代理树

依次读取用户配置与最近的已信任项目配置，后者逐字段覆盖前者：

| 位置 | 作用 |
| --- | --- |
| `<agent-dir>/subagent.json` | 用户默认配置。`<agent-dir>` 由 Pi 决定，通常为 `~/.pi/agent`，可通过 `PI_CODING_AGENT_DIR` 指定。 |
| 最近的 `.pi/subagent.json` | 从工作目录向上查找最近一个文件；仅在项目已信任时读取，不合并所有祖先文件。 |

扩展只读取，不改写这些文件。修改后 `/reload` 会刷新配置和角色目录，**同时停止现有工作**，
不要把它当成正在执行任务时的热更新。

完整默认配置：

```json
{
  "agentScope": "user",
  "maxDepth": 3,
  "maxConcurrentAgents": 4,
  "inheritExtensions": false,
  "openAIIdentity": false,
  "maxOutputBytes": 51200
}
```

| 字段 | 默认值 | 允许值与用途 |
| --- | --- | --- |
| `agentScope` | `"user"` | `"user"`、`"project"`、`"both"`；选择角色定义来源。`both` 中项目同名角色覆盖用户角色。 |
| `maxDepth` | `3` | `0`–`9007199254740991` 的安全整数；根为深度 0。设为 `0` 禁止创建子代理，但不移除通信工具。 |
| `maxConcurrentAgents` | `4` | `1`–`9007199254740991` 的安全整数；限制整棵树的活跃子代理运行数，根不计入。满额时立即拒绝，不隐式排队。 |
| `inheritExtensions` | `false` | 是否在子代理加载其他 Pi 扩展，仍受项目授权和工具上限约束；不继承 pi-subagent 自身。 |
| `openAIIdentity` | `false` | 为 OpenAI Responses/虚拟模型子代理加入可选的 Codex 身份生命周期。 |
| `maxOutputBytes` | `51200` | `1024`–`1048576` 的整数；完成消息正文的 UTF-8 字节上限，投递时另受 128 KiB 上限约束。 |
| `$schema` | 未设置 | 可选编辑器提示，不是执行设置。 |

未知字段、无效 JSON 或不符合范围的值会明确报错，不会悄悄恢复默认。包内提供
[配置示例](config.example.json)和 [JSON Schema](config.schema.json)。如使用示例中的
`"$schema": "./config.schema.json"`，请将 Schema 一起复制到配置文件旁。

`openAIIdentity` 不会安装 Codex 工具或改变提供方认证；需要身份适配器而可选适配器缺失时，
会在模型执行前失败。安装 Codex 适配器后，子代理后续请求还会跟随主会话的 Fast 模式，
不依赖 `openAIIdentity` 或 `inheritExtensions`，也能穿过非 Responses 父代理传递。

<a id="agent-definitions-and-permissions"></a>

## 定义可复用角色

角色是可选 Markdown 文件，不是代理实例。`agent_type` 选择角色，`task_name` 为本次创建的
实例命名，两者不要混淆。

| 来源 | 位置 |
| --- | --- |
| 用户角色 | `<agent-dir>/agents/*.md` |
| 项目角色 | 最近的已信任 `.pi/agents/*.md` 目录 |

`agentScope` 控制读取范围。发现过程只读，不会安装内置角色或补回已删除文件；目录为空时
仍可创建默认子代理，但工具参数中不会出现 `agent_type`。用 `/subagents catalog`
检查可用角色及读取诊断。

例如创建 `<agent-dir>/agents/reviewer.md`：

```markdown
---
name: reviewer
description: 只读检查认证改动
tools: read, grep, find, ls
thinking: high
---

报告具体缺陷、文件位置和证据；不要修改文件，不要把猜测写成已证实问题。
```

随后可传入角色：

```json
{"task_name":"auth_review","agent_type":"reviewer","message":"检查 src/auth.ts 与相关测试。"}
```

| 内容 | 要求 |
| --- | --- |
| `name` | 必填；匹配 `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`。这是角色名，不是更严格的小写任务名。 |
| `description` | 必填非空字符串，显示在可用角色目录。 |
| Markdown 正文 | 必须非空，作为该角色的系统指令。单文件最大 256 KiB。 |
| `model` | 可选；完整 `provider/model-id` 或可无歧义解析的模型 ID。省略则继承调用者。 |
| `thinking` | 可选；`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。 |
| `tools` | 可选；逗号分隔的普通工具权限上限，规则如下。 |

### 限制普通工具

- 省略 `tools`，或整个字段为 `all`/`*`：使用默认子代理策略，但仍受父代理已有上限约束。
- `tools: none`：不给普通工具权限，仍保留七个协作控制工具。
- 精确名称列表：只允许指定普通工具，不支持 CLI 通配模式或 `+name`、`-name` 修饰。
- `$mutation`：优先选当前已激活的 `apply_patch`；否则选已激活的 `edit`/`write`。
  没有可用实现时明确失败，不会为了满足角色而重新激活被扩展禁用的工具。

后代角色只能收窄，不能扩大继承的普通工具上限。七个协作控制独立保留，但始终受深度和
并发约束。显式名称必须已注册并满足扩展启用策略；callable-only/deferred 工具不会被提前
声明给模型。子代理分支内发现的工具在恢复后仍保留。

显式上限也约束 MCP，包括后续才注册的工具。未列出的 MCP 工具不能利用 Pi CLI 的
MCP allowlist 例外绕过上限；精确 MCP 工具名须在子代理初始化时已经注册。
`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` 分别需要精确授权，
仅授权某个 MCP 工具不会顺便开放资源读取。省略上限则保留默认注册表策略。

### 继承扩展不是安全隔离

默认不继承扩展；开启后，项目资源发现仍遵循主会话的信任状态，过滤 pi-subagent 自身。
内置 codemode/tool-search 遵守 Pi 设置和注册表上限；**子代理禁用 codemode 模型调用**。
内置 MCP 不会自动注入。

工具上限约束工具接口，不是文件系统安全边界。子代理和主代理共用进程及文件系统，
工具与扩展仍可能访问 Pi 进程拥有权限的其他路径。需要隔离时应另行使用操作系统层的隔离，
不能把只读角色说明当成沙箱。

<a id="seven-model-facing-tools"></a>

## 七个模型工具

全部工具使用闭合参数对象，不接受额外字段或旧别名。`message` 必须包含非空白文本，
最长 131072 个字符，并受收件箱 UTF-8 字节容量约束。契约定义见包内
[`src/schemas.ts`](src/schemas.ts)，共享处理器见 [`src/tools.ts`](src/tools.ts)。

| 工具 | 必填参数 | 可选参数 | 返回值与语义 |
| --- | --- | --- | --- |
| `spawn_agent` | `task_name`, `message` | `fork_turns`, `agent_type`, `model`, `thinking` | `{task_name,model,thinking}`；创建调用者的直接子代理，返回接收确认和规范路径，不等待完成。 |
| `send_message` | `target`, `message` | 无 | `{accepted:true}`；向同树代理排入明文消息，不启动空闲代理、不打断运行、不等待答复。 |
| `followup_task` | `target`, `message` | `model`, `thinking` | `{accepted:true,model,thinking}`；给既有非根代理任务，空闲时启动，运行时在安全边界交付，不等待完成。 |
| `wait_agent` | 无 | `timeout_ms` | `{message,timed_out}`；等待调用者收件箱活动或导入当前运行的用户输入，不返回实际消息正文。 |
| `interrupt_agent` | `target` | 无 | `{previous_status}`；请求打断单个代理当前运行，不递归、不删除、不启动空闲代理。不能打断自己或 `/root`。 |
| `close_agent` | `target` | 无 | `{accepted:true,target,lifecycle,affected_count}`；永久关闭目标及全部结构后代，只有结构祖先可调用。不能关闭自己、根或兄弟。 |
| `list_agents` | 无 | `path_prefix`, `include_closed`, `limit`, `cursor` | `{agents,next_cursor?}`；读取当前树可见注册记录，不启动或恢复代理，不返回对话正文。 |

### 参数默认值

| 参数 | 默认值/约束 |
| --- | --- |
| `spawn_agent.task_name` | 必填，1–64 位小写 ASCII 字母、数字或下划线；`root` 保留。名称在树的整个生命周期内不得复用。 |
| `spawn_agent.fork_turns` | `"all"`；仅允许 `"all"` 或 `"none"`。 |
| `spawn_agent.agent_type` | 省略时使用默认策略；有角色目录时，仅允许目录中已配置名称。 |
| `model`, `thinking` | 按下节逐字段解析；没有 `reasoning_effort` 别名。 |
| `wait_agent.timeout_ms` | `120000`；允许 `0`–`3600000` 的整数，小于 `10000` 的值提升至 `10000`。 |
| `list_agents.path_prefix` | 省略则列出可见树；可用规范路径或调用者相对路径，不带尾部 `/`。 |
| `list_agents.include_closed` | `false`；设为 `true` 同时包含关闭记录。 |
| `list_agents.limit` | `50`；允许 `1`–`200` 的整数。 |
| `list_agents.cursor` | 上一页的非空 `next_cursor`；不透明，必须配合相同筛选条件。 |

`list_agents.agents` 中每项包含：

```text
agent_name, agent_status, lifecycle, model, thinking, last_response?
```

`last_response` 若存在，形如 `{model,thinking?}`。状态、生命周期和选中模型彼此独立，
含义见后文。分页按稳定路径顺序返回，游标绑定当前树和筛选条件；无效或跨树游标报错。
分页不冻结实时树，不会每页重复插入根记录，也不会为了列举而加载运行时。

<a id="paths-and-history"></a>

### 寻址与历史

根路径为 `/root`。`target` 使用代理路径，不是 UUID，也不是磁盘路径：

| 调用者 | `target` | 实际目标 |
| --- | --- | --- |
| `/root` | `auth_review` | `/root/auth_review` |
| `/root/a` | `child` | `/root/a/child` |
| `/root/a` | `/root/b` | 根下的兄弟代理 `/root/b`。 |

不允许 `../`、`./`、尾部 `/` 或含连字符的任务名。相对路径总在调用者下解析；向父代理
或兄弟发信时使用其规范路径。代理可以与同一根树中的父代理和兄弟通信，也可向非根同伴
发起 `followup_task`，但完成结果始终发送给**结构父代理**，不是任意任务发起者。

`fork_turns:"all"` 复制压缩感知的规范历史投影，只到最新已完成轮次为止；不复制当前
assistant/工具调用后缀、父代理系统权威或扩展控制记录。`"none"` 从新对话开始，
需要在 `message` 中提供完成任务所需的全部上下文。

<a id="execution-selections"></a>

## 选择模型与思考级别

优先使用完整的 `provider/model-id`。未限定模型 ID 保留兼容解析，但未知或有歧义的选择
会失败。`thinking` 只允许 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。

每个字段独立解析，不要求同时指定模型和思考级别：

| 操作 | 优先级，从高到低 |
| --- | --- |
| `spawn_agent` | 本次显式参数 → 角色配置 → 调用者当前选择。 |
| `followup_task` | 本次显式参数 → **目标代理保存的选择**。 |

例如，仅在目标空闲后改变其思考级别：

```json
{"target":"auth_review","message":"请进一步核对边界情况。","thinking":"high"}
```

接收后的覆盖会持续用于后续任务和冷恢复；不会因为后续发起者换模型或角色默认值变化而
回退。它只改变执行选择，不改变角色、系统提示词、工具上限、权限或历史，也不新建对话。
选择通过 Pi 的会话记录保存，不修改全局模型默认值。

运行中的目标可以接受省略或实际相同的配置。不同配置会在排入任务、修改选择**之前**以
`PROFILE_CHANGE_REQUIRES_IDLE` 拒绝。等待目标空闲后明确重提，不会热切换、隐式打断或
建立延迟配置队列。

接收前会检查注册、Pi 模型可用性和配置凭据。显式指定模型不支持的思考级别会失败，
不会静默降低；继承和角色思考级别按 Pi 规则规范化，返回实际生效值。
这些是本地预检，**不能证明端点可访问或账号有权限**；执行时错误仍作为普通失败记录。

任务接收和选择保存共用原子控制快照。任务收据前选择记录写入失败时回滚该次接收，
不移除独立接收的消息或关闭审计。Pi 追加式选择记录可能留下部分痕迹；下一次显式运行
会以保存的控制选择修复，不重建对话历史。

### 选中模型不等于实际路由

所有返回值中的 `model`/`thinking` 表示**选中的组合**，包括虚拟模型，不预测它的下一次
物理路由。`last_response:{model,thinking?}` 才表示 Pi 记录中最近成功物理响应的模型；
没有响应时省略，未记录实际思考级别时不推断。每次子代理运行也会收到其规范路径、
结构父路径及选中组合的权威运行时上下文。

<a id="message-delivery-and-waiting"></a>

## 消息、等待与执行生命周期

### 消息不会自动唤醒空闲代理

运行中的代理在待处理工具结果之后的安全对话边界收到带来源消息。错过当前运行接收边界
的任务会保留到下一次运行；普通消息和完成通知不会单独启动空闲代理。
要给既有代理新工作，使用带任务正文的 `followup_task`。

`wait_agent` 不消耗消息、不返回正文、不等待特定子代理的终态。正文随后以单独的带来源
custom 消息交付到对话，持久上下文收据负责确认。已有待收消息时立即返回；用户输入和
取消也可能提前结束等待。没有持久 sleep 或后台唤醒服务。

只有独立工作已做完、下一步依赖消息时才等待。实现、审查和测试可能耗时数分钟，
长任务可用 `timeout_ms:300000`，不要每 10–30 秒反复轮询。超时是等待上限，不是任务期限；
仅因等待超时，不要重启或打断代理。

最终成功/错误输出自动排入直接父代理收件箱；打断不会伪装为成功完成。空闲父代理保持
空闲，下一轮才接收正文。父收件箱满时，结果保留在子代理的持久发件箱中，等容量可用再交付。

| 限制 | 大小 |
| --- | --- |
| 单条输入消息 | 最多 131072 字符，且不能超过收件箱 UTF-8 字节容量。 |
| 每个收件箱 | 最多 256 条待收消息、256 KiB 消息文本。 |
| 完成结果正文 | 同时受 `maxOutputBytes` 与 128 KiB 投递上限约束；截断时给出完整子会话路径。 |

这些限制不截断子代理保存的完整 transcript。

### 状态、内存与并发

| `agent_status` | 含义 |
| --- | --- |
| `pending_init` | 已接收，待初始化。 |
| `running` | 本轮正在执行，包括工具和轮内等待。 |
| `completed` | 已完成本轮，可接收后续任务。 |
| `interrupted` | 本轮被打断；身份和历史仍保留。 |
| `errored` | 本轮失败；可在处理原因后显式提交后续任务。 |

执行状态不表示运行时是否驻留内存。空闲 SDK 运行时会卸载，但代理身份、历史和收件箱仍
可冷恢复。父运行时不必驻留，后代也能完成任务。

并发计算覆盖**整棵树**，不是每层各有一份额度。根不计入；等待中的子代理仍占其活跃槽位。
消息操作和等待不会额外取槽。满额时新运行立即失败，不会排到可能正在等其子任务的父代理
后面，避免隐式等待队列。

<a id="closing-and-listing"></a>

### 打断与永久关闭

| 操作 | 影响 | 能否复用 |
| --- | --- | --- |
| `interrupt_agent` | 请求取消单个代理当前运行，不递归；返回此前观察到的执行状态，不保证取消已完成。 | 可以；身份、历史、未读消息保留，显式 follow-up 可继续。 |
| 空闲自动卸载 | 释放运行时内存，不关闭身份。 | 可以冷恢复。 |
| `close_agent` | 关闭目标及全部结构后代，阻止新消息、任务、子代理与执行启动。 | 不可以；名称和身份永久保留，不得重新激活。 |

`lifecycle` 独立于执行状态，沿 `open` → `closing` → `closed` 变化。关闭先持久提交整棵
子树的屏障，再请求打断；执行退出且运行时释放后才变成 `closed`。重复关闭幂等，
返回的是接收确认，不保证取消已结束。

关闭保留 transcript、未读消息、取消任务、操作者/时间戳和完成发件箱以便审计。
发给已关闭结构父代理的内部完成消息仍留在那里，或在容量不足时留在持久发件箱；
不会唤醒它，也不改投根代理。关闭不能撤销工具副作用，**不是磁盘清理**。

没有 TTL、自动关闭/删除、历史 GC 或开放/总代理数配额；`maxConcurrentAgents`
仍只限制活跃运行。`list_agents` 默认隐藏已关闭记录，`include_closed:true` 可包含它们。
规范分支可见性和路径前缀筛选仍然适用；“不可见”不等于“已关闭”。

<a id="subagent-dashboard"></a>

## 查看代理与只读历史

| 命令 | 用途 |
| --- | --- |
| `/subagents` | 在 Pi TUI 打开实时只读面板；非 TUI 保留文本摘要。 |
| `/subagents catalog` | 查看角色定义目录、诊断和文本代理树。 |

面板跟随当前根会话及规范分支，包括运行时已卸载的已完成代理；排除其他会话和弃用分支。
打开、关闭面板不会启动、打断或恢复代理。它没有管理、删除或清理按钮。

左侧显示路径、角色、当前任务、执行状态、估算费用、运行时间、请求/工具计数、tokens
和创建时间；右侧显示详情、用量和最近活动。窄终端改为列表/详情布局。

### 面板快捷键

| 按键 | 操作 |
| --- | --- |
| `↑`/`↓` 或 `j`/`k` | 选择代理。 |
| `Tab` | 切换面板焦点。 |
| `PgUp`/`PgDn` | 滚动当前面板。 |
| `Enter` | 窄布局打开详情；详情聚焦时展开/折叠任务预览。 |
| `Esc` | 窄布局先返回列表，再关闭面板。 |
| `t` | 打开选中代理的只读 transcript；`Esc` 返回并保留选择和滚动位置。 |
| `f` | 切换 Open（包含 closing）/Closed 生命周期筛选，关闭历史仍可查看。 |

全屏模式还支持鼠标选择和滚动。生命周期与执行状态分别展示；选中模型/思考级别和最近
成功物理响应也分开标注，虚拟模型路由只是历史信息。

最近活动包含命令、编辑、写入、补丁、普通回答和工具输出的有界多行预览，支持流式更新。
终端控制序列会移除，但命令、文件和输出里的秘密**不会自动脱敏**；不显示思考文本或不透明
重放载荷。最近活动最多 50 项，内容预览最多 240 个 Unicode 字符及少量行，不是完整参数
或结果，更多细节请看 transcript。

列表创建时间为 `HH:mm:ss`，不显示相对年龄。列表运行时长在打开面板时采样，新代理首次
出现时采样，重开前保持固定；状态和用量持续刷新，详情运行时长仍实时更新。不显示上下文
快照时间戳。

### 阅读 transcript

历史视图使用 Pi 原生消息组件和工具渲染器，不是另一个交互会话。保留消息角色和结构，
不另加插件消息标题；内置工具使用公开 Pi 渲染定义。

| 按键/动作 | 操作 |
| --- | --- |
| `↑`/`↓`、`j`/`k`、`PgUp`/`PgDn` | 滚动；离开底部后暂停实时跟随。 |
| `End` | 回到最新页并恢复跟随。 |
| `p` | 加载上一页历史。 |
| Pi 配置的工具输出展开快捷键 | 展开或折叠工具输出；全屏鼠标可单独切换工具。 |
| `Esc` | 返回面板。 |

数据来自子代理规范 JSONL 分支，包括压缩前的工作。复制的父历史会计数，但不混入子代理
自身工作。大型内容、分页和实时显示缓存均有限额，截断会标明；图片和思考内容不展示。
旧编辑使用已记录 diff，不读取今天的文件来重建；需要检查当前文件的补丁预览被禁用。

子运行时驻留时，自定义工具/消息沿其已注册渲染器、解析链和 Markdown 转换器展示。
卸载或重启后，使用原生内置渲染器和 Pi 通用回退；不会为了恢复自定义渲染而重新加载
扩展或连接提供方。截断信息、完整输出路径和已记录工具时长仍传给原生渲染器。

Pi 不持久保存嵌套工具输出：活跃时可能可见，卸载或重启后只剩已记录的嵌套调用元数据。
查看不会执行工具来补齐内容，也不会提示模型、保留子运行时、切换主会话，或写入/修复会话文件。

### 理解统计值

- **归属子代理自身**：排除复制的父历史；总览只对可见子代理求和一次，不加根会话镜像用量。
- tokens/费用包括已记录工具模型用量、压缩和辅助用量；reasoning tokens 若存在，是输出
  tokens 的子集，不再重复相加。
- `req` 统计最终 Pi assistant 响应，不是 HTTP 尝试次数；嵌套工具执行与顶层工具调用分开计数。
- 费用是记录用量的估算，不是账单；缺价格或数据时显示不可用，不当作免费。
- 上下文是 Pi 当前估算用量，包含继承历史，与累计 token 消耗不同。卸载后显示最后快照；
  压缩后可能到下一次响应前都未知。
- 运行时间累加执行区间，含工具和轮内等待，不含任务间空闲。新运行单独保存时间/上下文
  元数据；旧记录或崩溃中断可能不完整，会明确标注未知或部分历史，不重放工作补统计。

<a id="runtime-and-persistence"></a>

## 运行时、持久化与恢复

### 模型运行时隔离

每个根树有一个控制器负责身份、路径、收件箱和执行准入；每个活跃子代理拥有独立 SDK
`AgentSessionRuntime`。子代理的模型运行时、提供方和虚拟模型注册表也独立，不共享可变回调表。

初始化和重载时，从根快照已解析模型目录、提供方定义、虚拟路由和运行时 API key；
已保存凭据仍共享。继承扩展随后注册子代理本地提供方。子代理注册、注销或覆盖运行时 key
不会替换父/兄弟回调，释放后也不会污染它们。

根回调和虚拟路由仍绑定根，不会重绑定不透明扩展闭包。所有后代从根基线开始，不继承中间
代理的临时注册。子代理专属模型/路由须由继承扩展重建；选中模型缺失会明确失败。
根的远程/个性化目录是快照，不是共享可变刷新包装器。

Pi 1.2 私有运行时构造器适配集中在 [`src/model-runtime.ts`](src/model-runtime.ts)，
SDK 布局不兼容时失败，不回退到共享可变运行时。

### 文件布局与写入保证

控制状态和会话位于 Pi 会话存储旁：

```text
<sessionDir>/<rootPiSessionId>.subagents/<treeId>/
├── state.json
└── sessions/
    ├── *.jsonl
    └── *.jsonl.telemetry.json
```

telemetry 旁文件为面板尽力保存运行时间和上下文快照，独立于 transcript 祖先关系与控制
提交；缺失或损坏不阻止代理执行/恢复。

控制快照原子替换并同步到磁盘后才确认消息。子 JSONL 先落盘再公布身份，不伪造用户或
assistant 轮次；收件箱 ACK 前检查 transcript 收据已在磁盘。快照写入失败不推进内存状态。

重启时，未完成运行变为 `interrupted`，**不会自动重放**。显式 follow-up 可复用对话和
待收消息；这不保证外部工具副作用恰好一次。写入失败可能留下 `.pending` 恢复文件，
不会自动清理用户痕迹。没有跨进程协调，不要让多个 Pi 进程同时控制同一棵树。

### 会话切换、分支、fork 与 clone

代理注册绑定父代理的规范分支，弃用分支中的代理不可寻址，也不会静默恢复。
切换会话、`/tree`、关闭和 `/reload` 会先打断并等待旧控制器退出，再替换控制器。
这不是永久关闭身份；恢复旧会话会恢复开放身份，但不重放未完成工作，也不因为返回分支而
执行待处理任务。关闭状态是树级持久控制，返回更早消息不能撤销。

`/fork` 和 `/clone` 都创建新根 Pi 会话 ID 和只含 `/root` 的独立树；复制历史不会复制
旧树身份、收件箱、运行或待办任务。复制的树标记和 `parentSession` 不授予旧树控制权。
新树执行前会收到权威英文上下文，说明旧路径属于旧树，必须重新 spawn。

Pi 1.2.0 的 `/clone` 使用 `fork(leafId,{position:"at"})`，没有专用 clone 事件。
判断基于会话身份/头部，不依赖事件 reason，不改写或反复追加复制历史。另一个独立进程
派生历史不会停止原进程。

<a id="breaking-migration"></a>

## 从旧版迁移

这部分描述多代理 v2 协议迁移，不代表 npm 包版本必须是 2。请一并更新模型指令和角色
工具列表，不要只重命名一个工具。

| 旧接口/配置 | 新接口/操作 |
| --- | --- |
| `subagent`、`subagent_fork` | 改用 `spawn_agent`。 |
| `prompt` | 改为 `message`，并提供必填 `task_name`。 |
| `agent` | 改为可选 `agent_type`。 |
| 旧上下文模式对象 | 改为 `fork_turns:"all"` 或 `"none"`；默认现在为 `"all"`。 |
| `subagent_id`、`agent_id` | 改为 `target` 代理路径。 |
| 先排消息，再用 follow-up 领取批次 | 直接在 `followup_task.message` 中提交任务；它不再领取预排批次。 |
| 子代理 `report` | 改为 `send_message`，目标是父代理规范路径。 |
| 解析 `wait_agent` 返回的完成正文 | 改为读取单独交付的带来源上下文消息。 |
| `maxConcurrentBackgroundRuns` | 改为 `maxConcurrentAgents`。 |
| `runtimeMode`、`maxIdleRuntimes` 及更早开关 | 删除；包括 `enableRunInBackground`、`defaultBackground`、`backgroundProtocol`、`syncBundledAgents`、`reportDelivery`。 |
| 角色 `tools` 中已删除工具 | 更新为现有精确工具名。 |

descriptor v4 及更早版本不迁移、不恢复；旧 transcript、配置和预设文件保留不动。
当前 descriptor 为 v5，树存储格式独立版本化。tree-store v1 与 descriptor v5 继续支持：
旧 v1 记录缺少 lifecycle 时明确视为 `open`，新增关闭/响应审计字段允许缺失。

恢复中的 `closing` 子树仅在无驻留执行后完成关闭；未完成运行仍为 `interrupted`，绝不
重放。不支持的 descriptor 会明确失败，不静默迁移，也不删除旧痕迹。

## 排障与限制

| 现象 | 检查方法 |
| --- | --- |
| 工具提示未初始化/配置错误 | 对照 Schema 检查配置，删除退役字段；查看 Pi 的初始化诊断。修复后重载会停止现有工作。 |
| 无法委派 | 根会话必须持久化；检查 `--no-session`、深度和整树活跃槽位。等待子代理也占槽。 |
| 角色不在目录中 | 检查 `agentScope`、最近 `.pi/agents`、项目授权和 frontmatter；运行 `/subagents catalog` 查看诊断。 |
| 消息已接受但代理没动 | `send_message` 不唤醒空闲代理；用包含新任务的 `followup_task`。 |
| 等待结束却没最终结果 | `wait_agent` 只报告收件箱活动，正文另行交付；超时不是任务失败，不要仅因此打断。 |
| `PROFILE_CHANGE_REQUIRES_IDLE` | 目标仍运行且配置不同；待空闲后明确重提，不会自动延迟变更。 |
| 模型已接受却运行失败 | 本地预检不能证明端点/账号授权；检查具体运行错误。子专属模型还需由继承扩展重建。 |
| 工具未注册或 inactive | 核对角色精确名称、扩展继承和激活状态；不能靠角色重新启用被禁用的工具。 |
| 找不到旧路径 | 检查规范分支、当前根树、fork/clone；新树不能控制旧树，关闭名称不能复用。 |
| 重启后没有继续执行 | 这是防止重复副作用的设计；核对未完成工作后显式 follow-up，避免盲目重复外部操作。 |
| 收件箱容量错误 | 单条消息还受 UTF-8 容量限制；缩短消息或等接收，父完成结果有持久发件箱保护。 |
| 面板数据不全 | 缺失价格、压缩后上下文、旧/崩溃时间记录可为未知；不通过重放或执行工具补齐。 |

<a id="upstream-reference-and-development"></a>

## 来源、开发与许可证

Codex 跟踪基线为 `551bd409ebf03fc6ea0dcad0915368d8a493f012`（2026-10-06 核验远程 main）。
精确来源记录见包内
[`provenance/openai-codex-551bd409-multi-agent-v2.json`](provenance/openai-codex-551bd409-multi-agent-v2.json)
和 [第三方声明](THIRD_PARTY_NOTICES.md)。有意保留的 Pi 差异包括明文参数、可选 Markdown
角色、只复制已完成轮次、持久收据、列出全部已注册代理，以及不提供 Codex 持久 sleep
或提供方专属工具命名空间。

以下检查在维护仓库根目录运行，npm tarball 不含测试和仓库开发工具：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @oai404iao/pi-subagent run check
pnpm run ci
pnpm run ci:pi-matrix
```

测试使用本地脚本模型和真实 Pi SDK 运行时，不使用真实模型凭据。测试通过不能证明实时
端点或账号权限；实时模型验证须另外明确允许。

MIT © 2026 oai404iao，见包内 [LICENSE](LICENSE)。上游许可证和声明单独保留于
[LICENSES/](LICENSES/) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
