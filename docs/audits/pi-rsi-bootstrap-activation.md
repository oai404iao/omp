# Pi RSI 0.1.0 首发核验与激活

`@oai404iao/pi-rsi@0.1.0` 已由维护者手动发布。受保护发布沿用现有流程；
此版本只能按已发布制品恢复，不再走本地 bootstrap。

## 首发制品

- [npm 精确版本](https://registry.npmjs.org/@oai404iao/pi-rsi/0.1.0) 的 `gitHead` 与首发 manifest 的 `commit`、`sourceCommit` 均为
  [`e386242bab2084ce0294064ce4a6056097c28f1a`](https://github.com/oai404iao/omp/commit/e386242bab2084ce0294064ce4a6056097c28f1a)，在公开 `main` 上可达。
- [公开 tarball](https://registry.npmjs.org/@oai404iao/pi-rsi/-/pi-rsi-0.1.0.tgz) 共 7,005 字节、9 个文件，下载后与保存的首发 `.tgz` 逐字节一致。
  实际 SHA-512 与 registry、首发 manifest 及[不可变锁记录](../../release-locks/npm-published-artifacts.json)一致；归档内的包名、版本、`gitHead` 一致。
- 核验时 `latest=0.1.0`，无其他 dist-tag。可见版本为 `0.1.0` 与 npm 标记 `stub: true` 的 `0.0.0-stage`；此稳定版本不需要历史或标签例外。

## 授权与验证边界

维护者确认已在 npm 保存 GitHub Actions Trusted Publisher：`oai404iao/omp`、`publish.yml`、`npm-publish`，按仓库配置允许 `npm publish`。
非交互式 `npm trust list` 返回 `EOTP`；npm 侧配置的依据是维护者确认，不是独立读回或实际 OIDC 发布测试。
GitHub environment 读回显示部署限受保护分支，审批人为 `oai404iao`，`NPM_PUBLISH_ENABLED=true`；[发布 workflow](../../.github/workflows/publish.yml) 另限 `main`。

核验时尚无此版本的包级 Git tag 或 GitHub Release。若需补齐，在激活合并后单独授权受保护恢复；不重新发布 `0.1.0`。
