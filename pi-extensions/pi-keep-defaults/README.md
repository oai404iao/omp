# pi-keep-defaults

让 pi 在会话内切换模型、切换思考级别时,**不修改** `settings.json` 中的默认配置:

- `defaultProvider`
- `defaultModel`
- `defaultThinkingLevel`

也就是说 `/model`、`Ctrl+P` 循环切换、模型选择器、RPC 切模型、切换思考级别等操作只影响**当前会话**,不会再悄悄改写全局默认值。

## 安装

```bash
pi install /absolute/path/to/pi-keep-defaults
```

或者直接把路径加入 `~/.config/pi/agent/settings.json` 的 `packages` 数组,然后 `/reload`:

```json
{
  "packages": [
    "/absolute/path/to/pi-extensions/pi-keep-defaults"
  ]
}
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `/keep-defaults` | 查看当前状态(开/关 + 受保护的默认值) |
| `/keep-defaults on` | 开启保护(默认开启;会以当前 settings.json 为基准重新锁定) |
| `/keep-defaults off` | 关闭保护,恢复 pi 原生行为(`/model` 和思考切换会重新写入默认值) |

## 工作原理

两层防护:

1. **运行时补丁(主要)**: 拦截 `SettingsManager` 的默认值 setter
   (`setDefaultModelAndProvider` / `setDefaultProvider` / `setDefaultModel` / `setDefaultThinkingLevel`)。
   保护开启时,这些写入被直接忽略 —— 覆盖 pi 当前所有写入路径(`/model`、模型循环、模型选择器 UI、RPC、模型切换触发的思考级别调整等),内存和磁盘都不会变。

2. **文件守卫(兜底)**: 监听全局 `settings.json`,如果 `defaultProvider` / `defaultModel` / `defaultThinkingLevel`
   被任何其他路径改写,会自动还原(保留文件里其他所有设置)并给出提示。此机制在 pi 未来版本改动写入路径时依然有效。

补丁与守卫均通过 `Symbol.for` 挂在全局,`/reload` 后依然生效。

## 注意

- 保护开启时,`/model` 只切换当前会话的模型,**不会**成为新的默认模型。
- 想永久修改默认值: `/keep-defaults off` → 用 `/model` 选好 → `/keep-defaults on`;
  或者直接编辑 `settings.json`(建议在 pi 未运行时编辑)。
- 首次启动时若某个字段原本不存在,第一次出现的值会被自动当作基准并冻结。

## License

MIT © 2026 oai404iao. See [LICENSE](LICENSE).
