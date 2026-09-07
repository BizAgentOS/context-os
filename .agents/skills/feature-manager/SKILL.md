---
name: feature-manager
description: 管理 feature 全生命周期。当用户想添加/开始/完成 feature,或说"加个功能/新功能/开始开发功能/完成功能"时使用。
argument-hint: "[description] | [id] | [-v version]"
---

# Feature Manager(feature 管理)

用 FEATURE_LIST.md 和 docs/features/ 设计文档追踪、规划、管理 feature 的生命周期。

> 报 bug / issue → 转 `issue-manager`;问已有功能(非新需求)→ 不激活。

## Feature Status Lifecycle

```
Planned ──────► InProgress ──────► Completed
```

## Core Actions

### 1. Find or Create FEATURE_LIST.md

任何操作前先定位或创建文件:

1. 用 Glob 查找 `**/FEATURE_LIST.md`
2. 找到 → 用现有位置;未找到 → 询问用户偏好(`docs/`(推荐)或 `.claude/`(private))
3. 按需创建目录,初始化空模板;文件损坏则尝试恢复

**完成判据**: FEATURE_LIST.md 存在且可读写,或已确认沿用现有文件位置。

> FEATURE_LIST.md 文件结构见 `REFERENCE.md`。

### 2. Add Feature

**输入**: Feature 描述 / 需求(来自文本或文件)

**版本分配逻辑**:
- 用户指定 `-v`: 直接用
- 有 Planned 版本: 用它(通知用户)
- 无 Planned 版本: 检测当前版本,建议下一版本,请用户确认(检测优先级见 `smart-release` 的 Version Detection Priority)

**流程**:
1. 检测版本填入 feature
2. 生成下一个顺序 ID(001, 002, …)
3. 生成 feature 元数据(Title, Description, Category, Priority)
4. 更新 FEATURE_LIST.md(Index + Details 段)
5. 创建/更新设计文档 `docs/features/v{VERSION}.md`:
   - 文件不存在: 按标准模板创建
   - 已含 `## FEATURE_` 块: 按 ID 顺序追加新块
   - 纯版本级叙事(无 `## FEATURE_` 块): 发出一次性警告(同版本已有 feature 将在 Start 时按需抽取,详见 `DESIGN-BLOCK-FORMAT.md`),用户确认后继续
6. 更新时间戳

**完成判据**: 新 feature 同时出现在 FEATURE_LIST.md 的 Index 与 Details;设计文档已含该 feature 的 `## FEATURE_{ID}` 块(或纯叙事警告已发);ID 无冲突;时间戳已更新。

> 设计块格式与双层结构见 `DESIGN-BLOCK-FORMAT.md`。Feature Categories 和 Priority Levels 见 `REFERENCE.md`。

### 3. Start Next Feature

**Phase 1 - Select**:
- With ID: 找到并确认状态为 "Planned"
- Without ID: 自动选最高优先级 Planned feature(从下一发布版本)

**Phase 2 - Ensure Design Block**:

读 `docs/features/v{VERSION}.md`,查找 `## FEATURE_{ID}`,分三种形态:
- **Case A** 设计块存在且 6 节已填充 → 作为规划输入
- **Case B** 设计块存在但 6 节为占位 → 规划后填充
- **Case C** 设计块不存在(纯版本叙事) → 从版本叙事抽取 6 节草案,展示给用户确认后追加

**Phase 3 - Point to Build Chain**:

设计块就绪后,告诉用户按构建链逐个敲:
`/to-spec` → `/to-tickets` → `/implement` → `/human-test-guide`(可选)

**完成判据**: 设计块已就绪(Case A/B/C 处理完毕);用户已被告知构建链步骤。

> Case C 抽取机制详见 `DESIGN-BLOCK-FORMAT.md`。

### 4. Complete Feature

1. 找到 feature by ID,确认状态为 "InProgress"
2. 自动检测当前版本填入 Released
3. 更新 FEATURE_LIST.md 和设计文档
4. 检查版本完成度(全部完成时提醒运行 `/smart-release` 发布)

**完成判据**: feature 状态已转 Completed;Released 版本已填;FEATURE_LIST.md 与设计文档两处均已更新;版本完成度已检查(全部完成时已提醒发布)。

### 5. Archive Features

FEATURE_LIST.md 超过阈值时归档(阈值与规则见 `REFERENCE.md`)。归档到 `FEATURES_ARCHIVED.md`,按月分组。

**完成判据**: 归档后 FEATURE_LIST.md 行数/体积降至阈值以下;被归档 feature 在 FEATURES_ARCHIVED.md 中按月分组且详情完整。

## 构建链（人驱动）

本 skill **不自动跑构建链**。Start 登记后,人逐个敲:

```
/to-spec → /to-tickets → /implement(tdd + code-review) → 提交
→ /human-test-guide(可选) → /feature-manager(complete) → /smart-release
```

每步产出流入设计块。人 review 后敲下一个。全部完成后 `/feature-manager` Complete,再 `/smart-release` 发布。

## Operations

通过 `/feature-manager` 触发以下操作:

| 操作 | 示例 |
|------|------|
| 添加 feature | "添加一个 feature:用户登录" |
| 开始下一个 feature | "开始下一个 feature"(可带 ID:"开始 feature 001") |
| 完成 feature | "完成 feature 001" |
| 归档 | "归档已完成的 features" |
| 列出 | "列出所有 features" / "有哪些 in progress 的 feature" |

> 列出功能的输出格式与过滤选项见 `REFERENCE.md`。
