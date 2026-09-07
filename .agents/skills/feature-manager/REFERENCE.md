# Feature Manager — 参考文档

本文件是 `feature-manager` skill 的披露参考,存放文件结构、分类、优先级、列表格式、归档规则等详细参考。SKILL.md 只保留流程与完成判据。

## FEATURE_LIST.md 文件结构

```
## Version Info       # 版本信息(Current Release, Planned Version)
## Version Summary    # 版本概览(状态、进度)
## Feature Index      # 快速索引表(含 Design 链接)
## Feature Details    # 完整详情
## Summary            # 统计摘要
```

## Feature Categories

| Category | Description | Example |
|----------|-------------|---------|
| **New** | Brand new functionality | User authentication, File upload |
| **Enhancement** | Improvement to existing feature | Dark mode, Search filters |
| **Refactor** | Code refactoring or optimization | API caching, Database migration |
| **Internal** | Internal tooling or infrastructure | CI/CD improvements, Logging system |

## Priority Levels

| Priority | Description | When to Use |
|----------|-------------|-------------|
| **Critical** | Must-have for release, blocking | Core functionality, security |
| **High** | Important for user experience | Major features, frequently requested |
| **Medium** | Nice to have, adds value | Improvements, optimizations |
| **Low** | Backlog / Future consideration | Nice-to-have, low impact |

## 列出 Features

当用户请求列出/查看 features 时(如 "列出所有 features"、"有哪些 in progress 的 feature"),自动执行。

### 过滤选项

| 选项 | 说明 |
|------|------|
| --all, -a | 显示所有 features(默认) |
| --planned | 只显示 Planned 状态 |
| --in-progress, --inprogress | 只显示 InProgress 状态 |
| --completed | 只显示 Completed 状态 |
| --critical | 过滤 Critical 优先级 |
| --high | 过滤 High 优先级 |
| --medium | 过滤 Medium 优先级 |
| --low | 过滤 Low 优先级 |
| --version | 按目标版本过滤 |
| --category | 按类别过滤 (New, Enhancement, Refactor, Internal) |
| --stats | 只显示统计摘要 |

### 输出格式

```markdown
=== FEATURE LIST ===
Last Updated: 2024-02-21 15:30

--- IN PROGRESS (2) ---

[NEW, CRITICAL] 001: 用户登录系统
  Planned: v1.2.0 | Started: 2024-02-25
  Description: 邮箱密码登录 + OAuth第三方登录

--- PLANNED (3) ---

[ENHANCEMENT, MEDIUM] 003: 暗黑模式支持
  Planned: v1.3.0
  Description: 跟随系统主题,手动切换

--- COMPLETED (2) ---

[ENHANCEMENT, MEDIUM] 002: 个人资料编辑 (COMPLETED 2024-03-10)
  Planned: v1.2.0 → Released: v1.2.0

=== SUMMARY ===
Total: 7 | In Progress: 2 | Planned: 3 | Completed: 2
By Priority: Critical: 1, High: 3, Medium: 2, Low: 1
Next Release (v1.2.0): 5 features (2 in progress, 2 completed)
Highest Priority InProgress: 001 (用户登录系统)
```

### 执行步骤

1. 使用 Glob 查找 `**/FEATURE_LIST.md`
2. 读取并解析文件
3. 根据用户请求应用过滤
4. 按状态 → 优先级 → 创建日期排序
5. 格式化输出

## 归档规则

当 FEATURE_LIST.md 超过阈值:
- **警告**: > 2000 lines or > 50KB → 通知用户
- **强制**: > 5000 lines or > 100KB → 自动归档 completed features > 30 天

归档到 `FEATURES_ARCHIVED.md`,按月分组。归档保留全部详情。
