<a id="pi-compatibility-baselines"></a>

# Pi 兼容性

本页说明支持基线、宿主集成契约与测试边界。版本声明不是对所有未来版本、真实模型账号、
端点或交互界面已经验证的承诺。使用问题先看[排查指南](troubleshooting.md)。

<a id="tested-scope"></a>

## 当前支持范围

公开 Pi peer 要求 **`>=1.5.2`**；根与工作区开发依赖和 CI 只锁定验证 **Pi 1.5.2**。
不支持更早版本，也不提供旧 SDK 回退；peer 范围允许安装更高版本，不表示这些版本已通过验证。
宿主更新见 [Pi v1.5.2 发布记录](https://github.com/earendil-works/pi/releases/tag/v1.5.2)。

<a id="commands"></a>

## 运行兼容检查

使用 Node.js 24，在仓库根目录运行：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run ci
```

`ci` 校验实际解析的 SDK，并运行各包检查、跨包组合测试和隔离 tarball 消费者测试。
消费者在独立目录安装，不能链接回工作区或其他外部目录。

生产 consumer 使用已填充的 pnpm store：

```bash
pnpm install --offline --prod --frozen-lockfile --trust-lockfile --ignore-scripts
```

投影保留 production/host-peer 闭包的 dependency/peer snapshots 与校验和，不重新解析范围。
未知/冲突 hash、无 hash 依赖或缺少 store 产物都必须失败，不能暗中在线取另一版本。
更多开发检查见[贡献指南](../CONTRIBUTING.md)。

## 远端 CI 与复用

| 场景 | 覆盖范围 |
| --- | --- |
| Pull request | Node 24 affected 计划；policy 始终执行，包与 shared suites 分 job；消费者用 smoke |
| Main push / 手动运行 | Node 24 全量计划与 exhaustive 消费者 |

所有任务均从根锁安装 Pi 1.5.2。四个既有 `Node … / Pi floor`、`Node … / Pi target`
分支保护标签仅汇总同一套结果，不额外执行旧 Node 或 Pi 组合。

<a id="pi-lifecycle-and-tool-contracts"></a>

## Pi 生命周期与工具

| 边界 | 保留的契约 |
| --- | --- |
| `before_agent_start` | 覆盖 user 与 custom 触发，身份、prompt 跟踪和邮箱均处理；Telegram 自动通知只处理 user，custom 清除陈旧 prompt 摘要 |
| `agent_settled` | 两类通知均抑制 aborted，包括 retry wait 取消但 final assistant 仍为 error；local 继续支持 custom 完成 |
| 子代理工具上限 | 角色 `tools` 使用精确名或 `$mutation`，不是 CLI pattern 或 `+name`/`-name`；未授权 MCP/resource helpers、晚注册和恢复声明不能扩大权限 |
| 子代理 model runtime | Provider、virtual router、runtime key 隔离；后代通过私有构造器适配从 root baseline 创建，不共享可变 remote-catalog refresh wrappers |
| 扩展继承 | 继承的扩展重建 child callbacks，临时中间注册不是后代 baseline；原生/custom providers 与 root-bound virtual routes 保留 |
| 启动取消 | 使用 Pi pending abort，不从 `started` preflight 抛出；未交付 envelope 留待后续运行，不回滚 context receipts |
| 工具展示与流 | Patch 使用 Pi 的标准工具容器；流使用记录 response duration 的 `AssistantMessageEventStream` |

标准 OpenAI Responses 的 sampling 依次合并 model defaults、有效且 clamped 的 thinking-level overrides、
request parameters，结构请求字段仍受保护。ChatGPT subscription 请求省略 temperature 与 output-token caps；
Lite 仅保留合并后的 temperature。

原生 image models、renderer resolvers 和 `reachesTools` 不替代既有图像端点/持久化、
owned tool 实现或 child session 权限。不透明 checkpoint 与 replay signatures 保留。

<a id="native-codemode-integration"></a>

## 原生 codemode 集成

### 工具怎样暴露

- Active standalone `web_search` / `image_generation` 为 `direct`，codemode 可调用。
  Hosted profiles 为 `model-only`，在 codemode `on` / `only` 下保留 provider 声明；显式 direct fallback 不改变 hosted exposure。
- Exposure 随模型切换，不替换外部同名工具，也不覆盖 `autoEnable:false`。Hosted placeholder result 是错误。
- Active `apply_patch` 保持可调用；本地图片使用原生 `read`。
- Subagent 的七个协作工具均为 `model-only`，旧 child `report` 已由 `send_message` 取代。
  `wait_agent` 只报告调用者邮箱活动，不返回正文、不确认某个子代理完成。
  消息正文和完成通知通过独立上下文消息交付，ACK 以该消息的持久 transcript 收据为依据，
  不是等待工具结果或嵌套脚本摘要。
- Subagent 接受使用 Pi `started` disposition；邮箱工作还需持久化 user-message boundary。
  被 input handler 处理不等于任务成功。

### 脚本获得什么结果

| 工具 | Structured result |
| --- | --- |
| Patch | `{ summary, files }` |
| Search | `{ output, results }` |
| Image generation | `{ path, latestPath?, image }` |

图片需显式 `image(result.image)` 转发。执行失败抛出；模型可见 content 与既有 renderer 保留。
Pi 在 `tool_result` hook 只设 `isError:true` 时仍向脚本传递 structured data。
需要脚本拒绝/脱敏的 hook 必须替换 `content` 且不再提供 `structuredContent`，
不能把单独改 `isError` 当作 rejection/redaction 边界。

### 子代理与动态发现

Child 仅通过 Pi 正常 builtin loader policy 获得 codemode/tool-search factories。
`inheritExtensions:false` 或继承的 extension settings 可阻止加载；加载不等于启用，
角色 `tools` 或 Pi `defaultTools` 仍需选中。Child codemode 禁用 classifier/model calls；
fork 不继承 parent `codemode-store` custom entries。

`tools` / `excludeTools` 继续约束 registry，包括晚注册工具。
Allowlist 给予 codemode/deferred callable access，但不强迫声明；tool search 可随后声明，
发现结果在 child canonical branch 冷恢复后保留。Subagent 工具仍是 model-only。
Nested traces 保留调用层级，nested usage 只从 outer result 收集一次。
本项目不全局启用 codemode，也不向 child 自动注入 MCP。

### 预热与压缩限制

Codemode/tool-search 活跃时跳过预热，不猜测最终 `prepareLoadout` 投影。
没有 native checkpoint 时，压缩委托 Pi tool-free 文本摘要；已有 checkpoint 时拒绝重压缩，
并保留 opaque 状态。关闭两工具后回原模型重试，或导航回 checkpoint 之前。
这一 guard 识别内置工具名，不识别任意第三方 `prepareLoadout` hooks。

## 模型、认证与流事件

OpenAI ChatGPT OAuth 和 API key 均遵循 Pi 原生认证/解析地址。
请求增强与精确 endpoint capability allowlists 可配置；明确 unsupported 只禁用受影响 session/endpoint mode，
不换凭证或 fallback 实现。详见[配置](configuration.md)。

Pi 提供 OpenAI GPT-6 描述符，OMP 不接管宿主模型目录。目录快照及其完整性记录见
[runtime 来源映射](../pi-extensions/pi-codex-runtime/reference/source-map.md)；历史快照不定义当前支持的 Pi 版本。
`openai/gpt-6.1-sol` 显式继承 `gpt-5.6-sol`：Lite、auto WS/SSE、prewarm、standalone web/image、
custom patch、native Responses compaction、Fast（priority、2x 成本乘数）可用性。
这是兼容策略，不证明端点权限或 Fast 价格。

`openai/gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna` 使用 Standard SSE 与 local custom patch，
默认不开搜索、图像生成、native 压缩、预热和 Fast。Standard reasoning clamps 委托 Pi，
不替换 descriptors、limits 或 prices。
未知 ID 保持 native；旧 `openai-codex` profiles 冻结，不新增 `openai-codex/gpt-6.1-sol`。

SSE/WS 在归一化前向 Pi raw provider-event callback 转发事件，包括 terminal errors；合成 replay items 不是 raw events。
Subagent `openAIIdentity` 覆盖 virtual selection，在物理 routing 前准备身份并跨冷恢复保留；
身份作为 custom session metadata，不进入非 OpenAI 模型上下文。

<a id="preserved-transcript-contracts"></a>

## 上下文、回放与检查点

SessionManager 是 canonical 来源，包括 append-only context edits。
此前核验的 `openai-codex/gpt-6-sol` / `gpt-6-luna` Lite profiles 保持不变；Pi 提供模型，扩展不注册它们。
不从模型家族推断 Fast 倍数或公共 API cache TTL，发布资格也不因兼容性工作改变。

Provider boundary 将 Pi system sections 与 tool deltas 回放为 Standard/Lite encoder 需要的完整 prompt/loadout。
已注册 shim 的 native fallback 也接收 checkpoint projection；这不实现原地 delta transport，
也不保证 prompt/tools 改变时维持缓存前缀。

Native compaction v4 保存 retain-none checkpoint，其 opaque payload 已覆盖前文。
普通 `context` hook 只替换输入中仍存在的 checkpoint marker，不恢复 system state，也不从 raw history 重建 tail；
Pi 负责恢复当前 prompt/tool state。
Legacy checkpoint 只回放未变换的 canonical input；若前面存在 context transform，则要求在原模型 `/compact`，
不猜边界、不丢 opaque 历史。失败重压缩保留 checkpoint，身份绑定 provider/model/API/profile。

Child 先应用完整 canonical projection，再选择已完成 turns；不撤销 omission/content replacement，
不继承 parent system authority。完成结果来自 finalized events，而不是可变数组偏移。
Grammar eligibility 同样使用有效 context。通知和 cleanup 保持 `agent_settled`。
活跃运行的邮箱交付继续使用有界 `agent_before_settle` continuation。实时入箱的普通消息和完成通知
可唤醒空闲收件人；`/root` 用 Pi custom 消息触发新轮次，不走用户输入或 idle command。

<a id="checks-that-prevent-false-positives"></a>

## 如何避免测试假阳性

- Root SDK anchors 保持全部工作区使用精确基线，`check:pi-baseline` 同时验证声明与实际 resolved SDK。
- Loader probes 检查每个 consumer 自己的 SDK package version 与导出 `VERSION`，覆盖 ordinary/reversed/duplicate 加载。
- 不含凭证的离线 CLI probe 显式加载兼容 bundle；每个 consumer 在独立进程运行，避免 module globals 串扰并及时释放临时安装。
- Provider fixtures 像真实 SDK 一样先归一化 context；真实 SDK tests 覆盖 Standard/Lite prompts、动态工具、
  checkpoint、system authority 继承、取消后 continuation 和 JSON 参数形状。
- Native QuickJS tests 覆盖 structured results、图片转发、权限拒绝、脱敏和 nested patch 等待 file queue 时取消。
- 真实 child SDK tests 覆盖 builtin 加载、deferred 发现、hard registry ceilings 和 nested usage 单次记账。

<a id="limits-and-known-issues"></a>

## 没有验证什么

CI 仅覆盖 Node 24 和 Pi 1.5.2；包声明的 Node.js 最低版本仍为 22.19.0。
旧审计中的基线仅为历史记录。

常规 CI 不测试真实账号、计费端点、交互 UI 或发布。Core 协议快照是审查后的兼容契约，
不是自动接受上游所有协议/模型变更。Live tests 独立且需显式授权。

历史 subagent FIFO 测试的 `2 !== 1` 偶发断言已由[稳定性跟进](plans/subagent-fifo-stability.md)
定位为 invocation-order 假设，并以可控 lookup 完成顺序修正；没有修改运行时队列，也没有加重试或跳过。
