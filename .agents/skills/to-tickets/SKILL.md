---
name: to-tickets
description: 把 spec/plan 拆成 tracer-bullet 垂直切片票(带阻塞边 DAG),写入 feature 设计块实现步骤。
argument-hint: "[spec-path | issue-ref]"
disable-model-invocation: true
---

# To Tickets(追踪弹拆票)

把一个 plan、spec 或对话拆成一组**票**——追踪弹(tracer bullet)垂直切片,每张显式声明阻塞它的票(blocking edges),构成一张 DAG。无阻塞者的**前沿**票可立即开工——**work the frontier / 推进前沿**。

## 追踪弹切片规则

- **垂直,不水平。** 每张票切一条窄而**完整**的路径,贯穿所有层(schema → API → UI → tests),不是只切单层的水平切片。
- **可独立 demo。** 一张完成的切片自身可演示或验证。
- **适配单个 context window。** 每张票的大小让一个全新 context 能从头到尾做完。
- **先 prefactor。** 若有让实现更轻松的重构机会("让改动变容易,再做容易的改动"),先排 prefactor 票。

**宽重构是垂直切片的例外。** 宽重构是一个机械变更(改名列、改类型),其**爆炸半径**横扫全仓,单次编辑就让数千调用点同时报错,没有垂直切片能单独绿。不要硬塞进追踪弹,按 **expand–contract** 排序:先 expand(旧形式旁加新形式,不破坏);再按爆炸半径分批迁移调用点(每批一张票,被 expand 阻塞,旧形式仍在所以 CI 逐批绿);最后 contract(无调用者残留后删旧形式,被所有迁移批阻塞)。

## 阻塞边与 DAG

给每张票标 **blocking edges**——必须先完成才能开工的票。无阻塞者的票就在前沿,可立即开工。阻塞关系构成 DAG,执行顺序从图中读出。

## quiz the user 闸门

拆完后,以**编号列表**呈现每张票供用户审阅。每张票展示:

- **Title**:简短描述名
- **Blocked by**:阻塞它的票(若有)
- **What it delivers**:这张票让什么端到端行为跑通

示例:

1. **Title**:购物车结账端到端
   **Blocked by**:无
   **What it delivers**:用户能把商品加入购物车并完成结账,全链路可跑通
2. **Title**:优惠券折扣
   **Blocked by**:#1
   **What it delivers**:结账时应用优惠券码,折后金额正确

问用户:

- 粒度合适吗?(太粗 / 太细)
- 阻塞边对吗?每张票只依赖真正 gate 它的票?
- 有票该合并或再拆吗?

**迭代到用户批准。** 批准前不落票。

## 产出

批准后的票写入 feature 设计块的**实现步骤**节。设计块格式见 `feature-manager/DESIGN-BLOCK-FORMAT.md`。供 `/implement` 消费。

## 与其他 skill 的关系

- `to-spec`:to-tickets 的输入通常是 to-spec 产出的 spec。
- `implement`:消费本 skill 产出的票作为构建依据。
- `tdd`:每张追踪弹票的实现遵循 tdd 的 red → green 循环,在 spec 前置确认的 seam 上测试。
- `grilling`:拆票中遇到范围/依赖的决策分叉,调用 grilling 确认。
