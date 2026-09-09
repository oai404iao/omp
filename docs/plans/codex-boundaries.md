# Codex 分阶段重构

## 范围与原则

基于本仓库 `e5cef8fb`，不依赖外部仓库的目录/行数统计作为验收标准。
本轮首先交付可独立审查、可回滚的内部模块化阶段；后续阶段必须通过
前一阶段门槛，不能把目录搬迁当成独立安装能力已经完成。

- 保留现有 npm 名称、默认工具、配置路径、schema、协议和 replay 行为。
- 保留 Codex provenance、许可证快照、协议 source map 和 guarded publish。
- 不触碰主工作区已有的 subagent 修改；不自动 push、发布或修改 release locks。
- 不引入 Code/Notebook Mode、Rust 或未验证的模型 family 推断。
- 新模块以 400 行为目标；已有闭包状态机允许显式、只能下降的例外。
  不为达标把共享可变状态隐式拆散，也不压缩代码行数。

## 阶段与验收

| 阶段 | 工作 | 验收 / 回滚 |
|---|---|---|
| S0 | 独立工作树、锁定基线、完整 CI、列出兼容面 | 原始 `npm ci --ignore-scripts && npm run ci` 通过 |
| S1 | 拆 provider shim、Responses replay/stream 模块；保留旧路径显式 facade；加入依赖图/行数门禁和共享 fixture | 类型、原有行为测试、导出身份、无环、许可证、tarball 检查；单独回滚模块化提交 |
| S2 | 拆 registration 的 prewarm / 展示生命周期和 Responses 流内部状态机；定义可选 capability seam | 无 UI 的传输层；Abort/重试/continuation 与旧事件序列一致；旧 facade 不新增 API |
| S3 | 建立独立 web-search/imagegen 包及共享 runtime；旧包成为兼容组合入口 | 独立安装和双向加载顺序、重复安装、卸载、旧会话恢复矩阵通过；新包先 blocked |
| S4 | 聚合精确 pin、changesets 联动、产物依赖顺序、各包许可证及 README | 真实 tarball 的隔离安装 smoke；未批准 bootstrap 前不改 publishable allowlist |
| S5 | Pi 双基线验证，保留 0.84.2 floor，在独立任务升级锁文件到明确 0.85.x | floor + target 的完整 CI；确认私有 tree-continue 的 exact peer；不凭 peer range 宣称兼容 |

## S1 文件归属

`src/provider-shim.ts` 仅转发既有导出；实现归属：

- `providers/openai-codex/`：请求体、header / metadata、Lite、SSE、WS 连接/
  session cache / continuation / retry / prewarm、事件规范化、计费及 stream 编排。
- `adapter/compaction/`：checkpoint 筛选及预算、响应收集、SSE/WS trigger、
  transport 选择、native compaction 入口。
- `tools/image-generation/`：存储、预览、展示数据类型。
- `tools/web-search/`：activity 提取、合并及展示文本。
- `extension/`：Pi provider / 生命周期注册；只在这里将传输与 UI 组合。
- `providers/responses/`：items、history、signatures、citations、message/tool
  转换及 stream。原 `openai-responses-shared.ts` 同样保留 facade。

内部实现不得反向导入 facade。类型边与运行时边都检查；模块级 socket cache
保持单一实例。既有 `subagent-inline` npm subpath 不移动。

## S2 → S3：包边界决策

不能简单让 web-search/imagegen `depend` 旧全集包：这会把被卸载的高风险
能力又传递安装回来，也会造成 provider 重复注册。

目标包（S3 已创建；新增四包仍 private/blocked，未发布）：

| 包 | 所有权 | dependencies | Pi peers |
|---|---|---|---|
| `@oai404iao/pi-codex-runtime` | 无自动注册的 auth/header、profile/catalog、identity、共享协议及资源服务 | 仅自身实际 runtime 依赖 | 使用到的 Pi API，floor 0.84.2 |
| `@oai404iao/pi-codex-core` | transport、patch/view-image、compaction、identity hooks | runtime 精确版本 | AI / coding-agent / TUI |
| `@oai404iao/pi-codex-web-search` | reserved web endpoint、工具、activity | runtime 精确版本；**不依赖 core** | 实际使用的 Pi peers |
| `@oai404iao/pi-codex-imagegen` | reserved image endpoint、background jobs、保存/展示 | runtime 精确版本；**不依赖 core / web-search** | 实际使用的 Pi peers |
| `@oai404iao/pi-codex-minimal-tools` | 保留旧安装入口与默认行为的兼容 bundle | runtime 及三个 capability 精确版本（旧 facade 需直接访问 runtime） | 保留已有 peers |

runtime 是纯库，不声明 `pi.extensions`，不能成为另一个 god package。
若不需要共享某一实现，应留在能力包中而不是提前塞入 runtime。
图方向为 bundle → capability → runtime；capability 之间不互相依赖。
先保留旧包名，不同时再创建第二个功能相同的 bundle。

已落实的迁移（完整历史路径表见 `scripts/codex-source-owners.json`）：

- `tools/web-search.ts` + `tools/web-search/*` → web-search；
- `tools/image-generation.ts`、`background-image-generation.ts`、
  `tools/image-generation/*` → imagegen；
- 实际导入图核对发现 `view-image` 不依赖 `utils/images.ts`，因此后者整体
  归 imagegen；移除 image storage 对 core 的 dynamic-import helper 的隐藏依赖；
- `codex-http.ts`、`provider-headers.ts`、request-profile/catalog 和 wire identity
  → runtime；共同 catalog/settings schema 由 runtime 唯一管理，bundle
  保留字节一致的 schema/default-catalog 镜像，避免建立互相漂移的新配置路径；
- `codex-reserved-tools.ts` 的每种能力分为 runtime 内独立的
  `reserved-tools/{web-search,image-generation}.ts` 资产，共享类型和组合函数；
  保留 Apache notice、revision 和 fingerprint，不把协议证据复制进能力客户端；
- web 工具的本地参数 schema 单独归 web 包，移除原 554 行例外。

## Seam 与 identity

- runtime 拥有 Codex wire `SessionId / ThreadId / TurnId` 的生成、持久化映射
  和请求语义；首个能力包通过共享服务安装生命周期 hook，独立工具不要求
  core；subagent 仅提供父子关系和任务生命周期。
- `pi-subagent` 不复制 Codex wire 生成规则，不因不同上游取证 revision
  而强行改写已有行为。先给 `subagent-inline` 写契约，再做兼容转发。
- capability 注册须版本化、幂等且与加载顺序无关；用 Pi event bus
  探测能力，session shutdown 注销；不靠跨包全局变量碰巧单例。
- core 不安装时工具必须能用 Pi auth 自行执行；core 安装时可贡献
  request 工具转换和 output capture；未安装 imagegen 不加载存储/预览服务。
- 不把“允许读取历史 image/web response item”与“允许调用端点”混成同一开关。

## S3/S4 测试与发布顺序

测试组合：旧包独装、core 独装、web 独装、image 独装、core+web、
core+image、全组合、旧包+能力包重复装；交换顺序并执行 reload/new/fork/shutdown。
覆盖缺少登录、未知模型、禁用能力、后台 abort、无 UI、缓存回放和旧配置。
使用本地假端点，不访问用户真实账号或收费服务。

发布依赖拓扑：runtime → 三个 capability → 旧 bundle。
新增包先 private/blocked；bootstrap 需要名称归属、许可证、产物隔离安装和
人工 2FA。CI 仅准备并验证，不自动 bootstrap。所有 tarball-facing 变更
有 changeset；精确 pin 更新必须递归生成消费者 changeset，并有脚本测试。
兼容 bundle 保持同名工具/配置/默认行为可做 minor；移除旧入口或改变默认
能力必须 major，不能用 patch 偷换。旧版本 tarball 保持不可变。

## 执行记录

- S0：原始锁文件安装及完整 `npm run ci` 通过。
- 实施位置：`.worktrees/refactor-codex-boundaries`，
  分支 `refactor/codex-boundaries`；主工作区 subagent 修改保持原样。
- S1：已完成。两个旧文件分别由 4,511 / 1,463 行变成 20 / 7 行的显式
  facade；迁移和抽取 55 个模块。所有新模块均不超过 400 行。
  Responses 的 stream state、citation renderer 和 usage 也已拆开，
  web activity 的 renderer 已移出 provider registration。
- 源码依赖图：85 个 TypeScript 模块，含类型边，无环、无 facade 反向依赖；
  `scripts/check-codex-architecture.mjs` 已接入根 CI，并有 6 项自身测试。
- 兼容性：原有 Codex 227 项测试保持通过，新增 2 项旧导出集合/实现身份测试；
  提取复用的 provider harness 和 WebSocket server/frame fixtures。
- S1 最终锁文件的干净 `npm ci --ignore-scripts && npm run ci` 通过，共
  420 项测试，另有所有 workspace 类型检查、license 和 pack 检查。
  `npm run changeset:status` 确认本次 Codex patch changeset；
  未运行 version/publish，既有 subagent changesets 未改动。
- Pi 0.84.2 CLI 在临时空 agent 配置、offline、禁用自动发现、显式 `-e`
  加载入口的 `--list-models` smoke 退出 0，无 extension load 错误；
  未登录时返回没有可用模型是预期结果。此项不等同于真实账号端点测试。
- 根开发依赖新增 `typescript-ast`（TypeScript 5.9.3 的 npm alias）仅供
  AST 依赖检查；各 workspace 仍用 TypeScript 7.0.2。锁定的 Pi
  0.84.2 及所有已有运行时依赖版本未升级。

### S2：已完成

基于 `bad628e7` 继续同一工作树，保持旧导出集合、工具默认值、配置、
identity 和协议 revision 不变。本阶段不新增 npm exports 或依赖。

已落地的所有权：

- `extension/register.ts` 从 368 行缩至 36 行，只组合旧入口的默认能力。
- `extension/provider-runtime.ts` 拥有 provider 注册和 Pi lifecycle hooks；
  可不注入 presentation 使用。架构检查禁止它直接或间接依赖 `tools/`、
  图片/主题工具以及旧的组合入口。
- `extension/startup-prewarm.ts` 拥有 prewarm generation、任务、认证等待、
  AbortController 和超时清理；传输的 WS cache 仍保持原有单一所有权。
- `tools/image-generation/display.ts` 拥有展示队列、flush timer、preview cache
  和展示 sink 的 generation；`capture.ts` 拥有图片保存的 best-effort 策略。
- `tools/web-search/capture.ts` 拥有每个 response attempt 的 activity 状态
  和 text signature；不把展示逻辑留在传输编排里。
- `providers/openai-codex/stream-effects.ts` 定义内部 observer 契约，
  `extension/provider-presentation.ts` 定义内部展示生命周期契约。
  它们是下一阶段的注入边界，**不是**已发布的跨包 broker 协议。

请求处理顺序：

```text
streamSimple：同步捕获当前会话的展示 sink
  → 传输请求 / 必要时等待 prewarm
  → 每个 response attempt 创建自己的 observer
  → 规范化 SSE / WS 事件
  → 捕获 continuation items
  → await 可选 observer（默认：图片捕获 → 搜索 activity）
  → Responses replay / stream parser
```

会话开始顺序为 prewarm reset → provider 选择 → 展示 clear → prewarm start；
关闭顺序为 prewarm reset → 展示 flush → WS close → 展示 clear。
普通完成在 agent_end 调度一次 flush，保留 FIFO、原消息类型和
`triggerTurn: false`。

随生命周期拆分修复并测试：

- 同步 flush 会取消原来的 timer，防止旧 timer 提前 flush 新会话的队列。
- clear 使旧请求的展示 sink 失效；即便响应在会话切换后才到达，也不显示
  到新会话。sink 必须在请求开始时捕获，不能在收到响应后才捕获。
- abort 阻止后续图片保存和保存完成通知；保存失败仍不丢弃 provider replay。
- speculative prewarm 的认证/请求构造失败不再泄漏未处理的 Promise rejection；
  已取消或旧 generation 的失败不能写入 transport fallback 状态。
- reset 会立即释放等待 prewarm 的调用方，不必等尚未完成的认证返回；
  底层认证 API 不保证配合取消，迟到的结果/异常仍被消费且不能打开旧连接。

限制：会话 clear 本身只使展示 sink 失效，不是磁盘取消信号，也不回滚
已保存文件。调用方仍需 abort 请求；已开始的文件写入没有取消 API。
不注入搜索 observer 时不会生成搜索 activity/text signature；读取已有
历史 signature 的 replay 逻辑保持原样。独立搜索包的 observer 自动组合
属于 S3，不应把内部裸 runtime 当作已经完成的独立用户产品。

验收：

- 原有 229 项 Codex 测试保持通过，新增 17 项测试；覆盖无 presentation 的
  SSE/WS、native image/compaction continuation 与 replay、observer 顺序/
  错误收尾/并发隔离、迟到图片通知、timer 取消及 pending-auth prewarm reset。
- 架构检查新增传递依赖路径检查及 2 项自身测试；92 个 TS 模块无环，
  没有工具实现绕经共享模块回流到 provider runtime；新文件均 ≤400 行。
- 最终完整 `npm run ci` 通过，共 439 项测试（Codex 246）；所有 workspace 类型检查、
  许可证和六包 tarball 检查通过。Pi 0.84.2 离线显式入口加载 smoke 退出 0。
- 干净安装后的一次完整 CI 在未改动的 subagent 并发测试
  `mailbox-v2 send_message only persists FIFO work until followup_task starts one turn`
  失败：`tests/coordinator.test.ts:1640` 的 `first.pendingMessages` 为 2，
  期望 1。当前工作树该单测独立复跑 5 次，2 次失败；对 `bad628e7`
  做只读 `git archive` 源码快照、使用相同已锁定依赖，并将 workspace
  包链接指向快照，在原 cwd 复跑 10 次也有 1 次同样失败（临时 cwd 的
  另 5 次通过）。随后完整 CI 438 项通过。本阶段保留该既有不稳定性
  的记录，不修改 subagent，也不把一次复跑通过等同于已经修复。
- 新增 `calm-codex-lifecycles` patch changeset；未改 package/lock、Pi 基线、
  release locks、发布 workflow 或主工作区 subagent 修改。

### S3：实现与隔离验证

- 四个新包为 `0.1.0-alpha.0`、private/blocked；runtime 无自动注册入口。
  旧包默认入口为 11 行组合，旧模块保留纯转发，`./subagent-inline` 不变。
- Broker 通过同步 Pi event-bus 探测，要求 ABI v1 和同一 runtime 版本。
  不以模块全局对象或 ExtensionAPI wrapper 相等为前提；不同物理安装根
  中的模块副本也可去重。工具、provider、命令、renderer 和 identity hooks
  各有唯一所有者。混用不同 runtime 版本明确失败，避免 catalog 随顺序变化。
- Activation/presentation lifecycle 由首个能力包统一安装，core 仅连接
  stream effects；不再在 core 重复安装展示 clear/flush。shutdown 关闭探测，
  flush/clear 展示并取消后台任务；core 仍负责 prewarm reset / WS 关闭。
- 独立能力通过 Pi auth 调用 catalog 支持的 standalone 端点。没有 core
  时 hosted 能力不自动启用，显式调用明确报错；图片既有显式 fallback 保留。
- 架构检查覆盖五包全部类型、动态和 re-export 边，并校验 exports、
  精确运行时依赖和禁止的 manifest optional/peer 边。保留行数只降预算。
- 保留三个 schema/catalog 兼容镜像、patch grammar、Apache LICENSE/NOTICE、
  provenance 和最终 namespace JSON 指纹；补五包归属文档和 README。
- `npm run test:codex-packages` 的 17 组组合实际 npm 安装本地 Codex
  tarball、使用 Pi 0.84.2 loader，并覆盖缺少认证、假 HTTP、独立物理根、
  重复安装、逆序与 shutdown/reload。独立断言安装闭包不含未请求能力。
  外部 Pi/transport 依赖仍从锁定安装以 file link 提供，并非全 registry/
  无链接生产安装验收；未访问真实账号和收费端点。
- 正向/逆向会话组合单测还覆盖旧配置、禁用能力、未知模型、new/fork、
  无 UI、abort、迟到图片和未安装 imagegen 时不持久化图像；原 replay、
  background abort 和 transport 回归保留在旧包测试中，通过 facade 测新 owner。
- Changesets 3 默认跳过 private 包，导致 public bundle 的依赖树无效。
  显式启用 private 版本跟踪但禁用 tag；新增五包 changeset，不修改 npm
  资格。发布产物准备在任何打包/registry 操作前拒绝 private/blocked
  传递依赖，包括旧 bundle；未更改已有发布资格、bootstrap allowlist 或 locks。
- 重复安装支持针对本工作树的 broker-enabled 兼容 bundle，不是无法参与
  握手的未改写历史 monolith tarball。不得宣称后者能与新包透明混装。
- 最终干净安装及完整 CI 通过：474 项 node:test（Codex 277，其中组合
  回归 27），另有 17 组真实 Pi-loader tarball 组合；191 个 TS 模块无环/
  禁止依赖，十包 pack、许可证和 changeset status 通过。既有依赖版本、
  Pi 0.84.2、release locks 和主工作区均未修改；未运行 version/publish。
  发布预备命令负向测试按预期拒绝 bundle → private runtime，未产生产物。
  S2 记录的 subagent flaky 未在本轮修复，一次通过不代表它已消失。

### S4：版本联动、产物顺序与无链接消费者

- 在同一工作树基于 `28aa6238` 实施。未修改任何 capability 运行时行为、
  workspace 版本、既有依赖版本、Pi 基线、发布资格或 release locks。
- `workspace-versioning.mjs` 通过 Changesets 的已锁定 reader 读取待发布条目；
  新增 `changeset:sync` / `changeset:check`，递归生成消费者 patch changeset，
  已有显式 changeset 优先，生成结果幂等。覆盖 hard 与 optional dependency，
  包括 subagent → bundle；检查不误把“版本提交中已消费全部 changesets”当错误。
- `changeset:version` 包装实际 Changesets version，并严格回填新版本精确 pin；
  消费者未 bump 时拒绝修改 pin。真实 CLI 测试只在临时 Git 仓库生成版本，
  验证 runtime-only patch 传播到三能力、bundle 与 subagent，且私有状态不变。
  另覆盖多次 prerelease 与 pre exit，忽略已消费的 pre/ 条目，并为后续
  自动 changeset 使用不同 ID，避免覆盖先前 prerelease 消费者记录。
  发布 PR 工作流已有 wrapper 调用，因此不需要更改 workflow 或授权。
- artifact 准备按依赖拓扑稳定排序；publish 端重新校验资格、闭包和顺序，
  在首次写 registry 前检查整批 tarball hash / package identity / 依赖声明。
  recover 节点也记录 SHA-512；每个节点核实 registry gitHead/integrity 后才
  继续消费者。发布失败或内容不一致阻断后续 publish，并继续禁止批次打 tag。
- 隔离消费者改为投影根锁的 production/host-peer 依赖闭包，保留嵌套依赖
  的实际版本。全部执行 `npm ci --offline --ignore-scripts --omit=dev`，
  外部依赖来自锁定 registry tarball，Codex 来自本地产物；遍历确保无外部
  symlink，并导入消费者自己的 Pi loader。17 组组合通过，不再链接工作区
  node_modules。测试框架不属于消费者运行时；服务端仍为假 HTTP/认证。
- 发现 Pi 自带 shrinkwrap 导入的六个条目有固定 URL/version 但缺少 integrity。
  从同 URL/version 的既有锁条目或已缓存 npm dist 元数据核对恢复 SHA-512；
  未升级依赖。版本 wrapper 的锁刷新保留这些已审查 hash，遇到不明或冲突
  内容拒绝猜测；没有建立第二个锁文件或修改 release locks。
- 新增纯版本/锁图测试及实际 publisher 的假 npm/git 测试，覆盖逆序批次、
  optional 边、损坏的后置产物在任何 publish 前失败、private 包拒绝、
  发布失败/registry hash 错误后的下游阻断和 recover 不重复发布。
- S3 编写的四份新包 `AGENTS.md` 被本机全局 Git ignore 排除，未进入
  S3 提交；本阶段明确将这些任务所有的维护文档纳入版本控制并同步验证命令，
  不修改全局 ignore，也不将它们放入 npm tarball。
- 最终干净安装与完整 CI 通过：488 项 node:test、17 组无外部链接的
  production tarball / Pi-loader 组合，191 个 TS 模块架构检查及十包
  license/pack 检查通过，changeset status 正常。常规与 bootstrap 产物准备
  均在 bundle → private runtime 处按预期失败，未创建 release-artifacts。
  工作树中的 workspace/既有依赖版本全部不变，Pi 仍为 0.84.2。
  本阶段仅修改基础设施、测试和维护文档，未改变 tarball 内容，因此不额外
  添加包 changeset；S3 的待发布 changeset 保留。subagent 已记录 flaky
  仍未修复，主工作区用户修改保持原样。

### S5：Pi 双基线

- 基于 `8658c935` 独立实施本阶段，目标明确为 `0.85.1`。核对官方 npm
  版本及上游发布记录；0.85.1 修复了 0.85.0 的 SDK 导入问题，不用浮动
  `0.85.x` 或 peer range 代替实际验证。见 `docs/pi-compatibility.md`。
- 普通包的 peer floor 仍为 `>=0.84.2`，dev dependencies 精确 pin 到
  0.85.1；root 同时锚定四个 SDK 包。首次仅修改 workspace dev pins 时，
  npm 仍把 0.84.2 hoist 到根，并给普通包安装嵌套 0.85.1，可能使根测试
  驱动误验旧 SDK；显式 root anchors 与实际 resolve 检查消除了该问题。
- `pi-tree-continue` 的 private/blocked、exact 0.84.2 peer/dev 和实现
  均不变。实际 loader 检查：floor 注册原 hook；target 不注册命令、
  明确警告，并保持目标 AgentSession prototype 不变。
- `ci:pi-matrix` 对同一份 tracked 工作区源码建立两个独立临时副本。
  target 使用根锁；floor 只改测试副本的 Pi dev pins，再由根锁生成临时锁。
  两者都 clean install 后运行完整 `ci`，日志记录源码 SHA-256、Node/Pi
  版本；不复用工作区 node_modules，不修改调用方，不自动重试失败。
- 更新根锁及 SDK 自带 shrinkwrap 的校验和保留。只借用相同 URL/version
  的已知哈希；新的 target 若同时存在带 hash 的 hoisted 条目，可用于补齐
  同一 artifact 的 shrinkwrap 条目。保留唯一根锁，没有新增长期 floor 锁。
  Pi 引入的传递依赖变化保留，Codex 的已审查 transport 直接依赖未升级。
- 新版 SDK 的多副本安装触及临时空间配额；consumer 验证改用隔离子进程，
  验证 actual package version 与 SDK VERSION，及时删除不再需要的安装。
  同组逆序/reload 和独立物理 root 仍共用真实 event bus 进行去重验证，
  没有改回 workspace link 或减少原有 17 组组合。
- 新增 credential-free offline CLI probe、每个 workspace SDK resolve
  检查及 baseline/新 hash 复用单测。原 Codex 源码、catalog/schema、
  协议/replay、许可证及发布资格保持不变；九包 manifest/README 有 changeset。
- 只读 CI 配置为 Node 22.19.0 / 24.x × Pi floor / target，并上传诊断日志。
  本机实测 Node 24.13.0；不声称已经执行远端矩阵或本机 Node 22.19.0。
- 首轮 target 检查再次命中已记录的 subagent FIFO flaky
  (`coordinator.test.ts:1640`, `2 !== 1`)；没有修改 subagent runtime 或
  跳过测试。随后 floor 与 target 的完整 CI 分别通过；通过不代表 flaky 已修复。
- 最终同源码双基线矩阵通过：每个版本 490 项 node:test、17 组生产
  tarball/loader 组合、191 模块架构及十包 license/pack 检查。根目录另行
  clean install 后锁哈希不变，实际 SDK/CLI smoke 再次通过；生产 audit
  报告 0 vulnerabilities。changeset status 正常，未执行 version。
- 常规和 bootstrap artifact preparation 再次在 bundle → private runtime
  处按预期阻断，未创建 release-artifacts。主工作区用户修改、workspace
  包版本和 release locks 未变；没有 merge、push 或发布操作。

### 剩余工作（不能标记为已完成）

- 人工 bootstrap、npm 名称/账号资格和真实发布仍未执行；新包保持
  private/blocked。Codex 仍以本地 tarball 替代未发布 registry 版本。
  不得把无链接安装验证称作已经发布，也不能绕开当前 bundle 依赖门禁。
- 远端 Node/Pi CI 矩阵、真实账号/收费端点、交互式 UI 和 npm 发布尚未执行；
  目前验收仅覆盖文档中明确的两个 Pi 版本与本机 Node 基线。
- 三个历史模块保留明确行数预算：catalog 636、wire identity 596、
  background image 574。预算不自动扩张；
  后续按归属拆分时同步降低或删除例外。
- 新的包级 `AGENTS.md` 和本计划均为维护文档；pack 检查禁止发布
  AGENTS、tests、reference 及 `docs/audits|plans`，并核对 Codex 全部 TS
  runtime 模块确实进入 tarball。
