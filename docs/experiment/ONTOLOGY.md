# 来源、本体候选与对象预览

T002-01 的实现采用一个标准库Python脚本、一个候选JSON及文件对象包。当前正式确认尚未完成，先看 [确认摘要](ONTOLOGY_REVIEW.md)。FEATURE_002 保持InProgress，T002-01不提前勾选。

## 四个命令

在产品Git根目录执行。先按 [生成说明](GENERATOR.md) 准备 `data/generated/chengchuan-20260119`。

```sh
# 从可见来源调用模型提出新候选；需要环境变量DEEPSEEK_API_KEY
python3 scripts/ontology.py propose --snapshot data/generated/chengchuan-20260119 --output runs/ontology-new-proposal

# 从当前已校验候选生成对象预览；不调用模型
python3 scripts/ontology.py build --snapshot data/generated/chengchuan-20260119 --candidate config/ontology/candidate-v1.json --output data/generated/ontology-v1-preview

# 读取对象及出入关系
python3 scripts/ontology.py get --store data/generated/ontology-v1-preview --id Ticket:CS-009

# 取回对应原始行、文件哈希与关系依据
python3 scripts/ontology.py evidence --store data/generated/ontology-v1-preview --id Ticket:CS-009
```

本次build/get/evidence已实际运行，输出目录已存在，复跑build时需换新目录；命令拒绝覆盖。首次propose及一次模型修订保存于 `runs/ontology-extraction-v1/`；`propose`不自动纠正语义错误，原始候选需要检查，失败与修订不能覆盖为一次成功。

模型读取所有当前业务文档，以及CSV列、主键、数量和样例；小表给全部行，超过30行的表只给前两行及最多一条显式缺失样例。程序生成对象时读取完整来源。模型调用隔离于基线题库和生成器历史，复用已有HTTP适配器；没有修改被冻结的基线脚本或配置。

## 对象包

| 文件 | 用途 |
|---|---|
| ontology.json | 类型、属性类型与单位、业务指标定义、约束和待确认事项 |
| mapping.json | 类型与CSV/主键的对应；直接字段、有效期登记和地址别称映射 |
| objects.json | 对象、关系、没有匹配记录的项目 |
| snapshot/ | 仅当前manifest及其登记来源的副本，不复制邻近作者文件 |
| store.json | 数据时点、本体/映射版本、候选哈希、文件哈希与数量 |

对象ID由“类型ID:源主键”构成，在类型ID和源主键不变时稳定；不承诺类型重命名后自动迁移，演变与迁移属于后续任务。属性保留原列名，模型声明的数值列转换为number，空值为null；引用到的源行仍保留原始字符串。初版用同一份源行证据追溯各属性，不重复存储每个属性的整份证据。

本体版本和Mapping版本分别记录为 `v1-candidate`、`m1-candidate`。对象详情返回二者和数据时点。文件校验用于发现意外修改，不是密码学签名或针对恶意本地管理员的保护。

三种映射均是数据规则，不执行模型生成的Python、SQL或任意表达式：

- foreign_key：非空字段精确相等，允许一对多。例如一条投诉有多次回访，保留全部记录。
- lookup：按监测时间选择标签登记的有效区间，再联系台账ID；区间左闭右开，空valid_to表示未结束。无匹配或多义时不强行连接。
- address：仅用来源支持的小区别称和数字楼号匹配楼栋；保留完整门牌，但不据此造住户对象。未登记地址或多义结果列为未解析。

不会用关闭状态、同址、时间接近或共用工单建立根因结论。731条连接是有来源的记录关系，不是731条已确认业务因果。

## 确认与版本保存

正式保存需要产品负责人对 [确认摘要](ONTOLOGY_REVIEW.md) 作出明确决定。程序支持在build时传入 `--approval`，其JSON必须含decision=approved、当前candidate_sha256、当前snapshot_manifest_sha256、reviewer与statement。程序核对候选和快照哈希，写入新对象包中的approval.json；确认后的版本为v1和m1，旧预览保留。

本轮没有生成真实approval文件，也没有代用户填写审核人。自动测试中的“test fixture”确认仅用于临时目录验证程序行为，不代表真实批准。确认记录由可信操作人员根据实际用户决定填写；此原型不建设身份认证和审批系统。

## 当前验证和边界

本次实际预览含738个对象、731条关系；来源引用、地址匹配、监测标签有效期、空值、重读一致性、候选字段和引文、文件篡改拒绝、确认哈希绑定均有检查。类型和关系的业务含义还需看确认摘要；引文存在不等于语义自动正确。

```sh
python3 -m unittest discover -s tests -v
python3 -m compileall -q scripts tests
```

测试使用公开源记录和小型测试候选，不读取私有评测答案。T002-01只登记指标定义，没有将两项指标变成可调用函数；函数/MCP/外部消费在T002-02进行，本轮不做方法效果对比。对象包和模型运行记录位于Git忽略目录；候选、提示、来源记录和实现代码进入版本管理。
