# Changesets

修改包行为、公开配置、依赖或随包发布的文档时，添加 changeset：

```bash
pnpm run changeset
pnpm run changeset:sync
```

只选择受影响的包，选择适当的 SemVer 升级类型，并写面向使用者的摘要。
仅修改仓库基础设施、测试或不随包分发的文档时，不需要 changeset。

`changeset:sync` 自动维护递归消费者的生成记录，不要手改
`workspace-dependent-releases*.md`。包版本独立，经授权的版本准备使用
`pnpm run changeset:version` wrapper；不要手改版本或 changelog，也不要调用裸 Changesets version。

详见[贡献指南](../CONTRIBUTING.md#changesets)与[发布指南](../RELEASING.md)。
