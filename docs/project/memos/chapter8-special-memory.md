# 第八章 特殊记忆类型：偏好、技能、工具与 Tree Memory 类型体系

前面的章节主要围绕“事实型长期记忆”展开：MemReader 从原始对话中提取信息，TreeTextMemory 将其组织成图节点，Searcher 再通过向量、图结构和重排机制完成召回。但长期记忆系统并不能只保存“用户做过什么、发生过什么”。对于真正的 AI Agent，还需要记住用户喜欢什么、过去成功解决任务的方法、工具应该如何调用，以及当前信息究竟属于工作记忆还是长期记忆。因此 TreeTextMemory 在统一的 `TextualMemoryItem` 数据结构之上，又通过 `memory_type` 区分不同性质的记忆。

当前 `TreeNodeTextualMemoryMetadata.memory_type` 一共允许 10 种值：

```text
WorkingMemory
LongTermMemory
UserMemory
OuterMemory
ToolSchemaMemory
ToolTrajectoryMemory
RawFileMemory
SkillMemory
PreferenceMemory
Context
```

这些类型并不是 10 个独立的 Memory Backend，而是 TreeTextMemory 图内部节点的类型标签。它们仍然可以使用同一个 `TextualMemoryItem`，只是 Metadata、形成方式、生命周期和检索用途不同。当前 `MemoryManager` 的主要图节点写入路径会处理 `LongTermMemory`、`UserMemory`、`ToolSchemaMemory`、`ToolTrajectoryMemory`、`RawFileMemory`、`SkillMemory` 和 `PreferenceMemory`；`WorkingMemory` 则有独立的容量和清理逻辑。

## 8.1 Tree Memory 的类型体系

理解这些类型时，不适合简单背 10 个名称，更适合从“它们解决什么问题”出发进行分类。

| 类型                     | 核心问题         | 简单理解     |
| ---------------------- | ------------ | -------- |
| `WorkingMemory`        | 当前任务正在使用什么信息 | 临时工作区    |
| `LongTermMemory`       | 什么事实值得长期保存   | 长期事实     |
| `UserMemory`           | 什么信息长期描述这个用户 | 用户相关长期信息 |
| `OuterMemory`          | 哪些信息来自外部上下文  | 外部记忆     |
| `RawFileMemory`        | 哪些信息直接关联原始文件 | 文件资料节点   |
| `Context`              | 哪些节点承担上下文作用  | 上下文节点    |
| `PreferenceMemory`     | 用户喜欢什么、讨厌什么  | 个性化约束    |
| `SkillMemory`          | 类似任务应该怎么完成   | 可复用方法    |
| `ToolSchemaMemory`     | 某个工具是什么、能做什么 | 工具说明     |
| `ToolTrajectoryMemory` | 过去工具实际怎么被调用  | 工具使用经验   |

这里实际上混合了两个维度。一部分类型描述**记忆所处的范围或生命周期**，例如 Working、LongTerm、User；另一部分描述**记忆的业务语义**，例如 Preference、Skill、Tool。也就是说：

```text
WorkingMemory / LongTermMemory
回答：
“这条 Memory 应该处于什么记忆范围？”

PreferenceMemory / SkillMemory / ToolMemory
回答：
“这条 Memory 的内容应该被拿来做什么？”
```

这也是为什么不要把 `memory_type` 理解成传统数据库中的“十张完全独立的表”。在当前实现中，它更多是图节点的重要 Metadata，Searcher 可以根据 `memory_scope` 对不同类型进行定向召回；`GraphMemoryRetriever` 当前明确支持 Working、LongTerm、User、ToolSchema、ToolTrajectory、RawFile、Skill 和 Preference 等 Scope。

还有一个源码细节值得记录：`Context` 出现在 Metadata 允许值中，但当前 `MemoryManager` 主要批量写入 graph node 的类型列表并没有将 `Context` 放进去。这说明**数据模型允许某种类型存在，并不意味着所有主写入路径已经对它提供完全相同的处理逻辑**。阅读 MemOS 时，应该同时看 Schema 与 Runtime Path，而不能只根据枚举推断系统行为。

## 8.2 Preference Memory：从“知道用户”到“适应用户”

普通事实记忆主要回答：

```text
用户是谁？
用户做过什么？
现在是什么状态？
```

偏好记忆回答的则是：

```text
这个用户希望事情怎样发生？
Agent 应该怎样服务这个用户？
```

例如：

```text
事实：
用户正在学习 MemOS。

偏好：
用户希望技术解释简洁、重点突出。
```

前者可以帮助回答“用户最近在学什么”，后者不会直接回答事实问题，却会影响模型**怎样回答**。

MemOS 当前为偏好定义了专门的 `PreferenceTextualMemoryMetadata`，其中最重要的是：

```text
preference_type
original_text
preference
embedding
dialog_id
mem_cube_id
score
```

`preference_type` 明确区分：

```text
explicit_preference
implicit_preference
```

显式偏好来自用户直接表达，例如“我不吃辣”“请简短回答”；隐式偏好则来自重复行为或对话模式的推断，例如用户持续要求代码示例，系统可能逐渐认为用户偏好实践导向的解释。官方 PreferenceTextMemory 文档也明确将 LLM 抽取、Embedding、向量存储与语义搜索作为偏好记忆的核心流程。

因此偏好形成过程可以理解成：

```text
Conversation
     ↓
Preference Extraction
     ↓
判断是否存在偏好
     ↓
┌─────────────────┐
│ Explicit        │
│ Implicit        │
└─────────────────┘
     ↓
Preference Memory
     ↓
Embedding
     ↓
Preference Store
```

例如：

```text
用户：
“我不太喜欢看视频教程，
看技术文档会快一点。”

            ↓

PreferenceMemory

preference_type =
explicit_preference

preference =
用户更偏好通过技术文档学习，
而不是视频教程
```

偏好为什么不能直接当普通事实存储？关键在于它的**更新语义不同**。事实可以大量并存：

```text
用户学过 Java
用户正在学习 Python
用户最近研究 MemOS
```

这些并不互相冲突。但偏好经常存在程度变化和阶段变化：

```text
过去：
用户喜欢详细回答

后来：
用户现在更喜欢简洁回答
```

如果只是普通 Vector Store，不做任何治理，两条 Preference 都可能同时被检索出来：

```text
“回答详细一点”
“回答简洁一点”
```

最终反而让 LLM 不知道应该听谁的。因此偏好系统需要考虑重复、冲突、合并和更新。官方 PreferenceTextMemory 文档也把自动检测重复或冲突偏好、语义去重与合并列为这一模块的核心特性之一。

偏好还有一个特殊之处：它的最终使用目标不是简单“展示 Memory”，而是改变生成行为。例如：

```text
Query：
解释一下 Java 动态代理

            ↓
事实检索
→ 用户最近正在学习 Java

偏好检索
→ 用户喜欢简洁的技术解释

            ↓

Prompt

相关知识：
用户最近正在学习 Java

用户偏好：
回答应简洁并优先说明整体逻辑

            ↓
LLM
```

所以：

```text
LongTermMemory
更多用于补充“内容”

PreferenceMemory
更多用于约束“行为”
```

当前 OSS 中还存在两个容易混淆的 Preference 概念：`GeneralMemCube` 本身拥有独立的 `pref_mem` Slot，其 backend 可以是 `pref_text`；与此同时，TreeTextMemory 的图节点中也允许 `memory_type="PreferenceMemory"`。它们说明 Preference 既可以作为独立的 Preference Memory Backend 管理，也可以作为 Tree Memory 中的特殊节点参与统一图检索，两者属于不同抽象层次，并不矛盾。

## 8.3 Skill Memory：把历史经验沉淀成“以后怎么做”

如果 Preference Memory 是：

```text
“用户喜欢什么？”
```

那么 Skill Memory 解决的是：

```text
“遇到这种任务，应该怎么做？”
```

它属于典型的 **Procedural Memory（程序性记忆）**。

普通 LongTermMemory 可能保存：

```text
用户昨天成功部署了一个 FastAPI 服务。
```

Skill Memory 则进一步抽象：

```text
Skill：
部署 FastAPI 服务

Procedure：
1. 构建镜像
2. 配置环境变量
3. 启动容器
4. 执行 health check
5. 如果失败，检查日志与端口
```

两者最大的区别是：

```text
LongTermMemory
→ 过去发生过什么

SkillMemory
→ 未来再遇到类似问题应该怎么处理
```

当前源码已经为 Skill 提供专门的 Fine Processing Pipeline。技能生成时并不是孤立地只看当前一句对话，而是可以先通过 Searcher 查找已经存在的相关 Skill；`_recall_related_skill_memories()` 会先改写当前任务 Query，再执行 `searcher.search(... include_skill_memory=True)` 获取旧技能。随后 LLM 在当前 Messages、Chat History、已有 Skill 和其他相关历史信息的基础上判断应该生成新 Skill，还是更新已有 Skill。

因此可以把 Skill 形成过程抽象成：

```text
当前任务 / 历史轨迹
        ↓
识别任务类型
        ↓
Rewrite Query
        ↓
Recall Related Skills
        ↓
已有 Skill + 历史 Context
        ↓
LLM Skill Extraction
        ↓
新增 or 更新？
        ↓
SkillMemory
```

这一点非常关键。Skill 不是：

```text
每做一次任务
→ 永远增加一个新 Skill
```

而更接近：

```text
新的任务经验
      ↓
先看看以前有没有类似 Skill
      ↓
没有
→ Create

已经存在
→ Update / Refine
```

这也是“Cross-task Skill Reuse”真正能够成立的基础。

Skill 最终仍然会被包装成 `TextualMemoryItem`。当前 `create_skill_memory_item()` 会将 Skill 的 `description` 作为 Memory 主文本，并设置：

```text
memory_type = SkillMemory
status = activated
key = skill name
```

同时在 Metadata 中保存：

```text
name
description
procedure
experience
preference
examples
scripts
url
skill_source
...
```

如果这次操作被判断为更新已有技能，还可以继续使用旧 Skill 的 `old_memory_id`，而不是无条件生成一个新节点。

因此 SkillMemory 的数据结构比普通事实明显更“程序化”：

```text
SkillMemory
├── name
├── description
├── procedure
├── experience
├── preference
├── examples
├── scripts
└── source
```

例如：

```text
name:
排查 Python ImportError

description:
解决 Python 模块导入失败问题

procedure:
1. 检查当前虚拟环境
2. 检查依赖是否安装
3. 检查 Python Path
4. 检查包目录结构

experience:
虚拟环境不一致是高频原因

examples:
ModuleNotFoundError...
```

以后 Agent 再收到：

```text
“为什么我的项目一直报
ModuleNotFoundError？”
```

Searcher 可以单独启用 Skill Memory Recall，把最相关的 Skill 作为**操作方法**提供给 Agent，而不是作为普通背景事实。

因此可以把 Skill 的完整生命周期理解成：

```text
Task Experience
      ↓
Skill Extraction
      ↓
SkillMemory
      ↓
Graph Store
      ↓
下一次类似任务
      ↓
Skill Recall
      ↓
Agent Execution
      ↓
产生新的任务经验
      ↓
继续更新 Skill
```

这就是所谓“经验 → 方法 → 再使用 → 再演化”的闭环。

## 8.4 Tool Memory：从工具定义到真实调用经验

Tool Memory 又比 Skill 更进一步。Skill 关心的是：

```text
一个任务整体应该怎么完成？
```

Tool Memory 更关注：

```text
Agent 应该选哪个工具？
工具参数应该怎么填？
什么情况下调用会失败？
工具返回结果应该怎么利用？
```

Tree Memory 当前把 Tool 明确分成两种：

```text
ToolSchemaMemory
ToolTrajectoryMemory
```

这两个类型都被 `TreeNodeTextualMemoryMetadata` 和 `GraphMemoryRetriever` 支持，因此可以作为独立 Memory Scope 存储和召回。

`ToolSchemaMemory` 可以理解成工具的“说明书”：

```text
get_weather

作用：
查询天气

参数：
city: str
date: str
```

它回答：

```text
“系统有哪些工具？”
“这个工具需要哪些参数？”
```

`ToolTrajectoryMemory` 更像工具的“使用记录 + 经验总结”。例如：

```text
用户任务：
查询上海明天天气

        ↓

Agent
选择 get_weather

        ↓

参数
city = Shanghai
date = tomorrow

        ↓

Tool Result
调用成功

        ↓

ToolTrajectoryMemory
```

MemOS 当前的 Tool Trajectory Prompt 会让 LLM 对完整工具调用轨迹进行分析。它不仅记录使用了哪个工具，还判断整个任务是 `success` 还是 `failed`；对于成功轨迹，会提炼有效参数模式和调用策略；对于失败轨迹，会进一步分析是否选错工具、参数是否正确、是否调用了不存在的工具以及错误根因。最终还要求把经验抽象为可复用的 `when...then...` 规则。

因此一个 ToolTrajectoryMemory 可以近似表示为：

```text
correctness:
success

trajectory:
用户要求查询天气
→ Agent 调用 get_weather
→ 参数 city=Shanghai
→ 返回天气结果
→ Agent 正常回答

experience:
when 查询指定城市天气时
then 应明确提供标准城市名称

tool_used_status:
├── used_tool = get_weather
├── success_rate = 1.0
├── error_type = ""
└── tool_experience = ...
```

如果失败：

```text
用户要求：
查询新加坡天气

Agent:
调用 get_weather(city="")

Tool:
missing city

            ↓

ToolTrajectoryMemory

correctness = failed

error_type =
缺少必要参数 city

experience =
when 使用 get_weather 时
then 必须在调用前确认 city 参数非空
```

这里可以看到 Tool Memory 与普通事实 Memory 的根本不同：

```text
事实：
“get_weather 需要 city 参数。”

Tool Experience：
“when 调用 get_weather，
then 必须先确保 city 非空，
否则会导致参数校验失败。”
```

前者只是知识，后者已经成为 **Agent 决策规则**。

Skill 和 Tool 也不要混在一起。可以把二者理解成两个粒度：

```text
SkillMemory
= 任务级经验

例如：
“如何规划一次旅行”


ToolTrajectoryMemory
= 工具调用级经验

例如：
“什么时候调用 weather API，
参数怎么填”
```

一个 Skill 完全可能内部涉及多个工具：

```text
Skill：
规划三日旅行

procedure:
1. 搜天气
   → weather_tool

2. 搜地点
   → map_tool

3. 搜酒店
   → hotel_tool

4. 综合排序
```

Skill 管的是完整 Workflow，而 Tool Memory 管的是某个 Tool 或某段 Tool Calling Trajectory 的可靠使用方式。

## 8.5 从特殊记忆回到统一 Memory 架构

理解 Preference、Skill、Tool 以后，可以重新看 TreeTextMemory：

```text
                    TreeTextMemory
                          │
        ┌─────────────────┼──────────────────┐
        │                 │                  │
   状态 / 范围型        内容来源型          经验 / 个性化型
        │                 │                  │
 WorkingMemory       RawFileMemory     PreferenceMemory
 LongTermMemory      Context           SkillMemory
 UserMemory                            ToolSchemaMemory
 OuterMemory                           ToolTrajectoryMemory
```

这些类型虽然含义不同，但最终大量对象仍然统一成：

```text
TextualMemoryItem
├── id
├── memory
└── metadata
      └── memory_type
```

然后统一进入：

```text
MemoryManager
      ↓
Graph Store
      ↓
Searcher
```

Searcher 再根据当前任务决定到底搜索什么 Scope：

```text
普通事实问题
→ LongTerm / User

个性化生成
→ Preference

任务执行
→ Skill

Agent Tool Calling
→ ToolSchema / ToolTrajectory
```

这就是统一 Memory 数据模型的价值：**上层语义不同，但底层仍然可以共享 GraphStore、Embedding、Searcher、Reranker 和生命周期管理等基础能力。** 当前 `GraphMemoryRetriever` 就是通过一个统一 `memory_scope` 参数支持这些不同 Tree Memory 类型，并在非 WorkingMemory 路径中组合 Graph、Vector、BM25 等检索方式。

最后还需要再次区分 MemOS 中三套不同的“Memory 分类”。第一套是 `GeneralMemCube` 的实现槽位：

```text
text_mem
pref_mem
act_mem
para_mem
```

它回答“记忆以什么技术形态存在”。第二套是本章讨论的 TreeTextMemory 节点类型：

```text
WorkingMemory
LongTermMemory
SkillMemory
PreferenceMemory
ToolTrajectoryMemory
...
```

它回答“Tree 图中的这条 Memory 承担什么职责”。第三套是 MemOS Cloud 产品层暴露的业务语义 View：

```text
detail_factual
preference
profile
event
skill
tool_memory
```

它回答“产品 API 希望用户检索哪类业务信息”。Cloud 当前还把 Knowledge Base Memory 作为单独来源，通过 `knowledgebase_ids` 参与召回。

因此三者不能直接一一对应：

```text
MemCube Slot
≠
Tree memory_type
≠
Cloud memory_view
```

例如：

```text
Cloud：
tool_memory

Tree：
ToolSchemaMemory
+
ToolTrajectoryMemory
```

而：

```text
Cloud：
detail_factual

Tree 内部可能涉及：
WorkingMemory
LongTermMemory
UserMemory
```

所以学习源码时，应该始终先问一句：

> **我现在看到的“Memory Type”，究竟是在容器层、Tree 节点层，还是产品 API 语义层？**

本章最终可以压缩成四句话：

```text
LongTerm / User
→ 记住“知道什么”

Preference
→ 记住“用户喜欢什么”

Skill
→ 记住“任务应该怎么做”

Tool
→ 记住“工具应该怎么用”
```

其中 Preference、Skill 和 Tool 的共同点是：它们都不是单纯保存过去，而是在把过去的信息转换成**未来决策可以直接复用的规则和经验**。这也是它们比普通事实 Memory 更接近“Agent Memory”的地方。

下一章将重新回到最高层的 `MOS`，完整串联前面所有模块：**《MOS.add、search 与 chat：一次记忆请求如何贯穿整个系统》**。到这一章时，我们不再单独研究某个组件，而是从用户的一次调用出发，把 `MOS → UserManager → MemCube → MemReader → Memory → Searcher → LLM` 整条链真正连起来。
