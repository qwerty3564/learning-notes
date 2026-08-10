# 第七章 记忆检索系统：从 Query 到 Top-K Memory

前面已经分别理解了 `GeneralTextMemory` 的向量检索和 `TreeTextMemory` 的图结构记忆，但真正的记忆检索系统并不是简单调用一次数据库的 `search()`。当长期记忆数量越来越多以后，一个 Query 可能同时涉及当前工作记忆、长期事实、用户画像、偏好、技能、工具经验甚至外部信息，因此检索系统需要完成三个层次的问题：**先理解用户到底在找什么，再从多个记忆空间尽可能召回候选，最后从候选中筛出真正应该交给 LLM 的少量 Memory。** 当前 TreeTextMemory 的 Searcher 正是按照这种 Pipeline 组织，源码注释将主流程概括为 `Query → TaskGoalParser → GraphMemoryRetriever → MemoryReranker → ... → Final output`。

整体可以先记成：

```text
Query
 ↓
Query Understanding
 ↓
TaskGoalParser
 ↓
ParsedTaskGoal
 ↓
Multi-Path Recall
├── WorkingMemory
├── LongTermMemory
├── UserMemory
├── Keyword / Fulltext
├── SkillMemory
├── ToolMemory
├── PreferenceMemory
└── Internet（可选）
 ↓
Graph + Vector Hybrid Retrieval
 ↓
Reranker
 ↓
Dedup / Sort / Type Quota / Top-K
 ↓
TextualMemoryItem[]
```

## 7.1 从数据库搜索到检索系统

最基础的向量数据库搜索解决的是：

```text
Query
 ↓
Embedding
 ↓
Vector DB
 ↓
最相似的 K 条数据
```

但“相似”并不等于“应该返回”。例如用户问：

```text
“我之前做 MemOS 项目的时候，
向量数据库最后选了哪个？”
```

数据库里可能存在：

```text
M1：用户正在研究 MemOS
M2：MemOS 项目测试过 Milvus
M3：MemOS 项目最终选择 Qdrant
M4：用户最近在学习向量数据库
M5：用户偏好使用 Docker 部署数据库
```

M1、M4 都可能和 Query 具有较高语义相似度，但真正回答问题的核心是 M3。因此完整检索系统要解决的不只是“相似度”，而是：

```text
用户到底想知道什么？
        ↓
哪些 Memory 有可能相关？
        ↓
哪些 Memory 真正有用？
        ↓
最终应该给 LLM 哪几条？
```

这也是 Searcher 和单纯 `VectorDB.search()` 最大的区别。当前 Searcher 的公开接口除 `query/top_k` 外，还接受 `mode`、`memory_type`、`search_filter`、`search_priority`、Tool/Skill/Preference Memory 开关以及各自的 Top-K，说明它本身承担的是系统级检索编排，而不是单一数据库查询。

从职责上可以分成四层：

| 层次   | 核心组件                     | 解决的问题          |
| ---- | ------------------------ | -------------- |
| 查询理解 | `TaskGoalParser`         | 用户真正想找什么       |
| 候选召回 | `GraphMemoryRetriever` 等 | 哪些 Memory 可能相关 |
| 结果排序 | `Reranker`               | 哪些候选最值得返回      |
| 后处理  | `post_retrieve()`        | 去重、数量控制、Top-K  |

因此检索系统的设计原则通常是：

```text
Recall 阶段
→ 宁可多找一点，不要漏掉真正相关的

Rerank 阶段
→ 再从较大的候选集合中精确排序

Post-process
→ 最终只保留模型真正需要的少量结果
```

## 7.2 查询理解：TaskGoalParser 如何处理用户问题

Tree Search 首先不会直接把 Query 扔进数据库，而是进入：

```text
Query
 ↓
TaskGoalParser
 ↓
ParsedTaskGoal
```

`TaskGoalParser` 当前明确支持 `fast` 和 `fine` 两种模式。Fast 模式直接使用原始 Query，必要时通过轻量 tokenizer 得到 `keys/tags`；Fine 模式则调用 LLM，把 Query 结合上下文和最近 Conversation 转换成结构化任务表示。如果 Fine 模式调用失败，源码会自动回退到 Fast。

例如用户问：

```text
“我之前做的那个记忆项目，
最后向量数据库用了什么？”
```

Fast 模式更接近：

```text
rephrased_query =
原始 Query

memories =
[原始 Query]

keys / tags =
简单关键词或空
```

它的优势是：

```text
不需要额外 LLM
→ 延迟低
→ 成本低
```

Fine 模式则会把：

```text
Query
+
已有 Context
+
Chat History
```

一起放入任务解析 Prompt，再让 LLM 输出结构化目标。源码中 Fine 路径会把 Conversation 拼入 Prompt，再调用 `llm.generate()` 解析结果。

概念上可以得到：

```text
ParsedTaskGoal

topic:
MemOS 项目

keys:
向量数据库

goal:
查询过去项目的技术选型

rephrased_query:
MemOS 项目最终采用了哪种向量数据库？
```

Searcher 随后会优先使用 `rephrased_query` 替代原始 Query；如果 ParsedTaskGoal 额外给出了需要检索的 memories，还会将 Query 与这些辅助文本一起生成 Embedding。

因此：

```text
GeneralTextMemory

Query
 ↓
Embedding
```

而 Tree Search 更接近：

```text
Query
 ↓
TaskGoalParser
 ↓
Query Rewrite / Key / Tag / Goal
 ↓
Embedding
```

这里的核心思想与高级 RAG 中的 Query Rewrite 很接近：**用户说出来的问题，不一定就是最适合数据库检索的问题。**

## 7.3 多路召回：为什么要同时搜索多种 Memory

Query 被理解以后，系统进入 Recall 阶段。当前 Searcher 的 `_retrieve_paths()` 明确使用线程池并行运行多条检索路径，并从 `info` 中提取 `user_id`、`session_id` 形成过滤条件。基础路径会搜索 WorkingMemory、LongTerm/User Memory 和可选 Internet；如果开启 Fulltext、Tool、Skill 或 Preference，则继续增加对应任务，最终把所有任务结果合并成统一候选集合。

因此实际搜索结构不是：

```text
Query
 ↓
Database
 ↓
Top-K
```

而是：

```text
                  Query
                    ↓
              ParsedTaskGoal
                    ↓
       ┌────────────┼─────────────┐
       ↓            ↓             ↓
 WorkingMemory  Long/User      Keyword
       ↓            ↓             ↓
    Recall        Recall         Recall
       │            │             │
       ├────────────┼─────────────┤
       │            │             │
       ↓            ↓             ↓
    Skill         Tool        Preference
       │            │             │
       └────────────┼─────────────┘
                    ↓
             Candidate Set
```

为什么要分这些路径？因为不同 Memory 的“相关性”含义并不相同。

WorkingMemory 主要回答：

```text
“最近正在发生什么？”
```

LongTermMemory 主要回答：

```text
“过去长期保存了什么事实？”
```

UserMemory 更偏：

```text
“这个用户长期是什么状态？”
```

SkillMemory 回答：

```text
“类似任务过去是怎么做的？”
```

PreferenceMemory 回答：

```text
“这个用户希望怎样被服务？”
```

ToolMemory 回答：

```text
“这个工具之前怎么调用最合适？”
```

所以同一个 Query 可能同时需要多个视角。例如：

```text
“帮我规划周末旅行”
```

可能需要：

```text
LongTermMemory
→ 用户住上海

PreferenceMemory
→ 用户不喜欢购物中心

SkillMemory
→ 三日旅行规划方法

WorkingMemory
→ 用户这个周末有空
```

如果所有 Memory 都混在同一个 Vector Top-K 中竞争，很可能某种 Memory 数量太多，把其他类型挤出去，因此 Searcher 对 Skill、Tool、Preference 分别提供独立开关和独立的 `top_k`。当前 `_retrieve_paths()` 的代码正是根据这些开关动态增加对应 Recall Task。

### GraphMemoryRetriever：图搜索与向量搜索的融合

真正负责 Tree Memory 召回的核心类之一是：

```text
GraphMemoryRetriever
```

它在源码中的定位非常明确：统一组合 graph-based retrieval 与 vector-based retrieval；`retrieve()` 会执行基于图的查找和基于 Query Embedding 的向量相似度搜索，然后合并候选结果。它支持的 Memory Scope 包括 Working、LongTerm、User、ToolSchema、ToolTrajectory、RawFile、Skill、Preference 等类型。

因此：

```text
Vector Retrieval
解决：
“哪些节点和 Query 语义相似？”

Graph Retrieval
解决：
“哪些节点和已经找到的节点存在结构关联？”
```

例如：

```text
用户
 ↓
参与
 ↓
MemOS 项目
├── vector_db → Qdrant
└── graph_db  → Neo4j
```

查询：

```text
“我的 MemOS 项目用了什么图数据库？”
```

向量检索可以负责找到：

```text
MemOS 项目
```

图结构则可以沿关系继续访问：

```text
MemOS 项目
 ↓ graph_db
Neo4j
```

因此图搜索最有价值的地方并不是替代 Embedding，而是补充 Embedding：

```text
Embedding
→ 找相似内容

Graph
→ 找关系上下文
```

所以 Tree Retrieval 应理解为 **Hybrid Retrieval**，不是单纯 Graph Search。`GraphMemoryRetriever.retrieve()` 的源码注释本身也明确写的是“运行图检索、运行向量相似度检索，然后合并结果”。

关键词检索解决的又是另一个问题。Embedding 对：

```text
“我的居住地点”
≈
“用户目前住在上海”
```

这种语义表达非常有效，但面对：

```text
MOSConfig
MemoryFactory
Qdrant
vllm_kv_cache
```

这种精确技术名词时，Fulltext / Keyword 往往有独特价值。当前 Searcher 可以根据配置启用 Fulltext Keyword Path，并在 `_retrieve_paths()` 中作为独立任务参与并行召回。

因此 MemOS Tree Search 的 Recall 可以概括成：

```text
Vector
→ 语义召回

Graph
→ 关系召回

Keyword
→ 精确词召回

Memory Scope
→ 按记忆性质召回

Internet
→ 外部信息补充
```

这就是所谓“多路召回”。

## 7.4 重排与后处理：从 Candidate 到最终 Memory

Recall 阶段追求的是：

```text
“尽量找到相关候选”
```

所以它可能产生很多结果。例如：

```text
WorkingMemory       5 条
LongTermMemory     10 条
Keyword             5 条
SkillMemory         3 条
PreferenceMemory    6 条
```

最后可能有二三十条 Candidate，但不应该全部塞给 Chat LLM。下一步就需要：

```text
Candidate Memories
        ↓
     Reranker
        ↓
Ranked Memories
```

当前默认 TreeTextMemory 如果没有显式指定 Reranker，会构造一个 `cosine_local` 配置；当前本地 MemoryReranker 的基本算法是：先过滤没有 embedding 的节点，计算 Query Embedding 和候选 Memory Embedding 的 cosine similarity，再根据节点的结构层级权重调整分数，按最终得分降序排列并返回 Top-K。

概念上：

```text
Candidate A
similarity = 0.92

Candidate B
similarity = 0.83

Candidate C
similarity = 0.76

        ↓
结构权重 / Rerank
        ↓

B = 0.95
A = 0.92
C = 0.74
```

所以“数据库最先召回的结果”不一定等于“最终排名最高的结果”。

这里需要区分两个非常重要的搜索概念：

```text
Recall
目标：
扩大候选集合，尽量别漏

Rerank
目标：
提高最终排序准确性
```

也就是：

```text
Recall 关注 Recall Rate
Rerank 关注 Precision
```

对于 Memory System 来说尤其重要，因为最后进入 Prompt 的上下文容量有限，返回十几条错误 Memory 不但浪费 Token，还可能干扰 LLM 判断。

Rerank 后还会进入 `post_retrieve()`。当前后处理会根据 `dedup` 参数决定是否执行 `_deduplicate_results()`，随后调用 `_sort_and_trim()` 完成排序、总 Top-K 以及 Skill/Tool/Preference 等特殊类型的数量控制，最后还会更新这些 Memory 的 usage history。

完整后处理因此是：

```text
Raw Recall Results
        ↓
      Rerank
        ↓
    Deduplicate
        ↓
 Sort + Type Quota
        ↓
      Top-K
        ↓
Update Usage History
        ↓
TextualMemoryItem[]
```

这里的“去重”也非常重要。多路 Recall 很可能同时命中同一 Memory：

```text
Vector Recall
→ M1

Graph Recall
→ M1

Keyword Recall
→ M1
```

如果不去重：

```text
最终结果：
M1
M1
M1
M2
M3
```

既浪费 Top-K 名额，也会在 Prompt 中人为放大 M1 的权重。因此 Hybrid Retrieval 几乎一定需要最终 Merge + Dedup。

## 7.5 Fast、Fine 与 Deep Search：不同成本下的检索策略

理解完整 Pipeline 后，`fast/fine` 的区别就非常容易理解。

Fast：

```text
Query
 ↓
轻量 TaskGoalParser
 ↓
Multi-Path Recall
 ↓
Rerank
 ↓
Top-K
```

Fast 的 TaskGoalParser 当前直接使用原始 Query；启用 fast graph 时可以进行轻量分词得到 keys/tags，不调用复杂 LLM Query Parsing。

Fine：

```text
Query
 ↓
LLM TaskGoalParser
 ↓
Query Rewrite
+ Key / Tag / Goal
+ Chat Context
 ↓
Multi-Path Recall
 ↓
Rerank
 ↓
Top-K
```

当前 Searcher 文档也明确把 `fast` 描述为速度优先、精度有所牺牲，把 `fine` 描述为调用大模型进行更细致搜索、精度更高但速度更慢。

因此：

```text
Fast
适合：
高频简单查询
聊天实时检索

Fine
适合：
复杂问题
Query 本身存在歧义
需要利用对话上下文理解问题
```

除此之外，`AdvancedSearcher` 还实现了 `deep_search()`。它首先用 Fast 模式做一次基础 Recall 和 Post-process，然后进入多阶段处理流程；源码维护了 `previous_retrieval_phrases`、初始 retrieved memories 和多个 thinking stages，用于在现有结果不足时继续扩展搜索。

可以把 Deep Search 的设计思想理解成：

```text
第一次搜索
 ↓
得到 Memory
 ↓
判断当前信息是否足够
 ↓
不够
 ↓
生成新的 Retrieval Phrase
 ↓
再次搜索
 ↓
补充 Memory
 ↓
最终结果
```

普通检索是：

```text
Query
→ Search
→ Result
```

Deep Search 更接近 Agent：

```text
Query
→ Search
→ 判断缺什么
→ Search Again
→ Result
```

所以从复杂度上可以形成：

```text
Fast Search
    ↓
Fine Search
    ↓
Deep Search
```

越往下：

```text
理解能力 ↑
LLM 调用 ↑
延迟 ↑
成本 ↑
```

## 7.6 完整检索链路与源码阅读方法

假设长期 Memory 中存在：

```text
M1：用户正在研究 MemOS
M2：MemOS 项目使用 Qdrant 作为向量数据库
M3：MemOS 项目使用 Neo4j 保存图结构
M4：用户偏好简洁的技术回答
M5：用户已经总结出阅读 MemOS 源码的方法
```

用户问：

```text
“我那个记忆项目的向量存储用的什么？”
```

整个 Pipeline 可以理解成：

```text
Query
“我那个记忆项目的向量存储用的什么？”
        ↓
TaskGoalParser
        ↓
ParsedTaskGoal

topic = MemOS 项目
key = 向量存储
rephrased_query =
“MemOS 项目使用什么向量数据库？”
        ↓
生成 Query Embedding
        ↓
Multi-Path Recall
        ├── WorkingMemory
        ├── LongTermMemory
        │     ↓
        │   M1 / M2 / M3
        │
        ├── Keyword
        │     ↓
        │   M2
        │
        └── Skill / Preference ...
        ↓
Candidate Set
M1 M2 M3 ...
        ↓
Reranker
        ↓
M2 score 0.95
M1 score 0.72
M3 score 0.65
        ↓
Dedup
        ↓
Sort + Trim
        ↓
Top-K
        ↓
M2：
“MemOS 项目使用 Qdrant 作为向量数据库”
```

从源码角度，最值得追的不是 Searcher 里面 1000 多行代码全部逐行阅读，而是抓住下面这条主链：

```text
TreeTextMemory.search()
        ↓
AdvancedSearcher / Searcher.search()
        ↓
retrieve()
        ↓
_parse_task()
        ↓
TaskGoalParser.parse()
        ↓
_retrieve_paths()
        ↓
GraphMemoryRetriever.retrieve()
        ↓
Reranker
        ↓
post_retrieve()
        ↓
TextualMemoryItem[]
```

当前 `Searcher.search()` 在非 plugin 路径下会先调用 `retrieve()` 获取候选，再进入 Post-process；`retrieve()` 内部依次完成 `_parse_task()` 和 `_retrieve_paths()`，这就是最应该先掌握的骨干。

如果进一步把整个检索系统压缩成伪代码：

```python
def search(query):

    # 1. 理解 Query
    goal = task_goal_parser.parse(query)

    # 2. 产生用于召回的 embedding
    query_vectors = embed(
        goal.rephrased_query,
        goal.memories
    )

    # 3. 多路并行召回
    candidates = parallel_retrieve(
        working_memory,
        long_term_memory,
        user_memory,
        keyword_memory,
        skill_memory,
        tool_memory,
        preference_memory
    )

    # 4. 重排
    ranked = reranker.rerank(
        query,
        candidates
    )

    # 5. 后处理
    ranked = deduplicate(ranked)
    ranked = sort_and_trim(ranked)

    return ranked[:top_k]
```

这章最终需要建立的是一个非常重要的搜索系统观念：

```text
Embedding Search
只是检索系统中的一个组件

真正的 Retrieval System
=
Query Understanding
+
Hybrid Recall
+
Graph Expansion
+
Rerank
+
Post Processing
```

其中每一层解决不同问题：

```text
TaskGoalParser
→ “用户到底想找什么？”

Retriever
→ “哪些 Memory 可能相关？”

Graph
→ “和候选 Memory 有关系的还有什么？”

Reranker
→ “哪些候选最重要？”

Post-process
→ “最终应该给上层哪几条？”
```

因此 MemOS 的 Tree Search 已经不是传统意义上的“向量数据库 Top-K”，而更接近一个完整的**长期记忆搜索引擎**。当前 `GraphMemoryRetriever` 本身就将图检索与向量相似度检索合并，而 Searcher 再向上组合 Query Parsing、多路径并行 Recall、Rerank 和最终去重截断。

下一章进入 《特殊记忆类型：Preference、Skill、Tool 与 Tree Memory 类型体系》。本章只解决“怎么搜”，下一章再解决“系统到底在搜哪些不同性质的 Memory，以及它们为什么需要不同的形成和使用策略”。
