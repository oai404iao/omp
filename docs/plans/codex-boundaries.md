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

目标包（尚未创建或发布）：

| 包 | 所有权 | dependencies | Pi peers |
|---|---|---|---|
| `@oai404iao/pi-codex-runtime` | 无自动注册的 auth/header、profile/catalog、identity、共享协议及资源服务 | 仅自身实际 runtime 依赖 | 使用到的 Pi API，floor 0.84.2 |
| `@oai404iao/pi-codex-core` | transport、patch/view-image、compaction、identity hooks | runtime 精确版本 | AI / coding-agent / TUI |
| `@oai404iao/pi-codex-web-search` | reserved web endpoint、工具、activity | runtime 精确版本；**不依赖 core** | 实际使用的 Pi peers |
| `@oai404iao/pi-codex-imagegen` | reserved image endpoint、background jobs、保存/展示 | runtime 精确版本；**不依赖 core / web-search** | 实际使用的 Pi peers |
| `@oai404iao/pi-codex-minimal-tools` | 保留旧安装入口与默认行为的兼容 bundle | core、web-search、imagegen 精确版本 | 保留已有 peers |

runtime 是纯库，不声明 `pi.extensions`，不能成为另一个 god package。
若不需要共享某一实现，应留在能力包中而不是提前塞入 runtime。
图方向为 bundle → capability → runtime；capability 之间不互相依赖。
先保留旧包名，不同时再创建第二个功能相同的 bundle。

文件迁移候选：

- `tools/web-search.ts` + `tools/web-search/*` → web-search；
- `tools/image-generation.ts`、`background-image-generation.ts`、
  `tools/image-generation/*` → imagegen；
- `utils/images.ts` 中 view-image 也使用的操作先分解，不能整文件归 imagegen；
- `codex-http.ts`、`provider-headers.ts`、request-profile/catalog 和 wire identity
  → runtime；schema 按实际设置所有权拆分，旧配置由 bundle 兼容读取；
- `codex-reserved-tools.ts` 分成单工具协议资产，保留每份 Apache notice、
  revision 和 fingerprint；不得复制两份后独立漂移。

## Seam 与 identity

- runtime 拥有 Codex wire `SessionId / ThreadId / TurnId` 的生成、持久化映射
  和请求语义；core 安装生命周期 hook；subagent 仅提供父子关系和任务生命周期。
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
- 最终锁文件的干净 `npm ci --ignore-scripts && npm run ci` 通过，共
  420 项测试，另有所有 workspace 类型检查、license 和 pack 检查。
  `npm run changeset:status` 确认本次 Codex patch changeset；
  未运行 version/publish，既有 subagent changesets 未改动。
- Pi 0.84.2 CLI 在临时空 agent 配置、offline、禁用自动发现、显式 `-e`
  加载入口的 `--list-models` smoke 退出 0，无 extension load 错误；
  未登录时返回没有可用模型是预期结果。此项不等同于真实账号端点测试。
- 根开发依赖新增 `typescript-ast`（TypeScript 5.9.3 的 npm alias）仅供
  AST 依赖检查；各 workspace 仍用 TypeScript 7.0.2。锁定的 Pi
  0.84.2 及所有已有运行时依赖版本未升级。

### 剩余工作（不能标记为已完成）

- S2：registration 中的 startup prewarm 和 image display 队列仍由
  同一个工厂闭包持有；将其拆成独立生命周期服务，再做 capability 注入。
  当前 `captured-stream.ts` 仍直接调用图片存储，尚不能声称 core 无 image 依赖。
- S3/S4：新 npm 包、独立安装能力、幂等 broker、聚合精确 pin 脚本和
  隔离消费者安装矩阵尚未实施；上面的名字/映射是目标设计，不是已发布接口。
- S5：尚未升级 Pi 或宣称 0.85.x 验证通过，floor/target 双基线待单独实施。
- 四个历史模块保留明确行数预算：catalog 636、wire identity 596、
  background image 574、standalone web-search 554。预算不自动扩张；
  后续按归属拆分时同步降低或删除例外。
- 新的包级 `AGENTS.md` 和本计划均为维护文档；pack 检查禁止发布
  AGENTS、tests、reference 及 `docs/audits|plans`，并核对 Codex 全部 TS
  runtime 模块确实进入 tarball。
