<a id="releasing"></a>
# 发布维护

本页面向已获授权的维护者。**开发、验证、生成版本 PR、准备制品和发布是不同权限边界**；
普通维护不授权 workflow dispatch、npm 写入、资格变更或修改不可变发布记录。

当前受保护发布已启用，但只接受从 `main` 手动触发的 workflow、精确 `publish`
确认和 `npm-publish` environment 审批。Tools 首发与激活已经完成，不能再次 bootstrap。

| 你要做什么 | 从这里开始 |
| --- | --- |
| 发布常规版本 | [版本 PR → 受保护发布](#normal-release-flow) |
| 只发布一个包 | [定向发布](#targeted-package-releases) |
| 确认哪些检查能复用 | [源码证据与实际制品验证](#scoped-verification-and-trusted-source-reuse) |
| npm 成功但读回／tag／Release 失败 | [失败恢复](#recovery) |
| 新增从未发布的包 | [资格与一次性 bootstrap](#npm-bootstrap-and-trusted-publishing) |
| 查询历史首发、alpha alias | [历史记录](#workflow-state-and-historical-bootstraps) |

日常环境、检查和 changeset 要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。
以下流程不是发布授权，也不是对当前注册表或账号状态的实时确认。

<a id="normal-release-flow"></a>
## 版本 PR → 受保护发布

<a id="release-steps"></a>
### 1. 记录变更，审阅版本 PR

包行为、配置、依赖和随包发布的文档变更须附 changeset：

```bash
pnpm run changeset
pnpm run changeset:sync
```

同步器递归覆盖 runtime／optional 工作区依赖的消费者，包括 subagent 对兼容 bundle
的 optional 依赖。已有显式消费者 changeset 优先，不手改生成的
`.changeset/workspace-dependent-releases*.md`。

改动合并到 `main` 并通过 CI 后，`release-pr.yml` 创建或更新版本 PR，不重复运行 `ci`。
版本操作只能使用：

```bash
pnpm run changeset:version
```

该 wrapper 同步 changeset、执行 Changesets、修复精确 pin、拒绝依赖 pin 改变但消费者
未升级的情况，并刷新根锁。不要手改包版本、放宽 pin 或直接调用裸 Changesets version。
测试中的临时 fixture 版本升级不授权改动真实 alpha 版本；真实升级必须进入经审阅的版本 PR。

审阅版本和 changelog，批准该 PR 的 CI，再合并。使用 `GITHUB_TOKEN` 创建的 PR
可能需要维护者批准其 CI 运行。

### 2. 确认 Release PR 的 CI 证据

Release PR 只接受本仓库规范 CI 的成功 **main push** 运行。API guard 核实：

- workflow、repository 和 head repository 都来自本仓库；
- 当前 run／attempt 是该 SHA 最新的运行，且已成功，不重放旧成功 attempt；
- SHA 同时等于 live main 和原生 workflow context SHA。

PR、fork、过期、失败或被更新运行取代的 completion 均拒绝。guard 来自可信默认分支
workflow revision，不读取未验证触发 ref 的代码或上游制品。验证后 checkout 精确 SHA，
安装完成、Changesets 写入前再核实一次，不能伪造 `GITHUB_SHA` 让不相关 context 通过。

Release PR 运行串行化，但阻止不了最后一次检查之后的外部 main push。此时可能留下过期
版本 PR，仍须审阅并通过自身 PR CI；新 main 必须先通过 CI，才能更新其版本 PR。

### 3. 手动确认发布

在获授权后，从 `main` 手动运行 `.github/workflows/publish.yml`：

1. 全批发布时留空 `package`；单包发布时填[精确 scoped 包名](#targeted-package-releases)。
2. `confirm` 输入 **`publish`**，不能使用其他值。
3. 等待读验证 job 成功，再由维护者批准 `npm-publish` environment deployment。

workflow 中 `RELEASE_INFRASTRUCTURE_ENABLED: "true"` 不是充分授权。environment 必须
有维护者 reviewer、限制从 `main` 部署并设置 `NPM_PUBLISH_ENABLED=true`。
preflight 还要求仓库为 `oai404iao/omp`、checkout 干净、HEAD 等于 `GITHUB_SHA`，
并检查精确仓库元数据、包级 LICENSE、Codex notices／provenance 及其打包白名单。

### 4. 只发布已验证的精确字节

| 阶段 | 必须完成的工作 |
| --- | --- |
| 只读 verify job | 选择范围；核实可复用源码证据或重跑源码检查；fresh policy／production audit；要求干净 checkout；准备不可变制品；验证实际隔离安装；上传校验后的同一字节 |
| 受保护 publish job | 重新验证 manifest、消费者 receipt 和 tarball hashes；整批门禁通过后，依赖优先串行发布并读回每个精确版本 |
| 最终对账 | 所有候选的 source／integrity／dist-tag 一致后，原子推送包级 Git tags，按 changelog 创建 GitHub Releases |

验证 job 无 OIDC，只授予只读权限；受保护 job 使用 GitHub-hosted runner、
`id-token: write`、固定 **npm 11.19.0** 和 provenance，不读取 `NPM_TOKEN`，
不运行包生命周期脚本。开发、验证和锁更新仍使用固定 **pnpm 12.4.1**；npm 只是发布客户端。

制品准备与发布均采用稳定的依赖优先顺序。全批 manifest 必须包含全部工作区依赖，
已发布依赖以 `recover` 候选进入。发布器在第一次不可逆写入前验证整批；只有前一依赖
的精确 npm `gitHead`、SHA-512 和 dist-tag 可见后，才继续消费者。任何失败停止后续发布，
最终对账失败则不创建新 tags。Codex 兼容消费者须等 tools 的精确依赖已验证；
Codex 发布顺序中 minimal-tools 保持最后，之后才是受影响的 optional 消费者。

包级 Git tag 使用 Changesets 格式，例如 `@oai404iao/pi-subagent@0.3.0`。
预发布必须使用 prerelease SemVer 和 `next` dist-tag；稳定版使用 `latest`。
不要仅靠改 dist-tag 把实验包宣称为稳定；提升前须通过 clean-install smoke，并另获发布授权。

<a id="targeted-package-releases"></a>
## 只发布一个包

`publish.yml` 的可选 `package` 输入只接受一个精确 `publishable` 工作区名，
如 `@oai404iao/pi-subagent`。留空是全批发布。制品准备和受保护发布都执行同一选择，
不会改变包的发布资格，也不会顺便发布缺失的依赖。

### 准备只包含目标升级的版本 PR

1. 拆分共享 changeset，把其他包的待发记录暂缓，不要消费它们。
2. 用 `pnpm run changeset:version` 生成目标版本和 changelog，不能手改 manifest 版本。
3. 提交前恢复暂缓的 changeset，再运行 `pnpm run changeset:sync`。
4. 如果尚待发布的依赖又为刚升级的目标生成消费者 changeset，保留它供后续批次使用。

自动化可以继续更新暂缓的全批版本 PR，但完成定向发布前不要合并那个竞争的 PR。

### 依赖只能验证，不能补发

目标保留现有精确工作区 pin；所有传递 runtime／optional 工作区依赖必须已经在 npm
存在该精确版本。依赖以 `verify` 模式进入 manifest：

- 核实不可变 registry identity、SHA-512、release lock、源码 ancestry 和包身份；
- 其历史源码中的 `dependencies`、`optionalDependencies`、`peerDependencies` 和
  `peerDependenciesMeta` 必须与当前契约相同，版本号未变但契约已改也会阻止该路径；
- 不发布依赖，不创建它们的 tags／GitHub Releases，也不把依赖的未发源码重新打包来替代 npm 制品；
- 不要求当前 npm dist-tag 仍指向该历史精确依赖版本。

缺失或不匹配就停止，不回退到顺带发布依赖。目标本身恢复已发布版本时，仍受
[payload 不变门禁](#recovery)约束；`verify` 依赖不被伪装成当前 checkout 的恢复候选。

获授权的本地制品准备使用：

```bash
RELEASE_PACKAGE=@oai404iao/pi-subagent pnpm run release:artifacts
```

该命令要求干净 checkout，会读取注册表，并重建 `release-artifacts/`，但不发布。
实际 dispatch 仍要求 `confirm=publish`、验证成功和受保护 environment 审批。

<a id="scoped-verification-and-trusted-source-reuse"></a>
## 验证源码证据和真实制品

### 选择源码检查范围

```bash
pnpm run ci:release --package @oai404iao/pi-telegram-notify
pnpm run ci:release
```

单包命令检查目标及其规范 runtime／optional 工作区闭包；不带参数则检查全部 8 个
发布工作区，不包含私有本地通知。它不打包、不发布、不改版本、不绕过依赖前置条件。
仓库 policy 和发布基础设施回归始终保留；任何 Codex／subagent 选择仍运行完整源码
composition 和 consumer 套件。独立 Telegram 发布无需重跑无关 Codex 行为。

### 什么时候可省去源码行为重跑

只读 publish 验证 job 用 `actions: read` 查询规范 GitHub CI。仅当发布 SHA 的**最新
main push run／attempt**成功，且以下全部完成，才允许复用源码行为结果：

- 9 个包 job、3 个共享套件、3 个附加兼容角色；
- 4 个既有 aggregate contexts 和 `Trusted main coverage / v1`；
- `.github/workflows/ci.yml` 的内容匹配 `scripts/ci/trusted-main.mjs` 固定的已审阅 SHA-256；
- API 完整分页、repository／head 身份、每个 job 的 run／attempt／SHA 均一致；live main 仍等于发布 SHA。

手动 CI、PR、fork、旧成功 attempt、缺失／跳过 job、workflow 图改变或 API 不确定，
都不能授权复用：转为执行所选源码检查。修改 CI 图时须有意更新固定摘要和策略测试。

上传制品前会再次核实已复用证据；若失效，验证失败，须重新运行，不换成别的 SHA。
这个 helper 与 Release PR 的 `workflow_run` guard 分开，不消费上游日志或不可信结果制品。
即使源码复用，**fresh policy、audit 和实际制品验证仍然必跑**。

### 验证要发的组合，而非仅验证当前源码

仅在授权的制品准备完成后运行：

```bash
pnpm run release:verify-installations release-artifacts/manifest.json
```

| 对象 | 验证要求 |
| --- | --- |
| 新 `publish` 候选 | 使用准备好的精确 tarball |
| `verify`／`recover` 候选 | 使用核实 registry identity 和 SHA-512 后获取的不可变 npm archive，不能替换成 checkout 重打包 |
| 依赖契约 | 从各候选 source commit 读取 manifest；历史依赖／peer 必须适配审阅后的根锁，外部前置条件缺失或不符就停止 |
| 消费者 | 将已核实 archive 加入现有 store；投影 frozen lock、离线安装、禁用生命周期脚本；运行消费者自己的 Pi SDK loader，并禁用网络 |
| 组合覆盖 | 每个候选闭包、组合和反向加载、bundle inline exports；任何链接不得逃出消费者 |

`consumer-verification.json` 将 manifest、source commits、artifact hashes 与消费者绑定。
结束时再检查制品字节；上传和受保护 job 都验证 receipt 与待发 tarball hash。
注册表获取仅为只读、有界的 canonical npm artifact URL 访问，不是模型／端点测试。

源码构建的 `test:codex-packages` 是额外覆盖，不能证明历史 npm payload。
此流程不放宽 ancestry、精确 pin、不可变 lock、dist-tag／恢复规则、审批、OIDC 分离
或依赖优先串行发布要求。普通 CI 的 affected／target／floor 及复用契约见
[贡献指南](CONTRIBUTING.md#remote-ci-scope)。

<a id="recovery"></a>
## 失败恢复：先读状态，不重试不可逆写入

**永远不要覆盖 npm 版本。** 保留失败运行的日志、npm receipt 和已准备 manifest，
先查清版本、源码、integrity、dist-tag，再决定经授权的下一步。

| 失败表现 | 处理方式 |
| --- | --- |
| `npm publish` exit 0／receipt 成功，但读回缺失 | exit 0 不等于发布证据。检查 npm 输出和注册表状态，不能自动再 publish |
| 新发布版本暂不可见 | 只重试只读 registry 检查；默认每个新包最多等待 3 分钟，使用 `--prefer-online` 和有上限的指数退避 |
| release lock 已记为 published，但查询 E404 | 视为待验证，停止准备；不打包、不重发，不能删锁绕过 |
| 批次只发出一部分 | 停止后续发布，对账已发布包的 `gitHead`，不创建任何新 tags／Releases；干净重跑只发布仍缺失版本，恢复缺失 tags／Releases |
| `latest`／`next` 错误 | 失败并提示交互修复；OIDC workflow 和本地 verifier 都不静默改 registry tags |
| 相同版本的 tarball-facing 文件自 npm `gitHead` 后改变 | 拒绝恢复；添加 changeset，发布新版本，不把不同 payload 冒充恢复 |
| 已有 Git tag 指向错误源码 | 停止调查，不覆盖 tag 身份 |
| tags／GitHub Releases 最终化中断 | 对账全部通过后原子推 tags；已存在 Release 跳过，可安全重试最终化 |

发布器显式禁用继承的 npm dry-run 配置，并在 job 日志中保留 publish receipt。
成功 publish 后只重试读取，不盲目重复不可逆命令。传播等待由以下变量控制：

| 变量 | workflow 默认值 |
| --- | --- |
| `NPM_REGISTRY_PROPAGATION_TIMEOUT_MS` | `180000` |
| `NPM_REGISTRY_PROPAGATION_INITIAL_DELAY_MS` | `2000` |
| `NPM_REGISTRY_PROPAGATION_MAX_DELAY_MS` | `15000` |

release lock 比较注册表 `gitHead` 与 SHA-512，是已经发布的证据，不能修改已锁值来
“修好”失败。变更锁值必须另行开展 source／registry 调查；历史记录不能删除或替换。

若坏包已公开，优先发布修正 patch 或另行授权 `npm deprecate`，不要例行 unpublish。
npm ownership、provenance、源码权利、tag 身份或仓库元数据不确定时，保持发布 workflow
禁用，先解决不确定性；恢复流程不自动授予任何注册表操作权限。

<a id="package-publication-eligibility"></a>
## 确认发布资格

`@oai404iao` scope 不覆盖 `private` 或 release eligibility。资格必须在
`scripts/workspaces.mjs` 与包 manifest 中一致，CI 拒绝冲突：

| `releaseStatus` | `private` | 可进入的流程 |
| --- | --- | --- |
| `blocked` | 必须为 `true`，且只有此状态允许 | 不进入发布制品 |
| `bootstrap` | 非 private | 仅本地一次性 `release:bootstrap-artifacts` |
| `publishable` | 非 private | 正常受保护 workflow |

当前登记的 8 个工作区均为 publishable：6 个 Codex 包（runtime、core、tools、web-search、
imagegen、minimal-tools），以及 subagent、telegram-notify。本地通知不在发布工作区。
已移除的 external-thinking、keep-defaults、tree-continue 和未发布 Code Mode 实验不能进入新批次；
历史 release locks 仍保留。此清单描述仓库资格，不是实时 registry inventory。

包的 trusted publisher、environment 保护和 `NPM_PUBLISH_ENABLED` 是每次发布的前置条件，
所有未来发布仍须手动 dispatch 和维护者审批。配置读回不证明实际 OIDC 发布成功；
不能为了验证配置而虚构或覆盖版本。

公共和支持包的 peer 下限为 Pi 1.2.0，精确开发目标也是 1.2.0。
开放上界是有意的前向兼容策略，不是已验证所有未来 Pi 版本；新基线须经 CI 验证，
发现不兼容时收紧范围。更新基线要同步开发依赖、peer、锁、说明和测试，并运行
`pnpm run ci:pi-matrix` 检查实际 SDK 解析。详见 [Pi 兼容性](docs/pi-compatibility.md)。

<a id="npm-bootstrap-and-trusted-publishing"></a>
## 新包的一次性 bootstrap 与 trusted publishing

**这不是 tools 的当前待办。** 以下仅适用于经单独批准、尚未发布且明确登记为
`bootstrap` 的新包；现有包走常规发布／恢复。npm 包必须先存在，才能附加 trusted publisher。

1. 重新核实包名可用性和所有权，完成权属审计及[一次性仓库准备](#one-time-github-preparation)。
2. 从刚获取的公共 `main` 上可达、经审阅且干净的 commit 准备制品；该源码必须留在公共历史。
   通常先 `git fetch github main`、checkout `github/main`，完成 frozen install 和 `pnpm run ci`。
3. 使用本地 `pnpm run release:bootstrap-artifacts`；可用 `RELEASE_PACKAGE` 指定精确 bootstrap
   目标。定向选择要求已发布／publishable 的完整依赖闭包和精确 pin；依赖只验证，只有目标打包。
   GitHub Actions 禁止准备 bootstrap 制品，受保护 publisher 也不能发布 bootstrap 包。
4. 维护者以交互式 2FA **只发布 manifest 指定的目标 tarball**，使用 `--access public`
   及 manifest 的 `distTag`：预发布 `next`、稳定版 `latest`。不要从源码目录发布，
   不要运行全批 publisher，不要显式用 `--tag latest` 发布预发布。
5. 读回精确版本、`gitHead`、SHA-512、完整版本历史和 tags，匹配准备好的 manifest。
   不把可见性延迟当成重发许可；不要把 bootstrap token 存进 GitHub。
6. 配置该包的 GitHub Actions trusted publisher：repository `oai404iao/omp`、
   workflow `publish.yml`、environment `npm-publish`、allowed action `npm publish`。
   environment 要求维护者审批、仅 main 部署和 `NPM_PUBLISH_ENABLED=true`。
7. 单独提交并审阅 `bootstrap` → `publishable` 激活变更，把已验证 source／SHA-512
   追加到 `release-locks/npm-published-artifacts.json`；不能覆盖历史项。
8. 激活后才可 dispatch 受保护 workflow，对账缺失 Git tag／GitHub Release。
   若首发时能一并创建则优先完成；恢复要求 npm `gitHead` 是可达祖先，且该提交的包名／版本一致。
9. 验证 OIDC 后限制传统 token 发布并撤销 bootstrap 凭据。

新包若被 npm 自动赋予初始 `latest` alias，必须另行审阅精确 identity／history 例外，
不能套用历史 Codex 例外，也不能删除 tag、unpublish、重发或造一个 dummy stable 版本。

### 仅尚未首发时保留初始版本

经授权的前置版本准备可用 wrapper 的
`--preserve-bootstrap-version <exact-name>` 选项。它在写入前核实非 private bootstrap
资格、immutable lock 中无该包发布历史、注册表确认从未发布，且与待发 changeset 有关；
Changesets prerelease mode 不支持此选项。随后正常运行 Changesets，仅恢复被核实目标
的初始版本，仍修复精确 pin 并要求其他消费者升级。

它不是回滚版本或跳过消费者升级的通道，任何已发布历史都会拒绝；**不得再用于 tools**。
相关命令会联网核实前置条件，不能在普通文档或维护任务中顺手执行。
暂缓无关 changeset 时，沿用[定向发布](#targeted-package-releases)的恢复／同步步骤。

<a id="one-time-github-preparation"></a>
## 一次性仓库准备参考

公共仓库为 `oai404iao/omp`，初建时没有额外 README／license commit。
保留原 Gitea remote，GitHub 使用独立 remote；完成
[publication readiness 审计](docs/audits/publication-readiness.md)。不要重复初始化现有仓库。

每个 npm 包必须有精确元数据：

```json
{
  "repository": {
    "type": "git",
    "url": "git+https://github.com/oai404iao/omp.git",
    "directory": "pi-extensions/<package>"
  },
  "homepage": "https://github.com/oai404iao/omp/tree/main/pi-extensions/<package>#readme",
  "bugs": { "url": "https://github.com/oai404iao/omp/issues" }
}
```

每个 tarball 保留经审阅的包级 LICENSE 和第三方 notices；不要只根据 manifest 字段推断权属。
保护 `main`：要求 PR 和 CI，阻止 force push／删除分支，workflow 改动须审阅。
允许 Actions 创建 release PR；这不替代 PR CI 审批或 protected environment。

官方参考：[trusted publishing](https://docs.npmjs.com/trusted-publishers/)、
[npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)、
[provenance](https://docs.npmjs.com/generating-provenance-statements/)。

<a id="workflow-state-and-historical-bootstraps"></a>
<a id="codex-bootstrap-activation"></a>
## 历史首发与激活记录

以下是已记录的检查点，不是待执行步骤、当前 registry inventory 或新的发布批准。
早期 alpha 准备共 9 个包，激活批次为 4 个不可变 `recover` 依赖加 5 个 `publish` 候选；
当前资格已调整为前述 8 个工作区。不要重新发布首发四包或让移除包进入新批次。

| 历史检查点 | 源码 commit／证据 |
| --- | --- |
| keep-defaults、telegram-notify 首发 `0.1.2`，npm gitHead／包 tag／GitHub Release 一致 | `0c53bdb9e13b006a23a8da05a01c06f106fa2c10` |
| 上述两包后续稳定版 `0.1.3` | `16dccb8953b717670c34fe978c79c07d592ca7e2` |
| external-thinking `0.1.0`，npm gitHead／tag／Release 一致，现已移除 | `aae803f4b25603991d9375c602cf35da1df922b0` |
| subagent `0.2.0`，当时已核实 gitHead／latest，已配置 trusted publisher | `ef42984c0e40ef1f26ead4b4c7d149b21280e66b` |
| minimal-tools `1.3.0` 手动 bootstrap，后进入 guarded artifacts | `596d799c6f7db3508b6d46bb05cdca6ea9e3b716`；Apache source map 在 runtime `provenance/`，Responses Lite 边界保留在包 README／notice |
| runtime／core／imagegen／web-search `0.1.0-alpha.1` 手动首发，identity、下载 tarball SHA-512、trusted publisher 已核实 | `32ba01f3c08b7fd63d09e9b2373cf081c4525533`；[激活审计](docs/audits/codex-bootstrap-activation.md) |
| tools `0.1.0-alpha.1` 手动首发及独立激活完成 | `b9deaba6ba07d87c048e474b2ddc977f3bd2b442`；[tools 激活审计](docs/audits/codex-tools-bootstrap-activation.md) |

S4 建立递归精确 pin changeset、依赖优先制品和无外链的隔离生产消费者；这些测试不授权
registry 写入，也不证明真实账号／模型可用。有限真实 bootstrap smoke 的 harness／覆盖限制
见激活审计，不是通用端点验收。[早期 alpha 准备审计](docs/audits/codex-alpha-release.md)
保留为历史检查点；组合测试边界见 [Codex 包结构](docs/codex-packages.md)。

<a id="codex-tools-first-publication"></a>
<a id="codex-tools-first-publication-and-activation"></a>
### Tools 首发已完成：后续只走 guarded workflow

Tools 已设为 `releaseStatus: "publishable"`，已记录不可变 source／integrity，
公开 tarball、history／tags 和 trusted publisher 已验证。现有版本的 workflow 运行
只能恢复；未来新版本须另行授权，**不能再运行 tools 本地 bootstrap 或保留首发版本命令**。

历史迁移顺序是 runtime → core → tools 首发 → tools 独立激活 → web-search／imagegen
兼容消费者 → minimal-tools → 受影响 optional 消费者。前置版本 PR 同步消费者 pin／升级
不代表能提前发布消费者；当时要求暂缓无关 Telegram changeset、不得合并竞争的全批版本 PR。
首发到激活的前置步骤已完成，消费者仍须各自获授权的受保护 dispatch，不能把历史次序
当成自动执行队列。

<a id="initial-codex-latest-alias"></a>
### 初始 alpha 的 `latest` alias 例外

npm 元数据要求 `latest`，首个 runtime 的 `next`／`latest` 都指向唯一 alpha，
删除 `latest` 曾返回 E400。例外记录在 `scripts/initial-codex-bootstrap.mjs`，严格限于：

| 包／版本 | 精确源码与允许历史 |
| --- | --- |
| runtime／core／imagegen／web-search `0.1.0-alpha.1` | `32ba01f3c08b7fd63d09e9b2373cf081c4525533`；仅此一个可见版本，`next=latest=0.1.0-alpha.1` |
| tools `0.1.0-alpha.1` | `b9deaba6ba07d87c048e474b2ddc977f3bd2b442`；历史精确为 `0.0.0-stage` 和该 alpha，`next=latest=0.1.0-alpha.1` |

Tools 的 `0.0.0-stage` 是 npm 标为 `stub:true` 的 staged-publication placeholder，
不是第二个工具实现版本。不推断是谁创建／批准 stage，也不允许为其他包过滤 placeholder。
见 [npm registry schema](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md#package)
及 [staged publishing](https://docs.npmjs.com/staged-publishing/)。

guarded publisher 仅对**已发布的 `recover` 候选**，且 release lock 的 gitHead／integrity
匹配时接受 alias；缺 lock、历史缺失／畸形、其他包／后续版本、错误 `next` 都 fail closed。
历史四包仍要求 sole-version-only，tools 例外不能扩散；已有稳定包的 prerelease／latest 禁令不变。
进入消费者前和最终对账时都会检查 tags，publisher／本地 verifier 均不修改 registry tags。

本地交互 bootstrap verifier 在验证制品与发布身份后使用同一 tag predicate，
但不能要求尚待验证后才追加的 release lock。见[修正记录](docs/audits/codex-bootstrap-latest.md)。
这些 alias 不表示 alpha 已稳定；无版本安装可能解析到 alpha，用户应选明确 `@next` 或精确版本。

<a id="pi-0861-migration-release-note"></a>
### Pi 0.86.1 迁移公告保留项

迁移公告须说明 `@oai404iao/pi-keep-defaults` 已退出仓库和未来批次，最后记录的稳定版为
`0.1.3`；不生成新的退休包版本或 changeset。用户须卸载并**完全重启 Pi**，`/reload`
不能可靠撤销旧进程级 patch：

```bash
pi remove npm:@oai404iao/pi-keep-defaults
```

项目本地安装加 `-l`，本地路径安装则移除配置来源。Pi 0.86.1 将普通模型／thinking
变更保持在 session 内，但故意不保留旧 settings watcher 对显式保存和外部编辑的更强保护。
这是历史迁移说明，当前支持基线见 [Pi 兼容性](docs/pi-compatibility.md)。

移除工作区不会修改已有安装，不执行 npm deprecate／unpublish，也不会给 npm 用户提供
registry 级弃用警告；任何此类操作都需要另行发布授权。
