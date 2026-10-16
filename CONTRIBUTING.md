<a id="contributing"></a>
# 参与维护

本仓库是 Pi 扩展的 pnpm 发布工作区，不是单个应用。先读根目录
[AGENTS.md](AGENTS.md)，修改扩展前再读该包的 `AGENTS.md`。
发布操作另见[发布指南](RELEASING.md)；完成开发或检查不代表获得发布权限。

## 完成一次日常修改

1. [安装锁定依赖](#setup)。
2. 修改实现，并运行[对应包的检查](#checks)；跨能力行为测试放在 `tests/codex/`。
3. 涉及包行为、公开配置、依赖或随包发布的文档时，[添加 changeset](#changesets)。
4. 提交 PR 前运行 `pnpm run ci`；Pi 兼容性改动还须运行 `pnpm run ci:pi-matrix`。
5. 在 PR 中说明改动、实际检查结果和未覆盖范围，按[提交清单](#pull-requests)自查。

<a id="setup"></a>
## 安装开发依赖

使用 Node.js **>=22.19.0** 和仓库固定的 **pnpm 12.4.1**。在仓库根目录运行：

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

`pnpm-workspace.yaml` 定义发布工作区；根目录 `pnpm-lock.yaml` 是唯一项目锁文件。
不要新增 npm 锁文件或包级锁文件。`pi-local-notify` 是本地私有扩展，不在发布工作区内，
检查时使用根目录安装的工具。

<a id="checks"></a>
## 选择要运行的检查

开发时先做受影响检查，提交 PR 前做完整检查。以下命令均从仓库根目录执行。

| 要做什么 | 命令 |
| --- | --- |
| 检查一个发布工作区包 | `pnpm --filter @oai404iao/pi-codex-tools run check`（替换包名） |
| 检查本地通知 | `pnpm run check:local-notify` |
| 检查所有包，包括本地通知 | `pnpm run check` |
| 检查 Codex 模块边界 | `pnpm run check:architecture` |
| 检查跨包组合行为 | `pnpm run test:codex-composition` |
| 检查源码构建的隔离 tarball 消费者 | `pnpm run test:codex-packages` |
| 检查许可证／实际打包文件 | `pnpm run license:check` / `pnpm run pack:check` |
| 检查发布基础设施／CI 规划器 | `pnpm run test:release-scripts` / `pnpm run test:ci` |
| 提交 PR 前完整验证 | `pnpm run ci` |
| Pi 兼容性改动的附加验证 | `pnpm run ci:pi-matrix` |

各包的 `check` 包含类型检查，以及该包已有的测试。纯组合包的检查刻意只做类型检查，
不复制实现所属包的行为测试。`pack:check` 检查 npm tarball 的精确文件清单，
确保扩展入口和运行时资源都被包含；更改打包路径或入口时必须运行。

`ci` 先执行仓库策略，再以有界任务池运行 **9 个包检查和 3 个共享套件**，
覆盖完整参考计划。外层并发默认 2，可用 `pnpm run ci --concurrency 2` 调整为 1–8。
包内测试也可能并发，提高外层并发前先检查内存占用。普通 CI 不执行真实模型测试；
未经明确授权，不要运行 live model 测试。fixture 通过不能证明真实端点或账号权限可用。

### 验证 Pi 兼容性

当前 peer 下限（floor）和精确开发目标（target）均为 **Pi 1.2.0**，
但保留两种锁验证角色：target 使用已提交的根锁，floor 重新生成投影锁。
矩阵在独立副本中运行，不修改工作树；它复制的是**受 Git 跟踪的工作树文件**，
因此新增源码须先暂存。floor 准备过程可能读取注册表元数据。

更新 Pi 基线时，一并更新开发依赖、peer 范围、锁文件、兼容说明和测试，
不得把最低版本降到已测试基线以下。检查会验证实际解析到的 SDK，不只看 peer 声明。
日志、复用条件和测试限制见 [Pi 兼容性](docs/pi-compatibility.md)。

### 排查隔离消费者失败

先完成根目录的 frozen install，填充 pnpm store。消费者从本地 Codex tarball
和根锁投影构建生产安装，外部依赖只能来自锁定的注册表制品：

```bash
pnpm install --offline --prod --frozen-lockfile --trust-lockfile --ignore-scripts
```

这是 **fixture 内部的安装命令**，不要用它替代根目录开发安装。`--trust-lockfile`
只跳过 pnpm 的注册表元数据策略复查，不跳过 frozen lock 或制品完整性检查。
每个消费者运行自己的 Pi loader；允许 pnpm 内部软链接，但链接必须留在该消费者内，
不能指回源码仓库或其他外部目录。缺少 store 制品是前置条件失败，不能改为联网下载、
重新解析依赖或放宽隔离。

<a id="changesets"></a>
## 记录包级变更

包行为、公开配置、依赖或随包发布的文档变更都需要 changeset：

```bash
pnpm run changeset
pnpm run changeset:sync
```

仅修改仓库文档、测试或基础设施时不需要 changeset，除非同时改变了发布包。

`changeset:sync` 沿 `dependencies` 和 `optionalDependencies` 递归补齐消费者版本记录；
已有显式消费者 changeset 优先。不要手改生成的
`.changeset/workspace-dependent-releases*.md`。预发布迭代使用不同 ID，
保留 `.changeset/pre/` 中已消费的历史。CI 中的 `changeset:check` 检查覆盖和精确版本 pin。

**不要手改包版本，也不要放宽工作区依赖的精确 pin。** 经授权的版本 PR 使用
`pnpm run changeset:version`：它依次同步消费者 changeset、运行 Changesets、
修复精确 pin、验证消费者已升级，并刷新根锁。不要直接运行裸 Changesets version。
尚未首发的 bootstrap 包有严格受限的一次性例外，见[发布指南](RELEASING.md#npm-bootstrap-and-trusted-publishing)；
已首发包不能借用该例外。

<a id="pull-requests"></a>
## 提交 PR 前自查

- 尽量分开插件行为修改与发布基础设施修改，不在无关 PR 中开启发布 workflow。
- 不提交凭据、真实 Telegram 配置、provider token 或私有端点。
- 使用 Pi 内部 API 时，说明依赖原因和已测试 Pi 版本。
- 复制或适配上游材料时，记录精确源码 revision、许可证和必要 notices；
  不凭 manifest 中的作者／许可证字段推断完整权属。
- 保留 manifest 的 `files` 白名单；不要把 `AGENTS.md`、测试或私有配置放进 tarball。
- 说明实际执行了哪些检查、哪些未执行；不要把源码 fixture 成功说成实际发布或端点验收。

以下是按需查询的检查契约，通常无需先读完再开始开发。

<a id="focused-verification-and-timings"></a>
## 按 Git revision 规划检查

```bash
pnpm run ci:plan --base origin/main --head HEAD --shadow
pnpm run ci:affected --base origin/main --head HEAD
pnpm run ci:release --package @oai404iao/pi-telegram-notify
```

revision 计划比较不可变 Git 提交，**不包含已暂存或未暂存的本地改动**。
开发未提交代码时，用包的直接检查或完整 `ci`。`ci:plan` 输出选择／全量回退原因，
`--shadow` 额外比较所选数量与全量参考。执行器输出每项耗时；需要机器可读报告时加
`--report <path>`，将报告放在仓库外的任务专属临时目录。

规划器的选择规则：

| 改动／状态 | 检查范围 |
| --- | --- |
| 包目录改动 | 该包，以及在 merge base 和 head 两份依赖图中的递归消费者 |
| 任意 Codex 包或 subagent 被选中 | 加入完整 composition 和 exhaustive 源码消费者套件 |
| `tests/codex/` 改动 | composition 和 consumers |
| 共享基础设施、锁／工具链、未分类路径 | 全量回退 |
| 明确分类的仓库文档、changeset Markdown | 可以只运行 policy |
| Git 历史不足 | 全量回退 |
| 包注册或计划非法 | 失败，不静默跳过 |

依赖图包含 runtime、optional、dev 和 peer 边；重命名同时考虑旧、新路径。
新增包目录必须注册，即使它只是非发布测试目标。

`ci:release` 不带 `--package` 时选择 8 个发布工作区，排除私有本地通知。
它只验证源码，不打包、不发布、不改版本；定向依赖闭包和复用规则见
[发布验证](RELEASING.md#scoped-verification-and-trusted-source-reuse)。

<a id="remote-ci-scope"></a>
## 理解远程 CI 的覆盖范围

| 触发方式 | 行为覆盖 |
| --- | --- |
| PR | affected 计划，仅 Node 24 / Pi target |
| main push、手动 CI | 全量计划，Node 22.19.0 / 24.x × Pi floor / target |

仓库 policy 和 production audit 每次都运行。policy 成功后，选中的包和共享套件
分别进入有界矩阵。main 的完整检查仍可能在合并后发现 PR 范围之外的兼容回归。

Node 24/target 的规范检查直接使用已提交根锁和独立 agent 目录，在包／套件 job 中只执行一次；
选中 consumers 时始终 exhaustive。其他 3 个兼容角色保留独立快照和锁准备，使用
`OMP_CODEX_CONSUMER_MODE=smoke`：仍打包全部 6 个 Codex 包，验证隔离 bundle 的实际
SDK、loader 和 inline re-export。普通本地 `ci`、`test:codex-packages`、`ci:pi-matrix`
默认保持 exhaustive；非法 consumer mode 直接失败。

### floor 什么时候能复用 target

远程 CI 显式设置 `OMP_PI_REUSE_TARGET=1`。只有**同一源码、同一 Node 版本**的完整
target 成功是强制伴随条件，且 Pi 版本、所有投影工作区／根 manifest、完整应用锁均相等时，
floor 才能复用行为测试。只比较版本号不够。

即使复用，floor 仍重新生成锁、验证 integrity、frozen install、检查实际 SDK／CLI、
检查打包并运行隔离消费者 smoke。任一输入不同就执行该角色所配置 consumer mode 的完整套件。
最终 aggregate 要求伴随 target 的完整覆盖；不能脱离它单独启用 floor 复用。
本地显式启用复用的 `all` 先运行 target，target 失败绝不复用。

### required contexts 和证据

4 个既有 `Node … / Pi …` required contexts 都是计划聚合门禁，不代表 PR 额外跑了
4 份兼容检查。计划任务失败、取消、缺失或意外跳过时，聚合失败；文档-only 的空选择
须显式验证。无需改变 branch protection，但不能用 workflow 级 path filter 跳过这些 contexts。
main push 另产出 `Trusted main coverage / v1`，供发布时验证源码覆盖。

CI 上传包／套件耗时。调整分片时同时比较 wall time 和总 runner minutes，不必随包增长
就新增 runner。setup action 只缓存 pnpm store，不缓存可变 `node_modules` 或测试结果。
Release PR 仍等待**当前精确 SHA** 的可信 main CI；发布可复用经验证的源码覆盖，
但必须重新做 policy／audit 和真实不可变制品组合验证，见[发布指南](RELEASING.md)。

### 保守回退 CI 优化

PR 改用 `--full`，并移除 publish 的源码复用条件，让选中检查总是执行。
保留聚合门禁、制品消费者和所有发布安全门禁。修改 workflow 后，必须有意更新
`scripts/ci/trusted-main.mjs` 的已审阅 workflow 摘要及策略测试；摘要不符时拒绝复用。
4 个 required 名称和独立 Release PR 触发器无需改变。

<a id="dependency-pr-refreshes"></a>
## 处理依赖更新 PR

Dependabot 保持每月发现版本、原有 PR 数量限制和分组，但 npm／GitHub Actions
关闭自动 rebase。每周查看待处理更新，准备合并或严格 up-to-date 检查要求更新时，
请求 `@dependabot rebase`。紧急安全更新立即处理；安全告警、更新创建、依赖检查和
audit 门禁均未关闭。旧 PR 在创建后 30 天内仍可能继续自动 rebase，见
[Dependabot rebase 策略](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#rebase-strategy)。

## 查询 Codex 架构限制

`check:architecture` 检查本地模块边（包括 type import）、兼容入口的反向依赖、
直接／传递层级限制和源码行数。provider runtime 不得通过中间模块绕到工具实现或
本地图像／主题工具。新 Codex 源码模块上限 400 行；现有超限例外记录在
`scripts/codex-architecture.json`，应缩小或移除，不能扩张。

仅开发使用的 `typescript-ast` alias 提供 TypeScript 5.9 compiler API 做语法解析，
不替换工作区的 TypeScript 7 编译器。组合、broker 和生命周期改动另见
[Codex 包结构](docs/codex-packages.md)。
