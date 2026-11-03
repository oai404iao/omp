# Pi Notify 首发核验与发布支持激活

## 状态与范围

`@oai404iao/pi-notify@0.1.0` 已由维护者手动发布，公开制品与首发准备制品一致。
本变更将唯一目标从 `bootstrap` 转为 `publishable`，并追加不可变发布身份。
维护者针对下表精确字段确认已在 npm 保存 Trusted Publisher，并明确授权合并启用。
**npm 侧配置依据为维护者本人声明，不是 CLI 或浏览器独立读回。**
此次授权仅启用受保护发布支持，不是 npm 发布批准，也不代表实际 OIDC 发布成功。

## 首发身份核验

| 项目 | 已核验值 |
| --- | --- |
| 包／版本 | `@oai404iao/pi-notify@0.1.0` |
| npm `gitHead`／制品源码 | `915f7e4811de6f737607005f4da758fe86393c14`，公开 `main` 可达 |
| dist-tags | `latest=0.1.0` |
| 可见版本历史 | `0.0.0-stage`、`0.1.0`；未为 notify 添加历史／alias 例外 |
| tarball | [npm 公共制品](https://registry.npmjs.org/@oai404iao/pi-notify/-/pi-notify-0.1.0.tgz) |
| 大小 | 12,062 字节，与先前已核验归档逐字节相同 |
| SHA-512 | `48f17b676ef2bd0e5319f047aac4ea4fb4a550043f35b28a5e8570a388c69a0b1809e75aaad366b636f7ac932e1810cb9256aa9bdd77828a3b99d4ac4996eb85` |
| npm integrity | `sha512-SPF7Z27yvQ5TGfBHqsTqT7SlUAQ/NbKKXoVwo4jGmgsYCedaqtNmtjb3rJMuGBDLklaqm913goo7mdSsSZbrhQ==` |

核验先只读获取 npm packument 和精确版本，再下载实际 tarball，验证 SHA-512、
与原归档逐字节相等、manifest 及文件清单；不是只比较 registry 声称的 integrity。
归档只有 `CHANGELOG.md`、`LICENSE`、`README.md`、`index.ts`、`package.json`
和 `src/{notification,settings,telegram}.ts`。本次没有修改包 payload、版本或依赖，
因此无需 changeset；`0.1.0` README 保留首发时的历史准备说明。

## 现有 Actions 接入与维护者授权确认

直接复用 `.github/workflows/publish.yml`，不新增 workflow 或旁路：

- 仅 `workflow_dispatch`，验证 job 限 `refs/heads/main`。
- 发布 job 使用 `npm-publish` environment、`id-token: write`、固定 npm 11.19.0；
  使用已验证的精确 tarball，并启用 provenance。
- 已读回 GitHub environment：受保护分支策略、维护者 `oai404iao` 审批，
  environment 变量 `NPM_PUBLISH_ENABLED=true`。workflow 的 main 限制保持不变。
- artifact manifest／消费者 receipt、精确 SHA 覆盖、依赖优先、已发布版本恢复、
  registry identity／tags 校验和 GitHub 对账门禁均保持原实现。
- 只变更 notify 资格；普通发布选择由 8 增至 9，完整 CI 仍为 9 个包。
  通用 bootstrap 拒绝规则和单包精确选择仍受测试约束。

此前实际 `/usr/bin/npm` 执行 `npm trust list @oai404iao/pi-notify --json`
返回 `EOTP`，浏览器公共包页遇 Cloudflare 安全质询，未完成独立读回。
随后维护者针对已提供的精确字段确认已保存配置并授权合并启用，作为本人配置声明及
合并授权记录；没有把此前失败的查询改写为成功，也没有再次索取 2FA 或验证码。

维护者确认保存的 [npm 包设置](https://www.npmjs.com/package/@oai404iao/pi-notify)
Settings → Trusted Publisher 字段：

| 字段 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Owner | `oai404iao` |
| Repository | `omp` |
| Workflow filename | `publish.yml` |
| Environment | `npm-publish` |
| Allowed action | `npm publish`，不额外授予 dist-tag 权限 |

此前独立审阅和测试已完成；维护者确认后，激活 PR 可按正常必需检查和合并流程收束。
上述本人声明不能替代独立配置读回或实际 OIDC 验证。真实 OIDC 发布须留待另行批准的新版本发布验证，
不得为测试而重发 `0.1.0`、伪造版本或 dispatch 写 npm 的 workflow。
首发 tag／GitHub Release 若缺失，也留待激活完成后按既有受保护恢复流程对账；
本次未执行该 dispatch。

官方参考：[Trusted publishers](https://docs.npmjs.com/trusted-publishers/)、
[npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)。
