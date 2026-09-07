# 设计块格式

本文件是 `feature-manager` 的披露参考,定义设计文档的结构规范。`to-spec`、`to-tickets`、`implement` 均引用本文件作为**单一事实源**。

## 文件路径

```
docs/features/
├── v1.0.0.md         # v1.0.0 版本所有 feature 设计
├── v1.1.0.md         # v1.1.0 版本所有 feature 设计
└── unplanned.md      # 未确定版本的设计草案
```

## 双层结构

`docs/features/v{VERSION}.md` 采用双层结构,两层必须同时存在:

### Part A - 版本级叙事(可选但常见)

描述"这个版本整体要做什么":版本目标、本版本范围、MVP 主流程、验收标准、前端/架构基线等。很多项目习惯先手写这部分。

### Part B - Per-Feature 设计块(必须)

每个 feature 一个独立的 `## FEATURE_{ID}: {Title}` 块,含 6 节:

1. **需求概述** — 功能目标
2. **影响范围** — 需创建/修改的文件
3. **技术方案** — 依赖、架构模式
4. **接口契约** — API、数据模型
5. **实现步骤** — 可执行的票(由 to-tickets 填充)
6. **验收标准** — 可验收的行为

### 为什么两层都要有

仅有 Part A 的"纯版本级叙事"格式会导致:
- `FEATURE_LIST.md` 中 `docs/features/v{VERSION}.md#{ID}` 锚点不存在
- 实施时 coding agent 只能从散落叙事里推测单个 feature 的意图
- 不同 feature 边界模糊、共享版本级叙事 → **实现明显偏离**

## spec → 设计块映射(to-spec 用)

to-spec 产出的 spec 各节对应设计块 Part B 的节:

| spec 节 | 设计块 Part B 节 |
|---------|-----------------|
| Problem Statement + Solution | 需求概述 |
| Implementation Decisions | 影响范围 / 技术方案 / 接口契约 |
| User Stories + Testing Decisions | 验收标准 |

## 票 → 实现步骤映射(to-tickets 用)

to-tickets 产出的票写入设计块 Part B 的**实现步骤**节。路径与代码片段规则同 to-spec。

## 自动抽取机制(Start Next Feature 用)

当 Start Next Feature 发现目标 feature 缺少 Part B 设计块(Case C)时:

1. 读整份 `docs/features/v{VERSION}.md`
2. 识别与本 feature 相关的内容碎片
3. 起草 6 节内容(**不发明、不越界、可归因**):
   - 需求概述: 从版本范围 + feature 标题 + 点名段落得出
   - 影响范围 / 接口契约: 有就抽,没有就写 `_待 Plan 阶段细化_`
   - 技术方案: 只保留本 feature 用得到的版本技术基线部分
   - 实现步骤: 通常留 `_待 Plan 阶段细化_`
   - 验收标准: 从版本级验收标准中挑出仅适用于本 feature 的条目
4. 展示草案给用户(附归因章节列表),Y 采纳 / n 终止 / edit 编辑
5. 采纳后追加到文档末尾(按 ID 排序插入),**不修改原版本级叙事**
6. 更新 `FEATURE_LIST.md` 中 Design 链接确保锚点对应

Add Feature 向"纯版本级叙事"格式的文档追加新 feature 时,会发出一次性警告,提示同版本已有 feature 将在 Start Next Feature 时被按需抽取。
