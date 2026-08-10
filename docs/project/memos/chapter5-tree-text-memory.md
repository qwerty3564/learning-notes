# 第五章：TreeTextMemory——从向量检索升级到图结构记忆

## 为什么需要树结构记忆

上一章的 `GeneralTextMemory` 本质是：

```text
Memory → Embedding → Vector DB
Query → Embedding → Top-K
```

它擅长回答“哪几条记忆和问题最相似”，但不擅长表达“这些记忆之间是什么关系”。例如系统里有：

```text
A：用户正在做 MemOS 项目
B：MemOS 项目使用 Qdrant
C：用户最近在学习向量数据库
```

查询“我的项目用了什么数据库？”时，纯向量检索希望直接找到 B；但如果 B 和问题字面相似度不高，而 A 很相似，就可能只召回 A。TreeTextMemory 的思路是：先找到相关节点，再利用图中的邻居和关系把相关上下文一起找出来。

因此两者最大的区别不是“有没有 Embedding”，而是：

```text
GeneralTextMemory

Memory A
Memory B
Memory C

彼此基本平铺


TreeTextMemory

用户
└── 项目
    └── MemOS
        ├── 使用 Qdrant
        └── 使用 Neo4j
```

TreeTextMemory 仍然使用 Embedding，只是额外保存节点关系和更丰富的 Metadata。

## 整体结构与写入

核心文件：

```text
src/memos/memories/textual/tree.py
```

当前初始化时主要创建：

```text
TreeTextMemory
├── extractor_llm
├── dispatcher_llm
├── embedder
├── graph_store
├── reranker
├── bm25_retriever（可选）
├── MemoryManager
└── internet_retriever（可选）
```

其中 `extractor_llm`、`dispatcher_llm`、Embedder、GraphStore、Reranker 都通过 Factory 根据配置创建；`MemoryManager` 则接收 GraphStore、Embedder 和 LLM，负责真正的记忆组织与写入。

对比上一章：

```text
GeneralTextMemory
├── LLM
├── Embedder
└── Vector DB


TreeTextMemory
├── LLM
├── Embedder
├── Graph DB
├── MemoryManager
├── Searcher
├── Reranker
└── BM25 / Internet 等可选能力
```

所以 TreeTextMemory 已经不是简单的 Vector Store Wrapper，而是一套：

```text
记忆组织
+
图存储
+
混合检索
```

系统。

这里有一个很重要的源码事实：当前

```python
TreeTextMemory.extract(...)
```

实际上直接：

```python
raise NotImplementedError
```

也就是说，**TreeTextMemory 当前不负责把原始聊天直接抽取成结构化 Memory。**

典型链路是：

```text
Messages
 ↓
MemReader
 ↓
TextualMemoryItem[]
 ↓
TreeTextMemory.add()
```

所以需要和上一章区分：

```text
GeneralTextMemory
→ 自己提供 extract()

TreeTextMemory
→ extract() 当前没有实现
→ 主要依赖 MemReader 提前完成抽取
```

这也是为什么 MOS 的 `tree_text` 路径里会看到：

```text
MOS.add()
 ↓
MemReader.get_memory()
 ↓
TreeTextMemory.add()
```

TreeTextMemory 也没有重新定义一套完全不同的 Memory 数据对象。每个图节点仍然是：

```text
TextualMemoryItem
├── id
├── memory
└── metadata
```

区别主要是使用更丰富的 `TreeNodeTextualMemoryMetadata`，其中会记录：

```text
memory_type
status
visibility
sources
tags
embedding
created_at
usage
background
...
```

例如：

```text
TextualMemoryItem

memory =
"MemOS 项目使用 Qdrant"

metadata
├── memory_type = LongTermMemory
├── user_id = alice
├── tags = ["MemOS", "Qdrant"]
├── embedding = [...]
├── status = activated
├── source = conversation
└── background = ...
```

所以这里所谓的“树”，并不是 Python 内存里真的一定存在：

```text
TreeNode
├── children
├── children
└── children
```

而是 Memory 被保存成图节点，同时通过边组织节点之间的关系。

TreeTextMemory 的 `add()` 本身反而非常薄，可以大致理解成：

```python
def add(memories, user_name=None, **kwargs):
    return self.memory_manager.add(
        memories,
        user_name=user_name,
        mode=self.mode
    )
```

因此真正的写入关系是：

```text
TreeTextMemory.add()
        ↓
MemoryManager.add()
```

TreeTextMemory 更像对外提供统一 Memory 接口，复杂的组织工作下沉给 `MemoryManager`。

`MemoryManager` 内部会接触多种 `memory_type`：

```text
WorkingMemory
LongTermMemory
UserMemory
RawFileMemory
SkillMemory
PreferenceMemory
ToolSchemaMemory
ToolTrajectoryMemory
...
```

注意，这些不是 MemCube 的新 Slot。

真正的层级是：

```text
GeneralMemCube
└── text_mem
      ↓
  TreeTextMemory
      ↓
  图内部不同 memory_type
      ├── WorkingMemory
      ├── LongTermMemory
      ├── UserMemory
      ├── SkillMemory
      ├── ToolMemory
      └── ...
```

所以：

```text
text_mem
```

属于 MemCube 的容器划分，而：

```text
WorkingMemory
LongTermMemory
SkillMemory
```

属于 TreeTextMemory 内部的节点分类。

可以先简单理解：

```text
WorkingMemory
→ 最近、当前正在使用的记忆

LongTermMemory
→ 值得长期保存的事实和知识

UserMemory
→ 更稳定的用户相关信息
```

MemoryManager 当前还会维护 Working Memory 容量，超过限制后对较旧节点进行清理。

写入结构和 GeneralTextMemory 也明显不同。

GeneralTextMemory：

```text
TextualMemoryItem
 ↓
Embedding
 ↓
VecDBItem
 ↓
Vector DB
```

TreeTextMemory：

```text
TextualMemoryItem
 ↓
MemoryManager
 ↓
整理 Metadata
 ↓
Embedding
 ↓
Graph Node
 ↓
Graph Store
 ↓
建立 / 重组关系
```

因此数据库中不只是：

```text
Node A
Node B
Node C
```

还可能存在：

```text
A ── related_to ── B
B ── belongs_to ── C
```

TreeTextMemory 还存在 `reorganize` 能力。普通存储更像：

```text
Memory
→ 存进去
→ 完事
```

Tree Memory 的设计则更接近：

```text
Memory
→ 存进去
→ 和已有 Memory 建立联系
→ 必要时重新组织关系
```

这也是后面所谓“Memory 演化”的基础之一。

## 搜索流程

TreeTextMemory 真正复杂的地方不是写入，而是搜索。

`TreeTextMemory.search()` 不会自己完成全部检索，而是创建 `AdvancedSearcher`，向其中注入：

```text
dispatcher_llm
graph_store
embedder
reranker
BM25
internet_retriever
search_strategy
```

然后：

```text
TreeTextMemory.search()
       ↓
Searcher.search()
       ↓
真正的 Search Pipeline
```

整个搜索流程可以先压缩成：

```text
Query
 ↓
TaskGoalParser
 ↓
Embedding
 ↓
多路 Recall
 ↓
Graph / Vector / Fulltext
 ↓
Reranker
 ↓
去重 + Top-K
 ↓
TextualMemoryItem[]
```

普通 `GeneralTextMemory` 收到 Query 后，基本直接：

```text
Query
→ Embedding
→ Vector Search
```

Tree Search 多了一步 `TaskGoalParser`：

```text
Query
→ 理解用户到底想找什么
→ 再执行检索
```

例如：

```text
“我之前做 MemOS 项目的时候用了什么数据库？”
```

`fast` 模式可以近似理解成：

```text
直接使用原 Query
→ 快速检索
```

而 `fine` 模式可能先通过 LLM 理解：

```text
主题：MemOS 项目
目标：查询技术栈
关键词：数据库
```

再使用这些结构化信息帮助后续搜索。

因此最简单的理解是：

```text
fast
→ 少做 LLM 推理
→ 速度优先

fine
→ LLM 先理解 Query
→ 精度优先
```

如果 fine 解析失败，还可以退回 fast。

需要注意，Tree Memory 并没有因为使用 Graph 就放弃 Embedding。Query 解析之后仍然会生成一个或多个 Embedding，所以应该理解成：

```text
TreeTextMemory
=
Vector Search
+
Graph Search
+
结构化 Query
+
Rerank
```

而不是：

```text
TreeTextMemory
=
只用 Graph DB
```

接下来 Searcher 会并行执行多条 Recall Path。基础候选来源包括：

```text
WorkingMemory
LongTermMemory / UserMemory
Keyword / Fulltext
Internet（可选）
```

根据参数还可以加入：

```text
SkillMemory
ToolMemory
PreferenceMemory
```

因此搜索已经不是：

```text
Query
→ 一个数据库
→ Top-K
```

而是：

```text
                    Query
                      ↓
                ParsedTaskGoal
                      ↓
       ┌──────────────┼──────────────┐
       ↓              ↓              ↓
WorkingMemory   Long/User Memory   Keyword
       ↓              ↓              ↓
    recall          recall          recall
       │              │              │
       └──────────────┼──────────────┘
                      ↓
                Candidate Memories
```

如果开启其他能力，还可以同时加入：

```text
Skill
Tool
Preference
Internet
```

Graph Retriever 比单纯 Vector Top-K 多出来的关键能力可以用一句话理解：

> **向量负责找到入口节点，图关系负责顺藤摸瓜。**

例如：

```text
Query：
“我的 MemOS 项目用了什么数据库？”
```

首先可能根据语义找到：

```text
[MemOS 项目]
```

然后沿图关系扩展：

```text
[MemOS 项目]
├── uses → Qdrant
└── uses → Neo4j
```

如果只做 Vector Top-K，需要“Qdrant”那条 Memory 本身和 Query 足够相似；图检索则可以通过已经找到的“MemOS 项目”继续扩展相关节点。

因此：

```text
Embedding
→ 找“相似的”

Graph
→ 找“有关联的”
```

TreeTextMemory 还可以结合 BM25 / Fulltext。Embedding 擅长：

```text
“我住哪里”
≈
“用户当前居住地”
```

这种语义匹配；但如果 Query 包含：

```text
Qdrant
MOSConfig
MemoryFactory
```

这类非常明确的技术名词，关键词搜索可能更加稳定。

所以三类 Recall 可以理解成：

```text
Vector
→ 语义相似

BM25 / Fulltext
→ 字面关键词匹配

Graph
→ 节点关系扩展
```

多路召回以后还不能直接返回，因为：

```text
Recall
≠ 最终答案
```

假设：

```text
向量召回 10 条
图召回 10 条
关键词召回 10 条
```

总共有几十条候选，这时需要：

```text
Candidates
 ↓
Reranker
 ↓
真正最相关的 Top-K
```

所以：

```text
Recall
→ 尽量不要漏掉可能相关的 Memory

Rerank
→ 从召回结果里判断哪些最应该排在前面
```

最终 Searcher 还会执行：

```text
召回
→ Rerank
→ 合并
→ Deduplicate
→ 各类型数量控制
→ Top-K
→ 更新 usage history
→ 返回
```

所以 Tree Search 是一个 Pipeline，而不是一个简单的数据库查询。

除了普通 fast / fine Search，目前高级 Searcher 还存在 `deep_search()` 思路：

```text
第一次搜索
 ↓
LLM 判断：
“这些 Memory 够回答问题吗？”

 ├── 足够
 │    ↓
 │   返回
 │
 └── 不够
      ↓
  生成新的检索词
      ↓
    再搜索
      ↓
    再判断
```

也就是说普通 Search 是：

```text
搜一次 → 排序 → 返回
```

Deep Search 更接近：

```text
搜索 → 判断信息缺口 → 再搜索
```

## Skill、Tool、Preference 节点

这也是理解 MemOS 记忆分类时很重要的一点。

Searcher 本身支持类似：

```text
search_tool_memory
tool_mem_top_k

include_skill_memory
skill_mem_top_k

include_preference_memory
pref_mem_top_k
```

的控制。

所以 TreeTextMemory 内部的图节点完全可能包含：

```text
TreeTextMemory
├── WorkingMemory
├── LongTermMemory
├── UserMemory
├── SkillMemory
├── ToolSchemaMemory
├── ToolTrajectoryMemory
└── PreferenceMemory
```

这并不意味着 `GeneralMemCube` 一定存在：

```python
cube.skill_mem
cube.tool_mem
```

这样的独立 Slot。

应该这样理解：

```text
GeneralMemCube
├── text_mem
├── pref_mem
├── act_mem
└── para_mem
```

这是**容器层分类**。

而：

```text
SkillMemory
ToolMemory
LongTermMemory
UserMemory
```

是 TreeTextMemory 图内部的**语义 / 节点分类**。

因此两者不能直接一一对应。

例如技能 Memory：

```text
“如何部署 FastAPI 服务”

步骤：
1. 构建 Docker
2. 配置环境变量
3. 健康检查
4. 检查日志
```

依然可以是一个：

```text
TextualMemoryItem
```

只不过 Metadata：

```text
memory_type = SkillMemory
```

检索时 Searcher 根据：

```text
include_skill_memory = True
```

额外搜索这部分节点。

## 与 GeneralTextMemory 的区别及完整调用链

最核心的区别可以压缩成：

|              | GeneralTextMemory | TreeTextMemory                    |
| ------------ | ----------------- | --------------------------------- |
| 主要存储         | Vector DB         | Graph Store                       |
| Memory 数据    | TextualMemoryItem | TextualMemoryItem + Tree Metadata |
| 抽取           | 自带 `extract()`    | 当前主要依赖 MemReader                  |
| 写入核心         | Embedder + VecDB  | MemoryManager + GraphStore        |
| 检索           | Vector Top-K      | 多路 Recall + Graph + Rerank        |
| Query 处理     | 基本直接 Embedding    | TaskGoalParser                    |
| 关键词检索        | 基础实现没有            | 可选 BM25 / Fulltext                |
| 关系           | 基本没有              | 节点 + 边                            |
| 检索模式         | 简单                | fast / fine / 更高级搜索               |
| Skill / Tool | 不突出               | 可以作为特殊节点检索                        |

举一个完整例子。

用户连续说：

```text
对话1：
“我最近在研究 MemOS。”

对话2：
“这个项目里我主要研究 Qdrant 和 Neo4j。”

对话3：
“Qdrant 我主要用来做向量检索。”
```

MemReader 可能得到：

```text
M1：用户正在研究 MemOS
M2：MemOS 学习涉及 Qdrant
M3：MemOS 学习涉及 Neo4j
M4：Qdrant 用于向量检索
```

写入：

```text
Messages
 ↓
MemReader
 ↓
TextualMemoryItem[]
 ↓
TreeTextMemory.add()
 ↓
MemoryManager
 ↓
Graph Store
```

最终概念结构：

```text
用户
 ↓
研究
 ↓
MemOS
├── 涉及 → Qdrant
│           ↓
│        用于向量检索
│
└── 涉及 → Neo4j
```

后来用户问：

```text
“我研究的那个记忆项目，向量搜索用什么？”
```

检索：

```text
Query
 ↓
TaskGoalParser
 ↓
识别：
记忆项目 + 向量搜索
 ↓
Embedding / Keyword / Graph Recall
 ↓
找到 MemOS / Qdrant 等候选节点
 ↓
Graph Relationship Expansion
 ↓
Reranker
 ↓
Qdrant 用于向量检索
```

因此整个 TreeTextMemory 的写入链可以总结成：

```text
Messages
 ↓
MemReader
 ↓
TextualMemoryItem
 ↓
TreeTextMemory.add()
 ↓
MemoryManager
 ↓
Working / LongTerm / User / Skill...
 ↓
Graph Store
 ↓
节点 + 关系
```

检索链：

```text
Query
 ↓
TreeTextMemory.search()
 ↓
Searcher
 ↓
TaskGoalParser
 ↓
Embedding
 ↓
并行 Recall
├── WorkingMemory
├── Long/User Memory
├── Keyword
├── Skill
├── Tool
└── Preference
 ↓
Vector / Graph / Fulltext
 ↓
Reranker
 ↓
Deduplicate + Top-K
 ↓
TextualMemoryItem[]
```

把源码进一步压缩成伪代码：

```python
class TreeTextMemory:

    def __init__(config):
        llm = LLMFactory(...)
        dispatcher_llm = LLMFactory(...)
        embedder = EmbedderFactory(...)
        graph_store = GraphStoreFactory(...)
        reranker = RerankerFactory(...)

        memory_manager = MemoryManager(
            graph_store,
            embedder,
            llm
        )

    def add(memories):
        return memory_manager.add(memories)

    def extract(messages):
        raise NotImplementedError

    def search(query, top_k, mode="fast"):
        searcher = AdvancedSearcher(
            dispatcher_llm,
            graph_store,
            embedder,
            reranker
        )

        return searcher.search(
            query,
            top_k,
            mode
        )
```

Searcher 可以继续压缩成：

```python
def search(query):

    goal = TaskGoalParser.parse(query)

    candidates = parallel_retrieve(
        working_memory,
        long_term_memory,
        user_memory,
        keyword,
        skill,
        tool,
        preference
    )

    candidates = rerank(candidates)
    candidates = deduplicate(candidates)

    return top_k(candidates)
```

所以这一章最终只需要记住：

```text
GeneralTextMemory
解决：
“哪条 Memory 和 Query 最像？”
```

TreeTextMemory 进一步解决：

```text
Query 真正想找什么？
+
哪些 Memory 可能有关？
+
这些 Memory 之间有什么关系？
+
哪些候选最值得最终返回？
```

## 本章总结

因此：

```text
GeneralTextMemory
= Vector Memory

TreeTextMemory
= Structured Memory
+ Graph Retrieval
+ Hybrid Recall
+ Rerank
+ Memory Organization
```

最重要的一句话是：

> **Embedding 负责找到“相似节点”，Graph 负责找到“相关节点”，Reranker 负责从所有候选中挑出“最应该返回的节点”。**

下一章就可以继续进入 `MemReader`：现在已经知道 TreeTextMemory 怎么存、怎么搜，接下来要解决的是 **原始聊天到底如何经过 LLM 变成这些 `TextualMemoryItem`。**
