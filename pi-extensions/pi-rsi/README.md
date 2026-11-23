# pi-rsi

`/rsi` 给一条用户指令的执行结果留下本地反馈。默认评当前分支的最近一轮，也可以在会话树中选历史指令。
安装已发布版本使用 `pi install npm:@oai404iao/pi-rsi`。若要从源码试用，在仓库根目录运行 `pi -e ./pi-extensions/pi-rsi`，即可仅在这次会话中加载扩展。

| 命令 | 效果 |
| --- | --- |
| `/rsi good` | 直接保存好评，不需要说明。 |
| `/rsi bad 只改了代码，没有复现问题` | 直接保存差评和说明，不需要给说明加引号。 |
| `/rsi` | 选择 `good` 或 `bad`，再填写可选的多行说明。留空确认仍会保存，Esc 取消则不保存。 |
| `/rsi tree` | 在 TUI 中浏览当前会话的所有分支，选择历史用户指令后评分。不会切换分支、修改标签或生成摘要。 |

直接提交不需要交互界面。目标以打开命令时的会话为准，表单期间的新消息不会改变它。
历史选择器默认显示用户消息。如果同一指令有多个分支结果，按回答预览和条目 ID 选择；
只有一个结果则直接进入评分。任一步取消都不写文件。对同一指令再次评价会新增记录，不覆盖旧反馈。

## 数据目录

每次提交写入 `{pi_config}/pi-rsi/<id>.json`。显式设置 `PI_CODING_AGENT_DIR` 时使用 Pi 解析的目录；
否则使用 `$XDG_CONFIG_HOME/pi/agent`；XDG 未设置或不是绝对路径时，默认为 `~/.config/pi/agent`。
目录在首次写入时创建；新目录权限为 `0700`，文件为 `0600`（POSIX）。不发送网络请求，也不复制或改写聊天记录。

```json
{
  "id": "8a07072d-facf-46a9-88e2-9e70e45e3ace",
  "createdAt": "2026-11-23T08:30:00.000Z",
  "sessionId": "f15c7282-f0ca-4847-a9d1-9ee76c124010",
  "userMessageEntryId": "7ba913ef",
  "finalAssistantEntryId": "6d504ab3",
  "projectPath": "/work/project",
  "feedback": "good"
}
```

`id` 标识反馈本身。`sessionId` 与 `userMessageEntryId` 定位指令，`finalAssistantEntryId` 定位选中分支的最终助手消息。
只沿该分支查到下一条用户指令或分支末尾，不把中间工具调用或被重试的答复当作终点。
如果在生成中打分、人工打断时只有部分输出，或无法确定回答归属（例如扩展自行唤醒了模型），
仍可评价指令，记录中明确写 `"finalAssistantEntryId": null`。这两个条目 ID 不是 Pi 的运行 ID。
`projectPath` 是提交命令时 Pi 的工作目录，不要求是 Git 根目录。`createdAt` 为 UTC 提交时间；
有说明时记录 `description` 字符串，去掉首尾空白并保留内部空格和换行，无说明则省略该字段。
