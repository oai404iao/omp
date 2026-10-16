# @oai404iao/pi-codex-tools

给 Pi 增加 `apply_patch`、`web_search` 和 `image_generation`，包括执行、流式预览、结果显示、图片保存与后台 `/image-gen` 命令。

适合需要这些工具、但想自行选择模型引擎的用户。**本包不加载 Responses 引擎**，唯一工作区依赖是 runtime。独立搜索/生图和 function 补丁可以单独使用；custom 补丁与 hosted 搜索还需要 [core](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-core#readme)。希望一次安装两者，请用 [组合包](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-minimal-tools#readme)。

要求 Node.js ≥22.19.0；Pi peer 下限和开发验证目标均为 **1.2.0**。

## 安装与加载

测试本工作树，在仓库根目录运行：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pi -e ./pi-extensions/pi-codex-tools
```

需要 custom patch 或 hosted search 时，同时加载 core：

```bash
pi -e ./pi-extensions/pi-codex-core -e ./pi-extensions/pi-codex-tools
```

`-e` 不保存设置。长期使用本地源码可运行 `pi install /absolute/path/to/omp/pi-extensions/pi-codex-tools`，然后重启 Pi 或 `/reload`。本地路径原地加载，依赖须事先在仓库安装；源码变动不会自动发布 npm 版本。

本包的首次发布/激活已完成，后续发布仍需独立授权与依赖验证，不应按旧 bootstrap 流程重新发布不可变版本。注册表制品与工作树可能不同，发布事实见 [激活记录（仓库）](https://github.com/oai404iao/omp/blob/main/docs/audits/codex-tools-bootstrap-activation.md)。

<a id="composition"></a>

## 选择需要的能力

| 入口 | 加载内容 |
| --- | --- |
| 默认扩展工厂 | 全部三项工具与对应显示/命令 |
| `@oai404iao/pi-codex-tools/web-search` | 只加载搜索 |
| `@oai404iao/pi-codex-tools/imagegen` | 只加载生图 |
| 兼容包 `pi-codex-web-search`、`pi-codex-imagegen` | 转发到对应选择性工厂 |

公开选择性入口用于扩展/SDK 组合；只想用 Pi 包管理器装一个能力，可用对应兼容包。选择性加载不等于依赖安装隔离：它们仍依赖统一 tools 包，但不会注册另一项能力。

broker 按能力去重，兼容包、tools 与组合包可按任意顺序加载。要求 ABI v2 和完全相同的 runtime 版本；与不支持 broker 的旧单体混装不在保障范围内。`./internal/*` 仅作内部接线，不是稳定公共 API。

| 实现 | 是否需要 core | 额外条件 |
| --- | --- | --- |
| function `apply_patch` | 否 | 模型 profile 显式选 `"function"`，provider 支持普通工具 |
| custom/freeform `apply_patch` | 是 | 当前实际加载的 Responses 引擎支持该模型/协议 |
| standalone `web_search` | 否 | profile 选择 standalone，真实端点支持 `alpha/search` |
| hosted `web_search` | 是 | Standard Responses，实际兼容引擎与 hosted 支持 |
| standalone `image_generation` | 否 | profile 选择 standalone，端点支持 Images API |

能力 profile 不是引擎已加载或账号获授权的证据。条件不满足就诊断/报错，不暗中切换传输、账号、端点或工具实现。

## 使用补丁

直接让模型通过 `apply_patch` 修改文件，例如“把这个函数的参数检查补上，并展示修改”。工具使用 Codex patch 格式：

```text
*** Begin Patch
*** Update File: src/example.ts
@@ function greet
-  return "hello";
+  return "你好";
*** End Patch
```

支持 `@@ class/function` 上下文、有序 update chunks、`*** Move to:`、`*** End of File`、模糊匹配和 CRLF 保留。custom 模式用随包固定的 grammar；function 模式接受 `{ "input": "补丁文本" }`。

patch 被声明时，通过 Pi `prepareLoadout.hiddenDeclarations` 隐藏所选原生 `edit`/`write` 的模型声明。它们**仍在 active set 中**、可由 codemode 调用、保留在历史会话中；patch 不再声明时 Pi 重新展示这些原生工具。不会重新启用用户明确禁用的工具，也不靠恢复凭据修改历史选择。

早期插件创建的会话可能已不含 `edit`/`write` 选择；本包不猜它们是旧插件移除还是用户禁用。必要时新建会话并显式选择所需工具，不要编辑会话记录。

### 文件安全与并发边界

- 完整读/改/写窗口使用 Pi 每文件 mutation queue，按规范目标顺序取锁；等待期间文件身份漂移会拒绝写入。
- 单补丁中通过不同别名指向同一目标（含 hardlink 和移动目标）会在修改前失败；同一路径上的重复动作有效。
- 写前验证与回滚保护不等于多文件事务或文件系统隔离。队列只协调参与同一机制的工具，不能阻止外部程序同时写入。
- 未存在文件使用词法路径键；不同调用通过目录别名或 hardlink 不保证共享锁。各工具保持路径一致；并发替换目录/符号链接不是原子隔离。

预览遵守 Pi `outputPad`（含零 padding）。`deferApplyPatchRendering:true` 可交给 Pi 回退 renderer。详细行为与安全检查见 [补丁行为（仓库）](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-tools/reference/apply-patch-behavior.md)。

## 使用搜索

让模型“查找资料并附上来源链接”即可。模型 profile 选择实现：

- **hosted：** core 把本包占位声明转成 Responses `type:"web_search"`，服务端执行，保留进度、来源、结果和 citation 回放；只供模型调用，不能由 codemode 执行。
- **standalone：** 本地客户端调用当前 provider 的 `alpha/search`；Lite 请求中以 `web.run` namespace 暴露，Pi 工具名仍是 `web_search`。

standalone 参数按操作成组，可在一次调用中组合：

| 参数 | 内容 |
| --- | --- |
| `search_query`、`image_query` | `{ q, recency?, domains? }` 数组；分别最多 4 项和 2 项 |
| `open` | `{ ref_id, lineno? }` |
| `click`、`find` | `{ ref_id, id }` 或 `{ ref_id, pattern }` |
| `screenshot` | `{ ref_id, pageno }`，PDF 页码从 0 开始 |
| `finance` | `{ ticker, type, market? }`；type 为 equity/fund/crypto/index |
| `weather` | `{ location, start?, duration? }` |
| `sports` | `{ fn, league, team?, opponent?, date_from?, date_to?, num_games?, locale?, tool? }`；fn 为 schedule/standings |
| `time` | `{ utc_offset }` |
| `response_length` | `"short"`、`"medium"`、`"long"` |

除 `response_length` 外以上操作参数均为数组。sports league 支持 nba、wnba、nfl、nhl、mlb、epl、ncaamb、ncaawb、ipl；可选 `tool` 只能为 `"sports"`。profile 的 `contentTypes` 决定是否允许文字/图片查询。

standalone 请求发送当前模型 ID、会话 ID、截至最近用户消息的一段有限可见对话尾部、查询与搜索设置，以及启用增强时经过筛选的当前回合元数据。它不是仅发送搜索词的隐私边界。默认结果行显示去重来源域名，展开可看原始结果。

搜索 profile 还可配置 `mode`（cached/indexed/live）、`searchContextSize`、近似 `userLocation`、`filters.allowedDomains` 和 `maxOutputTokens`（默认 10000，独立于 `response_length`）。全部字段见 [runtime 模型配置](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-runtime#readme)。

## 生成或编辑图片

可让模型调用 `image_generation`，或手动排队后台任务：

```text
/image-gen 一只雪地里的红狐，水彩风格
/image-gen 把背景改成浅蓝色 @reference.png
```

带空格的本地路径可加引号。命令不触发模型续跑；完成后写入图片结果消息。当前模型符合条件时使用它，否则在已加载模型中选择具备图片输入且已启用 standalone profile 的模型；该选择不意味着服务接受请求，仍使用所选模型的 Pi 认证与端点。显式配置了已移除 hosted 图片的 profile 会报错，不改选其他模型掩盖问题。

工具输入：

| 字段 | 约束 |
| --- | --- |
| `prompt` | 必填、非空生成/编辑说明 |
| `referenced_image_paths` | 可选，最多 5 个本地路径；PNG/JPEG/WebP/GIF/BMP；GIF/BMP 转 PNG 后发送 |
| `num_last_images_to_include` | 可选，取会话最新 1–5 张图片；与显式路径互斥 |
| `transparent_background` | 可选 boolean，默认 false，即不透明背景 |

standalone 调用 `images/generations` 或 `images/edits`，默认 `gpt-image-2`、quality/size 为 auto。编辑图片以 data URL 上传。结果先把图片返回给模型，再给保存路径；PNG 保存到 `imageOutputDir` 并镜像为 `latest.png`。默认目录为工作区根的 `.pi/openai-codex-images`，`latest.png` 会被后续结果覆盖。

图片生成只支持 standalone。hosted 图片生成和 `directImageApiFallback` 已移除；删除旧 fallback 设置并在 profile 显式选择 standalone，不读取另一账号 key 或强制换 endpoint。本地图片检查用 Pi 原生 `read`，与图片输入模态和生图能力相互独立。

新会话/会话替换和 shutdown 取消后台工作，抑制迟到通知与新的保存操作；无法撤销服务端已经开始的生成或已经开始的文件写入。显示 clear 会使旧 sink/timer 失效，但不回滚落盘写入。

## 与 codemode 一起用

本包不主动启用 codemode 或 MCP。Pi 中可用 `pi --tools +codemode` 启用原生 codemode，保留其他默认工具。active 的补丁及 standalone web/image 可通过脚本调用：

```javascript
const result = await tools.web_search({
  search_query: [{ q: "Pi coding agent documentation" }],
  response_length: "short",
});
text(result.output);
```

| 工具 | 脚本结构化结果 |
| --- | --- |
| `apply_patch` | `{ summary, files }` |
| standalone `web_search` | `{ output, results }` |
| `image_generation` | `{ path, latestPath?, image }` |

hosted 搜索仍是 model-only。执行失败会 reject，而不是返回成功形状的数据。注意 Pi 的 `tool_result` hook：保留 `structuredContent` 时，即使设置 `isError:true`，脚本仍能收到结构化结果；若 hook 必须让脚本拒绝，应同时替换 `content` 且不提供 `structuredContent`。

当原生 codemode/tool-search active 时，core 会跳过推测预热；无不透明 checkpoint 时可用 Pi 文本压缩，有 checkpoint 时保留并拒绝重压缩。见 [core 压缩限制](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-core#readme)。

<a id="configuration"></a>

## 配置

全部工厂共用 `<agentDir>/extensions/pi-codex-minimal-tools/{config,models}.json`，不要按工具新建配置目录。runtime 持有唯一 schemas 和精确模型目录；Pi 自己负责模型描述、认证与实际 base URL。

| 全局 `config.json` 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | false 停止所有工具能力注册 |
| `autoEnable` | `true` | 在支持模型自动激活，尊重 Pi 显式禁用 |
| `applyPatch`、`webSearch`、`imageGeneration` | 各为 `true` | 独立总开关；false 跳过对应工具、专用显示和命令，不启动能力任务或网络请求 |
| `imageOutputDir` | `".pi/openai-codex-images"` | 输出目录，相对工作区根；绝对路径直接使用 |
| `imageModel` | `"gpt-image-2"` | 另支持 gpt-image-1.5/gpt-image-1 |
| `deferApplyPatchRendering` | `false` | 交给 Pi 回退显示 |
| `glyphStyle` | `"unicode"` | 可切 `"ascii"` |
| `codexRequestExtensions` | `true` | 控制可选身份/请求元数据，不关闭工具、认证或历史回放 |
| `endpoint_config` | `[]` | 按认证解析后的 provider/base URL 限制具体能力，不选择实现 |

例如，全局只保留补丁和搜索：

```json
{
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-runtime/config.schema.json",
  "applyPatch": true,
  "webSearch": true,
  "imageGeneration": false
}
```

为现有模型显式选择工具实现，编辑插件 `models.json`：

```json
{
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-runtime/models.schema.json",
  "version": 1,
  "models": [
    {
      "id": "openai/gpt-6-astra",
      "tools": {
        "applyPatch": "function",
        "webSearch": false,
        "imageGeneration": false
      }
    }
  ]
}
```

这个例子不启用远程端点，function patch 可不加载 core。远程搜索/生图必须另有已验证的 profile 和端点支持；同名模型不代表支持。全局 false 优先于模型与旧配置，不影响 Responses 格式、传输、压缩、Fast 或图片输入。

端点白名单未列字段继承 profile，空数组拒绝对应能力。请求始终使用 Pi model registry 认证及其解析的 endpoint，不额外挑 fallback 账号。明确 unsupported 只会暂时拒绝当前会话/端点对应模式，不自动重发或切换实现；不会改配置/凭据。执行 `/reload` 刷新声明并清除暂时拒绝。完整规则见 [runtime 配置](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-runtime#configuration)。

## 故障排查与安全

| 现象 | 下一步 |
| --- | --- |
| custom patch/hosted search 未激活 | 加载兼容 core；仅在 profile 写 provider/API 名称不够 |
| standalone 提示无认证 | 用 Pi `/login` 配置该 provider；不会尝试其他账号 |
| 模型没有工具 | 检查精确 profile、全局/模型开关、Pi active 工具选择及已解析端点；加载 core 时可用 doctor |
| 生图仍关闭 | 删除 `directImageApiFallback:true`，迁移 hosted profile，再 `/reload` |
| 输出不是预期目录 | 检查 `imageOutputDir`；根目录为向上最近含 `.git` 或 `.pi` 的目录，否则为 cwd |
| 补丁别名/身份错误 | 统一路径，检查 hardlink、symlink、移动目标和并发外部写入，不要绕过检查 |

包选择和 broker 所有权检查不是沙箱或授权边界。工具拥有 Pi 进程的文件/网络权限，补丁可以修改文件，参考图片和有限对话尾部可能上传服务端。只加载可信扩展，保管好输出、会话与凭据；离线 fixture 成功不证明真实端点权限。

<a id="verification-and-license"></a>

## 开发、参考与许可

从仓库根目录运行：

```bash
pnpm --filter @oai404iao/pi-codex-tools run check
pnpm run check:architecture
pnpm run test:codex-composition
pnpm run test:codex-packages
```

行为回归归本包，跨包组合与隔离 tarball 测试在根 `tests/codex/`；不需要真实模型凭据。协议证据与固定 grammar/来源声明保留在实现所有者包中，`reference/` 不进入 tarball：

- [补丁协议（仓库）](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-tools/reference/apply-patch-protocols.md)
- [配置与迁移参考（仓库）](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-runtime/reference/configuration.md)
- [组合与生命周期（仓库）](https://github.com/oai404iao/omp/blob/main/docs/codex-packages.md)
- [LICENSE](LICENSE)、[第三方声明](THIRD_PARTY_NOTICES.md)
