<a id="codex-package-composition"></a>

# Codex 包组合

按需要组合引擎与工具，或使用完整兼容包。包拆分提供实现与依赖边界，
不是新的沙箱、账号授权或网络隔离。初次加载见[快速开始](quickstart.md)。

<a id="ownership"></a>

## 选择最小组合

以下包均使用 `@oai404iao/` scope，内部依赖版本精确固定：

| 包 | 拥有什么 | 工作区依赖 |
| --- | --- | --- |
| `pi-codex-runtime` | 配置/catalog、认证辅助与 headers、身份、回放契约、broker | 无；库，不声明 `pi.extensions` |
| `pi-codex-core` | 唯一 Responses 引擎，Standard/Lite、SSE/WS、预热、原生压缩、诊断与 Fast 命令 | runtime |
| `pi-codex-tools` | 分开的 patch、web-search、standalone imagegen 模块，含 grammar、执行与展示 | runtime |
| `pi-codex-web-search` | 只加载搜索的兼容入口 | tools |
| `pi-codex-imagegen` | 只加载图像生成的兼容入口 | tools |
| `pi-codex-minimal-tools` | 默认完整组合与公开 `subagent-inline` 转导出 | runtime、core、tools |

在仓库根目录试用完整组合：

```bash
pi -e ./pi-extensions/pi-codex-minimal-tools
```

或仅组合 core 与 tools：

```bash
pi -e ./pi-extensions/pi-codex-core -e ./pi-extensions/pi-codex-tools
```

Core 不注册三类工具，也不加载图像存储或搜索展示实现；保留历史 web/image 项的协议与回放知识。
搜索/图像兼容入口会安装统一 tools 依赖，但只加载选定能力。禁用能力不是依赖安装隔离。
本项目不接管无关的同名工具，本地图片查看使用 Pi 原生 `read`。

包发布 TypeScript 源码，供 Pi/TS-aware loader 使用，不承诺 plain Node 可直接导入。
`./internal/*` 仅服务内部装配与 owner tests，不是稳定公共 API。
旧组合包的公开 `./subagent-inline` 保留，转发 runtime 同名 subpath。

<a id="model-and-configuration-behavior"></a>

## 配置与模型选择

所有组合继续读取同一份配置：

```text
<codex-agent-dir>/extensions/pi-codex-minimal-tools/config.json
<codex-agent-dir>/extensions/pi-codex-minimal-tools/models.json
```

Runtime 拥有唯一 schema 与默认 catalog。目录解析和常用开关见[配置](configuration.md)；
不要按能力包另建配置目录，也不要把 Pi 项目设置的优先级推断为插件自有配置的项目覆盖。
新配置使用 runtime 的 schema URL，旧的版本固定 bundle schema URL 不改写。

组合包保留工具名、包工具激活、命令、schemas、保存消息类型和 wire formats。
Patch 通过 Pi `prepareLoadout` 隐藏选中的原生修改工具声明，不从 active set 删除工具。
原生调用仍留在 transcript 中供树导航/恢复，codemode 仍可调用它们。
未知或显式禁用的模型保持 Pi 原生实现；core 的 stream shim 不替代 Pi 认证和模型注册。

### 精确模型 profile

| Provider / 模型 | 当前策略 |
| --- | --- |
| `openai/gpt-6.1-sol` | 显式继承 `openai/gpt-5.6-sol`：Lite、auto WS/SSE、预热、standalone 搜索/图像、custom patch、native Responses 压缩与 Fast 可用性（priority、2x 成本乘数） |
| `openai/gpt-6-astra`、`openai/gpt-6-sol`、`openai/gpt-6-luna` | Pi Standard Responses 描述符；默认 SSE、local custom patch；远程工具、native 压缩、预热与 Fast 默认关闭 |
| `openai-codex/gpt-6-astra`、`openai-codex/gpt-6-sol`、`openai-codex/gpt-6-luna` | 保留精确匹配的旧 Lite profiles；provider 已冻结，不按家族名扩展支持 |

上述继承和 Fast 倍数是兼容策略，不是实际账号权限或价格核验。Pi 拥有模型描述、认证和解析地址。
不同 provider 的相近模型名不互相继承，没有 `openai-codex/gpt-6.1-sol` 自动映射。
详见 [Pi 兼容性](pi-compatibility.md)。

### 全局与模型开关

`applyPatch`、`webSearch`、`imageGeneration` 为默认开启的全局能力门禁。
关闭后跳过该能力工具、命令、专用 renderer，并阻止新任务/请求；历史回放保留。
图像开关不影响图像输入、Responses 模式、压缩或其他工具。

模型层仍决定 patch `function` / `custom`、搜索 `standalone` / `hosted` 与 standalone 图像。
旧 `applyPatchEnabled` / `webSearchEnabled` 先投影为模型覆盖，再与全局门禁相交，
因此全局 `false`、总开关 `enabled:false`、显式禁用模型都不能被其他开关绕过。
全局 `webSocketEnabled:false` 强制 SSE 并关闭 WS 预热，但不改写 catalog。

<a id="migration-from-core-owned-patch"></a>

## 从旧组合迁移

Core 已不再拥有 patch。需要补丁时同时加载 tools，或继续使用 broker-enabled 完整组合包。
原搜索/图像包是选择性入口，不是实现副本。

| 能力 | 不加载 core 时 |
| --- | --- |
| Function patch | Provider 支持 function tools 时可运行 |
| Custom patch | 需要实际加载支持该模型/协议的引擎，不能只写 profile |
| Standalone 搜索/图像 | Catalog 支持时直接执行，从 Pi model registry 取得认证与地址 |
| Hosted 搜索 | 未加载兼容引擎时不激活，显式调用会报告缺少 core |
| Hosted 图像、direct image fallback | 已移除，不能回退执行 |

缺少认证会返回工具错误，不会尝试另一账号，也不会从独立环境密钥或别的 provider 强制取地址。
维护 route 为 `openai`：API key 与 ChatGPT OAuth 均遵循 Pi 原生认证及默认 `/v1/responses`。
`openai-codex` 仅为冻结兼容路径；插件 route overrides 只作用于这一旧 provider。

Standard/Lite、可选 Codex request 增强、SSE/WS/auto、Pi/native 压缩互相独立。
关闭增强时 Lite 仍保留 `additional_tools`、namespaces、transport signals、`reasoning.context`
及禁 hosted/parallel 限制，只移除可选身份元数据，不改 Pi 认证、端点或强制 WS。
端点模式/传输白名单拒绝能力时不会暗中选择另一实现。
内部 Lite 与 reserved endpoints 仍是非官方兼容面，fixture 成功不证明账号有访问权。

### 保留历史检查点

新全局门禁不改变 catalog profile hash。切换到 Pi 压缩生成也不意味着可删除已有 opaque checkpoint。
兼容回放仅接受完整 profile 匹配、仅从 Responses 生成切至 Pi 生成，或已明确审查的历史 bundle hash。
旧 `:wire-off` transport-cache 后缀会归一化，新 checkpoint 保存不带后缀的 catalog 身份。
其他 model/provider/API/profile 变化仍拒绝不透明回放；未知自定义 hash 不作宽松放行。

请求序列化对齐 Codex `5a314017`，已移除选项见[协议对齐与迁移](codex-wire-alignment.md)。

<a id="broker-and-lifecycle-contract"></a>

## Broker 与生命周期

`pi.events` 通过 `@oai404iao/pi-codex:broker` 同步发现共享 session service。
API wrapper 和模块路径可以不同；一个服务只认领一次 package ownership，合作包不会重复安装
provider、工具、命令、renderer 或身份 hooks。

握手要求 **ABI v2 和相同 runtime 包版本**。混合版本显式失败，不按加载顺序决定 catalog 语义。
发现 channel 与 cache key 保持稳定以检测旧 ABI，而不是建立平行 broker。
仅支持新 broker-enabled bundle 与兼容能力版本重复安装；旧单体工厂不参与握手。

Tools 发布带所有权的协议描述符。Core 为 ordinary、prewarm、compaction 请求捕获经过所有权检查的
declaration/input 映射，不拥有 grammar 资源或工具 executor。
首个包拥有共享 activation/presentation hooks，后加载 core 将 transport 连接到已有 presentation service。

流副作用在 I/O 前快照 contributions 与 image sinks。Observer 属于单次 response attempt，
在归一化/continuation 捕获后、回放前运行。New/fork 会使 display sink 失效；abort 阻止新的图片写入和完成通知。
单纯 clear session 不取消也不回滚文件写入。

Shutdown 断开发现、flush/clear 展示、取消后台 jobs 并重置 core 的预热/传输。
Pi runtime 失效还会移除跟踪的 bus subscriptions；即使宿主复用事件总线，reload 也会发现新 service。
`/image-gen` 的状态和取消属于具体实例，session replacement/shutdown 抑制晚到结果；
已开始的服务端生成或文件写入不能撤销。

<a id="verification"></a>

## 验证组合而非猜测支持

在仓库根目录运行：

```bash
pnpm run test:codex-composition
pnpm run test:codex-packages
pnpm run check:architecture
```

完整 `pnpm run ci` 已包含这些检查。Behavioral tests 属于 runtime/core/tools 各 owner，
根 `tests/codex/` 负责跨包集成与纯组合边界，不在 bundle 重复实现/测试行为。
架构检查覆盖 type/re-export edges、循环、跨包导出路径、精确依赖和禁止的 optional/peer edges。

`test:codex-packages` 将六个 Codex 包打包，在临时 consumer 内使用自身真实 Pi SDK/loader，
覆盖 runtime、各能力、两两/全部组合、bundle、重复和逆序加载、不同物理 runtime 副本、shutdown/reload。
所有 Codex 代码来自 tarball，不得回链源码；standalone auth/HTTP 是固定 fixture，不触真实端点。

外部依赖从根锁投影 production/host-peer 闭包，保留 dependency/peer snapshots 和 integrity：

```bash
pnpm install --offline --prod --frozen-lockfile --trust-lockfile --ignore-scripts
```

先完成根冻结安装来填充 pnpm store。缺失产物必须失败，不能在线换解锁版本。
pnpm 内部链接包括可执行链接只能留在 consumer 内，不能指向 checkout 或其他外部目录。
`--trust-lockfile` 仅跳过 registry-metadata policy 复查，不跳过冻结锁与完整性。

默认为 exhaustive。远端 Node 24/target 选中时运行完整组合矩阵，其他兼容腿用
`OMP_CODEX_CONSUMER_MODE=smoke`：仍打包六包、离线隔离安装 bundle、校验链接和 inline re-export，
并以真实 SDK/loader 加载 core 与所有工具；不覆盖其余组合、逆序/重复加载扫描及配置掩码。
未知模式失败。普通本地 CI 和 baseline 命令不默认降为 smoke。

离线消融 `pnpm run test:codex-ablation` 比较固定组件与 Pi 0.87.1 内置 Codex stream，
结果见[消融审计](audits/codex-ablation.md)，不是模型质量或延迟基准。
Live 测试与 CI 分开，需显式授权和 `--execute provider/model`，不要为检查文档而运行。
协议依据见 [reference 索引](../pi-extensions/pi-codex-runtime/reference/README.md)、
[来源映射](../pi-extensions/pi-codex-runtime/reference/source-map.md)及[组合清理审计](audits/codex-composition-cleanup.md)。

<a id="release-status"></a>

## 发布状态与边界

以 `scripts/workspaces.mjs` 为资格来源：当前八个发布工作区均为 `publishable`，
tools 的 `0.1.0-alpha.1` 首发与独立激活已经完成，**不再等待 bootstrap**。
旧文档中的七包/九包队列或 tools 待首发叙述是历史阶段，不是当前批次。

这不表示当前 manifest 的所有版本都已发布，也不授权发布。
普通批次要求完整依赖闭包和依赖优先顺序；定向发布要求精确依赖已在 npm 验证。
消费者仍需单独受保护调度，minimal-tools 保持在依赖之后发布。
已发布 recovery 节点由 release lock 的 source/SHA-512 固定；暂时 E404 必须停止，不能重打包当新候选。

Changesets 的 `changeset:sync` 递归覆盖 hard/optional workspace 消费者；
`changeset:version` 保持 exact pins 并要求相应 consumer bump。
不要手改生成 changeset 或跳过依赖守卫。
初始 alpha 的有限 `latest`/`next` 同指例外不是稳定认证；trusted publisher 配置也不证明 OIDC 已成功发布。
完整流程见[发布指南](../RELEASING.md)，证据见[初始激活](audits/codex-bootstrap-activation.md)、
[tools 激活](audits/codex-tools-bootstrap-activation.md)和[集成审计](audits/codex-integration.md)。
