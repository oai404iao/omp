# @oai404iao/pi-codex-imagegen

只给 Pi 加载图片生成/编辑的兼容入口。适合保留旧安装声明，或希望使用 `/image-gen` 而不启用补丁和搜索的用户。

默认工厂转发到 `@oai404iao/pi-codex-tools/imagegen`；图片客户端、保存、显示、后台任务与行为测试都归 [tools](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-tools#readme)。**不加载 Responses 引擎，不注册搜索或补丁。** 安装仍带入统一 tools 依赖，选择能力不等于依赖隔离或沙箱。

要求 Node.js ≥22.19.0；Pi peer 下限和开发验证目标均为 **1.2.0**。

## 安装与加载

测试仓库源码时，在根目录运行：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pi -e ./pi-extensions/pi-codex-imagegen
```

长期加载本地包：

```bash
pi install /absolute/path/to/omp/pi-extensions/pi-codex-imagegen
```

随后重启 Pi 或 `/reload`。`-e` 只加载本次调用，本地目录不复制，工作区依赖须事先安装。注册表预发行版可用 `pi install npm:@oai404iao/pi-codex-imagegen@next`，但与当前工作树可能不同；源码修改不自动发布。

## 生成与编辑图片

使用 Pi `/login` 配置 provider，选择具备已启用 standalone 图片 profile 的模型，然后让模型调用 `image_generation`。也可直接运行后台命令：

```text
/image-gen 一只雪地里的红狐，水彩风格
/image-gen 把这张图改成夜景 @reference.png
```

引用路径可加引号。命令不触发模型续跑，结果保存后显示为会话消息。当前模型符合条件时使用它，否则从已加载模型中选择具备图片输入和 standalone profile 的模型；依然使用该模型的 Pi 凭据与实际端点，不保证账号可访问。

图片工具输入：

| 参数 | 要求 |
| --- | --- |
| `prompt` | 必填非空说明 |
| `referenced_image_paths` | 最多 5 个本地 PNG/JPEG/WebP/GIF/BMP；相对 cwd，GIF/BMP 转 PNG 后上传 |
| `num_last_images_to_include` | 使用最近 1–5 张会话图片，与显式路径互斥 |
| `transparent_background` | 可选，默认 false，即不透明背景 |

standalone 使用 provider 的 `images/generations` 或 `images/edits`；默认图片模型 `gpt-image-2`，quality/size 为 auto。编辑图片以 data URL 发送。生成 PNG 保存到输出目录并覆盖 `latest.png` 镜像；图片先返回给模型，再返回路径。

active 工具可供 Pi 原生 codemode 调用，结构化结果为 `{ path, latestPath?, image }`。本包不启用 codemode 或 MCP。本地看图用 Pi 原生 `read`，图片输入模态、图片检查和图片生成互不等同。

## 配置

所有 Codex 包共用旧路径：

```text
<agentDir>/extensions/pi-codex-minimal-tools/config.json
<agentDir>/extensions/pi-codex-minimal-tools/models.json
```

runtime 持有唯一 schemas 和精确模型目录。agent 目录解析与完整字段见 [runtime 配置](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-runtime#configuration)。不要新建 `pi-codex-imagegen` 配置目录；真实 provider/模型连接仍在 Pi 自己的 `models.json` 中定义。

| 设置 | 默认值与含义 |
| --- | --- |
| 全局 `enabled` | true；false 不注册图片工具、命令或专用显示 |
| 全局 `imageGeneration` | true；false 关闭整项生图，不影响其他能力、图片输入或历史回放 |
| 全局 `autoEnable` | true；在支持模型自动激活，尊重 Pi 明确禁用 |
| 全局 `imageModel` | `"gpt-image-2"`；另支持 gpt-image-1.5/gpt-image-1 |
| 全局 `imageOutputDir` | `".pi/openai-codex-images"`；相对工作区根，绝对路径直接使用 |
| 模型 `tools.imageGeneration` | `false` 或 `"standalone"`，独立于全局开关 |
| 全局 `endpoint_config[].imageGeneration` | 只允许 `"standalone"`；省略继承，`[]` 拒绝，不选择 fallback |
| 全局 `codexRequestExtensions` | true；控制可选请求身份/回合 headers，不控制图片输入或工具实现 |

例如，修改图片模型和输出位置：

```json
{
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-runtime/config.schema.json",
  "imageGeneration": true,
  "imageModel": "gpt-image-2",
  "imageOutputDir": ".pi/generated-images"
}
```

为精确模型选择 standalone，编辑插件 `models.json`：

```json
{
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-runtime/models.schema.json",
  "version": 1,
  "models": [
    { "id": "openai/gpt-6.1-sol", "tools": { "imageGeneration": "standalone" } }
  ]
}
```

这是用户能力选择，不是端点权限证据。全局 false 优先于模型/旧配置；不会改变 Responses mode、transport、compaction 或 Fast。

图片执行**只有 standalone**，不需要 core。hosted 图片和 `directImageApiFallback` 已移除：删除旧 fallback 字段，把旧 hosted profile 改成 standalone 或 false。`directImageApiFallback:true` 会使图片执行保持关闭；明确 hosted profile 会报迁移错误，不偷偷挑其他模型。

认证与真实 base URL 来自 Pi model registry，不读备用账号或换 endpoint。端点白名单匹配认证解析后的 provider/base URL；省略列表继承、空列表禁用，不会凭模型名推断支持。明确 unsupported 只在当前会话/端点暂时禁用对应模式，原操作仍失败，不重发、不改配置；`/reload` 清除暂时拒绝。

## 限制与排障

| 现象 | 检查方法 |
| --- | --- |
| 没有工具或 `/image-gen` | 检查全局 enabled/imageGeneration、是否加载本入口，然后 `/reload` |
| 命令找不到可用模型 | Pi 模型需具备图片输入，精确 profile 已启用且选择 standalone；认证仍须有效 |
| 生图被旧配置禁用 | 删除 directImageApiFallback，迁移 hosted profile |
| 图片未出现在预期目录 | 从 cwd 向上找最近 `.git` 或 `.pi` 作为输出根，找不到用 cwd；核对 imageOutputDir |
| 取消后还有服务器生成或文件 | 取消抑制后续结果，不能撤销已经开始的服务端工作或写入 |

新会话/会话替换和 shutdown 会取消后台任务，抑制迟到通知与新的保存；显示 clear 使旧 sink/timer 失效，不回滚已经开始的写入。`latest.png` 是可覆盖镜像，需要保留时使用唯一结果文件。

与 tools/组合包兼容重复加载时按能力去重，任意顺序均可；要求 ABI v2 与相同 runtime 版本，不保证与旧无 broker 单体混装。

扩展拥有 Pi 进程权限，不限制可读参考路径；图片内容与提示会上传到所选服务端，文件和会话可能含敏感数据。离线测试、相似模型名或白名单都不是服务权限保证；认证/限流/通用 404/5xx 不触发备用账号或实现。

## 开发与相关资料

从仓库根目录运行：

```bash
pnpm --filter @oai404iao/pi-codex-imagegen run check
pnpm run test:codex-composition
pnpm run test:codex-packages
```

本包仅测试可导入性，行为由 tools 测试覆盖。不导出内部实现路径。更多资料：[tools 图片与后台任务](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-tools#readme)、[组合/生命周期（仓库）](https://github.com/oai404iao/omp/blob/main/docs/codex-packages.md)、[配置参考（仓库）](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-runtime/reference/configuration.md)。

<a id="license"></a>

## 许可

见 [LICENSE](LICENSE) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。
