---
name: to-spec
description: 把对话与代码库理解综合成 spec(≈PRD),写入 feature 设计块 Part B。只综合不访谈,关键决策调 grilling。
disable-model-invocation: true
---

# To Spec(规格综合)

把当前对话上下文 + 代码库理解,**综合**成一份 spec(你也许称它 PRD)。核心原则是 **synthesize not interview / 只综合不访谈**:从已有对话和代码中提炼,不逐条追问用户——真正的决策分叉才交给 `grilling`。

## 综合纪律

1. **只综合,不访谈。** 从已有对话与代码现状中提炼。能自查的事实(代码结构、现有接口、领域词汇)自己查掉。
2. **关键决策才问人。** 遇到真正的决策分叉(选 A 还是 B、要不要做 X),调用 `grilling` 确认(纪律见 grilling)。
3. **用领域语言。** 若项目有 `CONTEXT.md`(领域词汇表),先读它,让 spec 词汇匹配项目领域语言;尊重涉及区域的 ADR。

## 测试 seam 前置确认

写 spec 前,先勾勒要测试该功能的 **seam**(测试所在的公共边界)。优先复用现有 seam,尽量用最高层;需要新 seam 时,在能接受的最顶层提出。全仓 seam 越少越好,理想数量是一。

seam 与用户预期对齐后再写 spec——这让 Testing Decisions 一节有据可依。seam 的完整定义见 `tdd` skill。

## spec 模板

<spec-template>

### Problem Statement

用户面临的问题,从用户视角描述。

### Solution

问题的解决方案,从用户视角描述。

### User Stories

一长串编号用户故事,每条格式:

1. 作为 <角色>,我想要 <功能>,以便 <收益>

每条 user story 对应一个可独立验收的行为,覆盖 Problem Statement 中所有用户场景。

### Implementation Decisions

已做出的实现决策,可包括:将要构建/修改的模块及其接口、来自开发者的技术澄清、架构决策、schema 变更、API 契约、具体交互。

**只记录决策;具体文件路径与代码片段很快过期,不写。** 例外:若原型产出的片段比散文更精确地编码了某个决策(状态机、reducer、schema、类型形状),在相关决策处内联并注明来自原型,只留决策密集部分,不要整个可运行的 demo。

### Testing Decisions

已做出的测试决策:什么算好测试(只测外部行为,不测实现细节)、哪些模块将被测试、测试的先例(代码库中类似测试)。

### Out of Scope

本 spec 范围之外的事项。

</spec-template>

## 产出位置

写好的 spec 融进 **feature 设计块**。设计块路径、Part B 结构与 spec→设计块节的映射见 `feature-manager/DESIGN-BLOCK-FORMAT.md`。写完即终——本 skill 不负责拆票,那是 `to-tickets` 的事。

## 完成判据

spec 综合完毕的标志(全部满足):

- [ ] spec 模板所有节已填充(Problem Statement / Solution / User Stories / Implementation Decisions / Testing Decisions / Out of Scope)
- [ ] Testing Decisions 中的 seam 已与用户对齐
- [ ] spec 已写入 feature 设计块 Part B(节映射见 `feature-manager/DESIGN-BLOCK-FORMAT.md`)

## 与其他 skill 的关系

- `grilling`:spec 中的关键决策点调用 grilling 确认,事实自查、决策才问人。
- `tdd`:Testing Decisions 涉及的 seam 概念,以 tdd skill 的定义为准。
- `to-tickets`:把 spec 进一步拆成可执行的追踪弹票。
- `implement`:消费 spec + tickets 作为构建依据。
