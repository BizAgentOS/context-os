---
name: implement
description: 在 spec/tickets 的 pre-agreed seams 上测试先行开发,完成后 code-review,提交代码。
disable-model-invocation: true
argument-hint: "[ticket-ref | feature-id]"
---

# Implement(构建)

在 spec 和 tickets 描述的工作上构建代码。逐票推进,每张票一个 tdd 循环,做完后 code-review,提交。

## 流程

1. **读 spec/tickets**——从 feature 设计块(Part B,格式见 `feature-manager/DESIGN-BLOCK-FORMAT.md`)或 issue 详情中读出要构建的内容。
2. **逐票构建**——对每张 tracer-bullet 票:
   - 在 pre-agreed seam 上调用 `tdd`(先红后绿,一个 seam 一个循环)
   - 定期跑 typecheck 和单测
   一张票做完再做下一张(work the frontier——推进无阻塞的前沿票)。
3. **收尾全量测试**——全部票做完后,跑一次完整测试套件 + typecheck + lint + build,确保全绿。
4. **代码评审**——调用 `code-review`,对本次 diff 做双轴评审(Standards + Spec)。
5. **提交**——评审通过后,提交到当前分支。

## 完成判据

- 每张票有测试通过(tdd red→green 已执行)
- 全量测试 + typecheck + lint + build 无错
- code-review 已跑,Critical/High finding 清零或用户明确接受
- 代码已提交到当前分支

## 与其他 skill 的关系

- `tdd`:逐票调用,在 pre-agreed seams 上测试先行
- `code-review`:构建完成后调用,双轴评审
- `to-spec` / `to-tickets`:产出本 skill 消费的 spec 和票
- `feature-manager`:构建链的上一步(Start 指向本 skill),下一步(Complete)
- `issue-manager`:修复链中本 skill 负责构建修复

> Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) — implement skill.
