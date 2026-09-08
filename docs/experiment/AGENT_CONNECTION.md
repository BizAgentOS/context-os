# 第三方 Agent 接入与数据发布

2026-09-08，FEATURE_009。本次本地 MVP 已提供实际 MCP stdio 工具与 HTTP 消费入口，复用原本体和授权服务。不是将本体文件复制进每个 Agent：调用方按已确认的范围读取企业对象，企业记忆由 DataEngine 持续维护。

## 从第四页接入

1. 启动 `npm run demo` 或 `npm start`，进入“数据消费”。保持 DataEngine 服务运行。
2. 点开一个已启用调用方，查看“可读取的内容”。如果已有它的密钥，展开“接入配置”，复制 MCP 模板或 HTTP 地址。
3. 为另一个 Agent 使用独立身份：点击“创建同范围的独立接入”，填写名称和用途。先查看新草稿的类型、字段和关系，再点“启用访问”。密钥只在启用窗口交付一次。
4. MCP 模板使用当前机器的 Node 和桥接脚本绝对路径。将 `DATAENGINE_CONSUMER_KEY` 占位符换成该调用方密钥，按客户端的配置格式添加。本机 JSON 模板不是远程 MCP URL，不同客户端的设置格式可能不同。
5. Agent 先调用 `describe_memory`，再用 `query_objects` 查询许可范围内的对象和关系。其他应用也可以直接使用 HTTP。

调用方密钥、管理员入口和模型 API Key 是三个不同用途的凭据。桥接程序不读取本地记忆数据库或管理凭据；所有消费都经过同一 HTTP 授权检查。真实消费接口不返回来源原文、映射或完整证据。

## HTTP 与工具

```sh
curl 'http://127.0.0.1:8794/v1/schema' \
  --header "Authorization: Bearer $DATAENGINE_CONSUMER_KEY"

curl --get 'http://127.0.0.1:8794/v1/objects' \
  --header "Authorization: Bearer $DATAENGINE_CONSUMER_KEY" \
  --data-urlencode 'type=投诉' \
  --data-urlencode 'id=TS002' \
  --data-urlencode 'relation=居民回访' \
  --data-urlencode 'fields=反馈结果'
```

上面的类型、字段和关系必须确实已授予调用方。MCP 查询接受同名参数，其中 `fields` 为字符串数组；支持有界 `offset` / `limit` 和可选的 `dataVersion`。描述接口仅返回获准的类型说明、字段、关系、本体版本和发布数据版本。

MCP 使用固定版本的官方 TypeScript SDK，支持 2025-11-25 与 2026-07-28 协议客户端。协议和接入形式参考 [MCP 本地服务指南](https://modelcontextprotocol.io/docs/develop/connect-local-servers)与[官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。运行时标准输出仅用于 MCP 协议，凭据不进入工具结果或日志；HTTP 跳转不自动跟随。

## 数据怎样持续改变

在“数据”页更新同名资料后，新资料形成新版本。已有调用方仍读自己的已发布记录。在调用方详情中点击“检查数据更新”，查看准确的来源版本变化与检查结果；再点“发布给此调用方”，这组映射资料一起生效。

| 情况 | 调用方看到什么 |
|---|---|
| 新资料刚接入 | 原来发布的数据 |
| 检查后发布给某调用方 | 该调用方用原密钥读到新记录，其他调用方保持原版本 |
| 查询携带旧 `dataVersion` | 409 `data_version_changed`，重新描述并重做当前查询或批次 |
| 文件缺列、对象编号无效、预览已过期 | 不发布，之前的数据与密钥继续有效 |
| 字段被重新标为敏感 | 当前限制立即作用于已有授权读取，必要时拒绝 |
| 改变对象类型、字段含义或关系 | 先确认新的本体与相应权限，数据发布不代替这一步 |
| 停用调用方 | 其 MCP 与 HTTP 下一次请求被拒绝 |

目前发布的是本体已映射的 CSV 记录；本体语义文档保持采用时的证据版本。新接入草稿从本体保存时的数据起步，可以随后检查并发布更新。旧验证结果和来源版本仍可追溯；第三方 Agent 已缓存的内容或历史回答不会被自动改写。

## 验收记录

- `npm run check`：类型检查与 66 项 Agent 测试通过，涵盖独立接入草稿/启用、真实 HTTP 权限、结构过滤、数据更新、旧版本冲突、失败保留、敏感分类、凭据锚点、重启和撤销。
- 真实 MCP 子进程：两代协议握手、工具发现和调用通过。工具输入受限，权限拒绝及发布冲突保持明确错误。
- 热力服务 + 实际 MCP：TS002→HF002 初始为“未改善”，资料修改后未发布仍为“未改善”；发布后旧版本查询返回 409，重新描述后同一桥接进程和密钥读取“已改善”；停用后为 401。
- 隔离浏览器空间 `local-state/agent-connection-verify`、端口 8795：实际创建草稿、查看权限、启用、交付凭据、上传新回访、预览 v1→v2、发布和停用。同一客户端密钥在发布前后读取到对应记录，未改变本体 v3 或其他调用方。
- 主演示 8794：只读查看 MCP/HTTP 配置、复制占位模板、无更新的检查结果；390px 窄屏无页面横向溢出，底部输入框保持前景浮层。迟到配置/预览响应不会重开已离开的详情。
- 浏览器关闭凭据交付后同步清空密钥；Escape 路径也清空，源码语法及 diff 检查通过。
- 图片留在忽略目录 `output/playwright/consumer-agent-overview.png`、`consumer-data-preview.png`、`consumer-data-published.png`；凭据、测试数据库和运行记录不提交 Git。

当前仍是单机实验，第三方消费只读，不含按员工/片区的记录级权限。云端 Agent 接入还需要可访问的部署地址及相应认证；定时接入真实 API、自动检查发布、推送通知和远程 MCP 服务尚未实现。
