# @oai404iao/pi-codex-web-search

只给 Pi 加载 Codex 搜索的兼容入口。适合保留旧安装声明，或不想同时启用补丁和生图的用户。

本包把默认工厂转发到 `@oai404iao/pi-codex-tools/web-search`；执行、schema、显示和测试都归 [tools](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-tools#readme)。**不加载 Responses 引擎，不注册补丁、生图或 `/image-gen`。** 安装仍会带入 tools 依赖，因此这是运行时能力选择，不是依赖隔离或沙箱。

要求 Node.js ≥22.19.0；Pi peer 下限和开发验证目标均为 **1.2.0**。

## 安装与加载

测试仓库源码时，在根目录运行：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pi -e ./pi-extensions/pi-codex-web-search
```

需要长期加载本地包可运行：

```bash
pi install /absolute/path/to/omp/pi-extensions/pi-codex-web-search
```

随后重启 Pi 或 `/reload`。`-e` 只加载本次调用，本地目录不会被复制或自动安装其工作区依赖。注册表预发行版可用 `pi install npm:@oai404iao/pi-codex-web-search@next`；它不保证对应当前工作树，源码变更也不自动发布。

## 使用搜索

先用 Pi `/login` 配置所需 provider，选中在插件目录中已启用搜索的精确模型，再要求模型“查找资料并给出来源”。Pi 工具名是 `web_search`，由 profile 决定执行方式：

| 模式 | 怎么工作 | 前提 |
| --- | --- | --- |
| standalone | 本地客户端调用当前 provider 的 `alpha/search`，Lite 中使用 `web.run` namespace | 无需 core；端点和账号必须实际支持 |
| hosted | core 转成服务端 Responses `web_search`，保留来源、结果、citation 回放与显示 | 必须另加载兼容 [core](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-core#readme)，且为 Standard Responses |

standalone 支持文字/图片搜索、open/click/find、PDF 截图、finance、weather、sports、time 和 `response_length`。模型 profile 的 `contentTypes` 决定文字/图片查询许可；搜索结果默认显示去重来源域名，展开可看原始文本。完整参数见 [tools 搜索说明](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-tools#readme)。

active standalone 搜索可由 Pi 原生 codemode 调用，返回 `{ output, results }`。hosted 搜索是 model-only，不能当成本地脚本工具执行。本包不启用 codemode、不加载 MCP，也没有额外 slash 命令。

## 配置

所有 Codex 包共用旧目录：

```text
<agentDir>/extensions/pi-codex-minimal-tools/config.json
<agentDir>/extensions/pi-codex-minimal-tools/models.json
```

runtime 持有唯一 schemas 和模型目录。`agentDir` 规则、全部字段和旧配置迁移见 [runtime 配置](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-runtime#configuration)。不要创建 `pi-codex-web-search` 专属配置目录，也不要把连接凭据写进插件目录。

| 设置 | 含义 |
| --- | --- |
| 全局 `enabled` | 默认 true；false 不注册搜索及专用显示 |
| 全局 `webSearch` | 默认 true；false 同时禁用 hosted/standalone，不影响其他能力 |
| 全局 `autoEnable` | 默认 true，在支持模型自动激活，尊重 Pi 明确禁用 |
| 模型 `tools.webSearch` | false 或 `{ "implementation": "standalone"/"hosted", ... }` |
| 全局 `endpoint_config[].webSearch` | 允许的 hosted/standalone 列表；省略继承，`[]` 拒绝，不选择替代实现 |
| 全局 `codexRequestExtensions` | 默认 true；控制可选身份/回合元数据，不控制工具是否存在 |

例如，全局关闭搜索：

```json
{
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-runtime/config.schema.json",
  "webSearch": false
}
```

只为已存在的模型调整搜索选项，编辑插件 `models.json`：

```json
{
  "$schema": "https://unpkg.com/@oai404iao/pi-codex-runtime/models.schema.json",
  "version": 1,
  "models": [
    {
      "id": "openai/gpt-6.1-sol",
      "tools": {
        "webSearch": {
          "implementation": "standalone",
          "contentTypes": ["text"],
          "mode": "live",
          "maxOutputTokens": 10000
        }
      }
    }
  ]
}
```

这只是用户选择，不证明账号支持 `alpha/search`。还可配置 `searchContextSize`、近似 `userLocation`、`filters.allowedDomains`；mode 支持 cached/indexed/live，输出 token 预算与调用 `response_length` 分开。

认证和实际 endpoint 来自 Pi model registry，不选 fallback 账号/地址/实现。端点白名单按认证解析后的 provider/base URL 匹配，不能靠模型名字推断支持。首个请求前工具投影可能待定，但执行始终检查声明。明确 unsupported 只暂时禁用当前会话/端点对应模式，原操作仍失败；不自动重发、不写配置，`/reload` 清除暂时拒绝。

## 限制与排障

- **没有搜索工具：** 检查全局/模型开关、精确 profile 与 Pi active 选择。未知或 disabled 模型不会被猜测启用。
- **hosted 提示需要 core：** 本包没有引擎；另加载兼容 core，或明确选择经验证的 standalone profile，不自动切换。
- **认证/404 错误：** 使用 Pi 登录并核对真实 base URL。通用 404、限流、认证或连接错误不等于能力不支持，不会触发替代账号。
- **重复安装：** 与 tools/组合包按能力去重，加载顺序不限；要求 ABI v2、相同 runtime 版本，不保障与旧无 broker 单体混装。

standalone 搜索会发送查询、模型/会话标识、截至最近用户消息的一段有限可见对话尾部，以及启用时的筛选回合元数据。它不是仅上传搜索词的隐私边界；扩展具有 Pi 进程权限，搜索端点属于兼容面，离线测试不证明真实权限。

## 开发与相关资料

从仓库根目录运行：

```bash
pnpm --filter @oai404iao/pi-codex-web-search run check
pnpm run test:codex-composition
pnpm run test:codex-packages
```

本包测试只检查导入，行为由 tools 测试覆盖。没有内部实现路径导出。更多资料：[tools](https://github.com/oai404iao/omp/tree/main/pi-extensions/pi-codex-tools#readme)、[组合/生命周期（仓库）](https://github.com/oai404iao/omp/blob/main/docs/codex-packages.md)、[配置参考（仓库）](https://github.com/oai404iao/omp/blob/main/pi-extensions/pi-codex-runtime/reference/configuration.md)。

<a id="license"></a>

## 许可

见 [LICENSE](LICENSE) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。
