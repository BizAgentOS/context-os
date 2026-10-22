# 一起开发 Context OS

仓库：[BizAgentOS/context-os](https://github.com/BizAgentOS/context-os)（私有）。加入项目的同事需要先获得仓库访问权限，再克隆代码。产品仓库不包含外层调研目录。

## 首次运行

安装 Node.js 22.18+、Git，然后执行：

```sh
git clone https://github.com/BizAgentOS/context-os.git
cd context-os
npm ci
npm start
```

打开终端给出的本机管理链接，按页面完成初始化。每位开发者使用自己的本机状态目录和模型凭据；无需复制其他人的 `local-state/` 或凭据库。macOS 默认使用 Keychain，其他环境使用独立机器密钥；模型也可在设置中配置。

## 日常协作

`main` 是共享基线，每项修改使用独立分支。例如：

```sh
git switch main
git pull --ff-only origin main
git switch -c codex/your-change
```

先读 [AGENTS.md](AGENTS.md) 与[文档中心](docs/README.md)，按本次修改的范围开发。提交前运行：

```sh
npm run check
git diff --check
```

`npm run check` 执行类型检查与本地协议测试，不调用付费模型。涉及快照、构建或发布链路时，补充 `npm run verify:snapshots`；具体检查按改动影响选择。

只提交本次修改的文件，然后推送该分支并创建目标为 `main` 的 Pull Request：

```sh
git add path/to/changed-file
git commit -m "feat: describe the change"
git push -u origin codex/your-change
```

在 Pull Request 中说明改了什么、怎么验证以及尚有限制。按团队约定检查后合并，其他同事再更新本地 `main`。上传代码不自动发布新版本；包版本、CHANGELOG 和 Tag 遵循 [AGENTS.md](AGENTS.md#版本与发布)。

## 版本发布

双方照常提交代码；GitHub Release 统一由 **NoraJing** 在[发布工作流](https://github.com/BizAgentOS/context-os/actions/workflows/release.yml)中确认版本标签与完整提交 SHA 后执行。普通 push、合并 PR 或推送 Tag 都不会自动发布。步骤与失败处理见[发布指南](docs/RELEASING.md)。

这是双方选定的流程门禁。GitHub 的 Write/Admin 同时包含直接管理 Release 的权限，网页/API 的手动发布能力仍然保留；本流程没有改变成员的仓库权限。

## 文件与状态

- 产品代码、配置、虚构测试样本与设计文档在本仓库中维护；功能状态只在[功能台账](docs/FEATURE_LIST.md)登记。
- `.env`、`local-state/`、`node_modules/`、凭据、日志、生成数据和浏览器验收产物留在本地，沿用 `.gitignore`；提交前检查 `git status`。
- 第三方代码的许可与修改记录保留在 `third_party/`；不要改变既有许可归属。
