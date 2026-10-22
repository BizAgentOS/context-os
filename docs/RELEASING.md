# Context OS 的 GitHub Release 发布流程

本流程保留双方的仓库写入权限，只允许 NoraJing 通过此工作流发布稳定版本。它是约定的发布入口；GitHub 的 Write/Admin 权限仍可直接从网页或 API 发布 Release，也能修改本流程，不能将它视为独立的发布权限隔离。组织目前采用 Free 套餐和私有仓库，本方案不升级套餐、不更改任何成员权限。

## 流程文件

- `.github/workflows/release.yml`：手动触发、串行执行的发布工作流。
- `scripts/release-gate.mjs`：仅使用 Node 内置模块及 GitHub 官方 REST API 的校验和发布逻辑。

## 日常使用

1. 开发者照常提交代码。先按 [AGENTS.md 的版本准备步骤](../AGENTS.md#版本与发布)完成验证、版本文件和发布记录，再合入 `main`。对应提交中的 `package.json.version` 与要发布的版本一致。
2. NoraJing 确认该提交后，打开[发布工作流](https://github.com/BizAgentOS/context-os/actions/workflows/release.yml)（Actions → **Publish release (NoraJing)**），点击 **Run workflow** 并选择 `main`。
3. 输入稳定版本标签，例如 `v0.3.2`，以及已经确认的完整 40 位 commit SHA。输入的是具体提交，不会在执行时改为最新 `main`。
4. 工作流先用只读令牌验证，再由拥有 `contents: write` 的发布任务创建标签与 GitHub Release。Release 说明自动生成，并记录确认人、commit SHA 与本次运行链接。

当前版本仍为 `0.3.1`；示例 `v0.3.2` 只表示输入格式。本次配置不发布任何产品版本，也不改变现有成员权限或历史 Tag。

## 执行约束和失败处理

- 首次触发人须同时匹配 `NoraJing` 和 GitHub 用户 ID `46467776`。重新执行时，实际点击重新执行的人也必须是 `NoraJing`；其他账号重新执行她的旧运行不会取得发布任务的写入令牌。
- 只允许在 `BizAgentOS/context-os` 的 `main` 工作流上运行；提交必须在 `main` 历史中，且包版本与标签完全一致。当前仅支持稳定 `vX.Y.Z`，不支持预发布标签。
- 已有标签可以复用，但其最终 commit 必须与确认 SHA 完全相同；支持已存在的轻量和附注标签。已有 GitHub Release 或草稿会使流程失败，不会覆盖、删除或重新发布；分页列表检查草稿，发布任务在任何写入前使用有写入权限的令牌重复检查，避免只读任务看不到草稿的情况。
- 标签不存在时会显式创建指向该 SHA 的附注标签，随后校验标签，再发布 Release。不会移动任何旧标签。如果标签创建后发布失败，已创建的正确标签会保留；排除错误后重新触发同一 SHA 即可，不需要删除标签。
- 所有本流程发布串行执行。若拥有 Write/Admin 的人绕过流程并发修改标签，无法保证跨多个 API 请求的原子性；脚本会在发布前后检查并报告不一致，但这不提供抵抗其他写入者的权限边界。
- 已存在的旧版本标签如没有对应 Release，可以使用其对应的历史 SHA，但仍要求该提交的包版本一致且在 `main` 历史中。GitHub 如对历史提交的工作流权限返回拒绝，流程会失败，不会调整权限或移动标签。

## 本地验证

无需 GitHub 令牌即可运行语法检查与独立 mock 测试：

```sh
node --check scripts/release-gate.mjs
node --test tests/agent/release-gate.test.ts
```

测试通过 mock API 校验身份、重新执行人、提交、版本、旧标签保护和固定 SHA；不得调用真实发布接口来测试。本次配置验证不会创建真实标签或 Release。

工作流只使用官方 `actions/checkout`，固定到通过官方仓库 API 核验的 v4 提交 `11d5960a326750d5838078e36cf38b85af677262`，并设置 `persist-credentials: false`。校验任务仅有 `contents: read`；发布任务通过身份与前置任务检查后才有 `contents: write`。不需要 PAT、第三方 action 或新的密钥。

GitHub 官方依据：[仓库角色与 Release 权限](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)、[Release API](https://docs.github.com/en/rest/releases/releases#create-a-release)、[私库审批保护的套餐限制](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers)。
