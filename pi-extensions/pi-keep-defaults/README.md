# @oai404iao/pi-keep-defaults

让 pi 在会话内切换模型、切换思考级别时,**不修改** `settings.json` 中的默认配置:

- `defaultProvider`
- `defaultModel`
- `defaultThinkingLevel`

也就是说 `/model`、`Ctrl+P` 循环切换、模型选择器、RPC 切模型、切换思考级别等操作只影响**当前会话**,不会再悄悄改写全局默认值。

兼容性: Pi 0.84.2 或更高版本;当前测试基线为 0.84.2。

## 安装

首个公开版本发布后：

```bash
pi install npm:@oai404iao/pi-keep-defaults
```

本地开发或尚未发布时：

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

2. **文件守卫(兜底)**: 在 `session_start` 后监听当前 agent 目录的全局 `settings.json`,如果
   `defaultProvider` / `defaultModel` / `defaultThinkingLevel` 被其他路径改写,会自动还原
   (保留文件里其他所有设置)并给出提示。`session_shutdown`(退出、切换会话或 `/reload`)会关闭
   watcher 和尚未执行的 debounce timer;新的会话实例会重新捕获基准并启动自己的守卫。

扩展 factory 只安装全局补丁、注册事件和命令,不会启动 watcher 或 timer。补丁使用结构化的
`Symbol.for` 标记并在 `/reload` 时验证现有 wrapper,因此重复加载不会重复包装。文件守卫则严格
按会话和 factory 实例管理资源,旧实例的 shutdown 或延迟回调不会影响新实例。全局 wrapper
只在有 active session 时执行保护;最后一个 owner shutdown 后会立即恢复原生 setter 委托,
因此删除或禁用扩展后不会继续冻结默认值。用户的 on/off 偏好会保留并应用到下一个 session。

`SettingsManager` 是 pi 的内部 API。如果 setter 的属性形状与已测试的 Pi 0.84.2 不兼容,
扩展会在任何 setter 被修改前安全放弃主补丁,并通过 console/UI warning 明确提示;此时仅使用
session-scoped 文件守卫兜底。文件守卫启动失败时同样会警告,而不会令 pi 崩溃。该降级模式不能
保证拦截文件守卫无法观察到的未来内部写入路径,因此不宣称对所有未来 pi 版本始终兼容。

## 注意

- 保护开启时,`/model` 只切换当前会话的模型,**不会**成为新的默认模型。
- 想永久修改默认值: `/keep-defaults off` → 用 `/model` 选好 → `/keep-defaults on`;
  或者直接编辑 `settings.json`(建议在 pi 未运行时编辑)。
- 首次启动时若某个字段原本不存在,第一次出现的值会被自动当作基准并冻结。

## License

MIT © 2026 oai404iao. See [LICENSE](LICENSE).
