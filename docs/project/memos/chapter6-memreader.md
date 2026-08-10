# 第六章 MemReader：从原始输入到结构化记忆

在上一章中，我们已经理解了 `TreeTextMemory` 如何组织和检索结构化记忆，但还有一个关键问题没有解决：`TreeTextMemory.add()` 接收到的 `TextualMemoryItem` 从哪里来？用户输入的原始对话、文档甚至图片，并不是天然适合长期保存的记忆。例如用户说：“我最近搬到上海了，下个月准备去杭州，酒店最好控制在 500 元以内。”如果把整句话原封不动存入数据库，系统虽然能够进行向量检索，却很难区分其中的居住地事实、未来事件和预算偏好。因此在真正进入 Memory 之前，需要一个专门的语义加工层，把原始输入转换成结构化、可检索、可治理的记忆对象，这就是 `MemReader` 的作用。

整个写入体系可以重新整理为：

```text
原始输入
Messages / Document / Multimodal Data
                ↓
             MemReader
                ↓
     理解、切分、抽取、分类
                ↓
       TextualMemoryItem[]
                ↓
          TreeTextMemory
                ↓
          MemoryManager
                ↓
           Graph Store
```

因此可以把 MemReader 理解为 MemOS 的 **Memory Ingestion Pipeline**：Memory 负责“记忆怎么存、怎么搜”，MemReader 负责“输入里到底有什么值得记”。当前 MemOS 将 `mem_reader/` 明确作为 ingest pipeline 模块，而 `BaseMemReader` 的核心接口就是把场景数据转换为 `TextualMemoryItem`。

## 6.1 MemReader 的职责与抽象设计

MemReader 最核心的抽象位于：

```text
src/memos/mem_reader/base.py
```

其核心接口可以压缩为：

```python
class BaseMemReader:

    def set_graph_db(graph_db):
        ...

    def set_searcher(searcher):
        ...

    def get_memory(
        scene_data,
        type,
        info,
        mode="fast"
    ) -> list[list[TextualMemoryItem]]:
        ...

    def fine_transfer_simple_mem(
        input_memories,
        type
    ):
        ...
```

其中真正最重要的是：

```text
get_memory(...)
```

它完成：

```text
Scene Data
    ↓
Memory Extraction
    ↓
list[list[TextualMemoryItem]]
```

`scene_data` 是原始场景数据；`info` 至少携带 `user_id` 和 `session_id`；`mode` 决定采用快速处理还是更细致的 LLM 语义抽取。BaseMemReader 还允许注入 `graph_db` 和 `searcher`，接口注释明确说明这些组件可以用于已有记忆召回、语义去重和冲突检测。

MemReader 同样采用 MemOS 中常见的 Config + Factory 设计。目前 `MemReaderFactory` 注册三个主要实现：

```text
BaseMemReader
     ↑
     │
     ├── SimpleStructMemReader
     ├── StrategyStructMemReader
     └── MultiModalStructMemReader
```

配置中的：

```text
backend = "simple_struct"
```

经过：

```text
MemReaderConfigFactory
        ↓
MemReaderFactory
        ↓
SimpleStructMemReader
```

最终得到运行时对象。Factory 还可以在实例创建后注入 GraphDB 和 Searcher，因此上层 MOS 只依赖 `BaseMemReader` 抽象，而不需要写死具体 Reader。

三个 Reader 的关系不是三套完全独立的系统。`StrategyStructMemReader` 继承 `SimpleStructMemReader`，主要改变 Prompt 与对话切分策略；`MultiModalStructMemReader` 同样继承 `SimpleStructMemReader`，在其基础上扩展文件、图片等多模态解析能力。因此学习顺序应该是：

```text
BaseMemReader
      ↓
SimpleStructMemReader
      ↓
理解标准抽取流程
      ↓
StrategyStructMemReader
MultiModalStructMemReader
```

而不是一开始同时阅读三个大文件。

## 6.2 SimpleStructMemReader：结构化记忆抽取的标准流程

`SimpleStructMemReader` 是最适合理解 MemReader 的实现。初始化时，它会创建多个基础组件：

```text
SimpleStructMemReader
├── llm
├── general_llm
├── preference_extractor_llm
├── embedder
├── chunker
├── graph_db
└── searcher
```

其中 `llm` 主要承担 Chat / Document 的记忆抽取；`general_llm` 用于改写、过滤、合并等辅助任务，如果没有单独配置则回退到主 LLM；`embedder` 负责直接为生成的 Memory 计算向量；`chunker` 用于长文本切分。GraphDB 与 Searcher 初始化时可以为空，之后通过 setter 注入。

最重要的入口仍然是：

```python
mem_reader.get_memory(
    scene_data,
    type="chat",
    info={
        "user_id": "alice",
        "session_id": "session_001"
    },
    mode="fine"
)
```

当前 `get_memory()` 首先检查输入是否合法，并要求 `info` 至少包含字符串形式的 `user_id` 和 `session_id`；之后通过 `coerce_scene_data()` 将旧格式或不同输入统一为标准格式，再进入 `_read_memory()`。

所以第一层流程是：

```text
get_memory()
    ↓
输入合法性检查
    ↓
coerce_scene_data()
    ↓
统一 Scene Data
    ↓
_read_memory()
```

`_read_memory()` 再根据输入场景选择处理器：

```text
type = chat
→ _process_chat_data()

type = doc
→ _process_doc_data()
```

而不同 Scene Group 通过 `ContextThreadPoolExecutor` 并行处理，最终形成：

```text
[
    [Memory1, Memory2],
    [Memory3, Memory4]
]
```

这样的二维 Memory List。

### 对话数据的处理过程

Chat 数据并不会整段直接交给 LLM。`SimpleStructMemReader` 会先规范化消息，只保留 `user / assistant / system` 等合法角色，并将长会话拆成带重叠上下文的窗口；内部还存在基于 Token 数量的滑动窗口逻辑，从而避免一段超长对话一次性进入模型。窗口同时保留对应的 `role`、`chat_time`、原始内容等 Source 信息，因此后面生成 Memory 时仍然能够追溯到原始消息。

可以把前处理理解成：

```text
100 条聊天消息
      ↓
格式标准化
      ↓
去掉不支持的内容
      ↓
Sliding Window
      ↓
Window 1
Window 2
Window 3
...
```

然后每个 Window 才进入 Memory Extraction。

例如：

```text
user:
我最近开始学习 MemOS。

assistant:
主要在看哪部分？

user:
我现在重点研究 TreeTextMemory。
另外我以后希望技术回答简洁一点。
```

经过窗口处理后，MemReader 得到的是一段具有上下文的 Conversation，而不是一条孤立 Message。这一点非常重要，因为“我现在重点研究 TreeTextMemory”必须结合前面的“MemOS”才能获得完整语义。

### Fast 与 Fine 两种抽取方式

MemReader 的 `fast` 和 `fine` 并不是“同一个 Prompt 换两个参数”，而是两条明显不同的处理路径。

Fast 模式几乎不做 LLM 记忆提炼：

```text
Conversation Window
        ↓
直接使用原始文本
        ↓
TextualMemoryItem
        ↓
Embedding
```

当前源码会根据 Window 中的角色简单判断 Memory 类型：如果全部来自 user，则使用 `UserMemory`；否则使用 `LongTermMemory`，并增加：

```text
tags = ["mode:fast"]
```

随后 `_make_memory_item()` 构造标准 Memory 对象。

Fine 模式则真正进入 LLM 抽取：

```text
Conversation Window
        ↓
Memory Prompt
        ↓
LLM
        ↓
结构化 JSON
        ↓
memory list
        ↓
TextualMemoryItem[]
```

LLM 返回的数据大致包含：

```text
memory list
├── key
├── value
├── memory_type
└── tags

summary
```

Reader 再将每个结果转换为 `TextualMemoryItem`。例如原始输入：

```text
我最近开始研究 MemOS，
现在主要在看 TreeTextMemory。
```

Fine 模式可能得到：

```text
Memory 1

key:
当前研究项目

value:
用户正在研究 MemOS

memory_type:
UserMemory
```

以及：

```text
Memory 2

key:
当前学习重点

value:
用户当前重点研究 MemOS 的 TreeTextMemory

memory_type:
UserMemory
```

当前 `_get_llm_response()` 根据输入语言选择对应 Prompt，调用 LLM 并解析 JSON；如果模型调用或 JSON 解析失败，还会退化为直接保留原始文本的 Memory，防止一次模型异常导致整个写入请求没有任何结果。

因此两种模式可以概括为：

```text
Fast
原始内容 → Memory
优点：快、调用成本低
缺点：Memory 粗糙、冗余较多

Fine
原始内容 → LLM 理解 → Memory
优点：结构化、语义更明确
缺点：更慢、有模型调用成本
```

这里还有一个非常重要的源码细节：`_make_memory_item()` 不仅创建 Memory Text，还直接构造 `TreeNodeTextualMemoryMetadata`，并默认通过 Embedder 计算该 Memory 的 embedding。也就是说，在 Tree Memory 这条链路中：

```text
MemReader
不仅负责：
“抽什么”

还会提前准备：
key
tags
memory_type
source
embedding
user/session
background
confidence
...
```

最终输出已经非常接近可以直接交给 TreeTextMemory 的标准图节点。

这和上一章的 `GeneralTextMemory` 很不同：

```text
GeneralTextMemory:
Memory.add()
→ 再计算 Embedding

TreeTextMemory + MemReader:
MemReader
→ 抽取 Memory
→ 同时生成 Metadata / Embedding
→ TreeTextMemory.add()
```

因此 MemReader 在 Tree Memory 架构中的地位明显更高，它实际上承担了一部分“Memory 构建器”的职责。

## 6.3 文档、多模态与不同 Reader 的扩展方式

MemReader 不只处理 Chat，文档也是其重要输入。当前 `SimpleStructMemReader` 的文档 Fine Pipeline 可以概括为：

```text
Document
   ↓
提取完整文本
   ↓
Chunker
   ↓
Chunk 1 / Chunk 2 / ...
   ↓
每个 Chunk 构造 Prompt
   ↓
LLM 并行抽取
   ↓
TextualMemoryItem[]
```

文档来源会被记录为 `SourceMessage`，例如保留原始 filename / doc path。当前 Simple Reader 的文档 `fast` 模式尚未实现，会直接抛出 `NotImplementedError`，所以文档处理主要走 Fine 抽取。

这说明 Chat 和 Document 虽然最终都输出：

```text
TextualMemoryItem[]
```

但输入处理策略不同：

```text
Chat
→ Conversation Window
→ 保留角色与时间上下文

Document
→ Chunk
→ 保留文件来源与文档上下文
```

因此 MemReader 的真正抽象不是“聊天摘要器”，而是：

> **把不同类型的信息源统一转换成 Memory Domain Object。**

在这一基础上，MemOS 又提供了两个扩展实现。

`StrategyStructMemReader` 继承 `SimpleStructMemReader`，没有重新实现整套 `get_memory()` 主流程，而是重点改变 Chat 的 Prompt 和 Chunking 策略。它使用专门的 Strategy Prompt，并支持按照配置的内容长度进行 Conversation Chunking，因此可以理解成：

```text
SimpleStructMemReader
= 标准抽取框架

StrategyStructMemReader
= 标准抽取框架
  + 不同的 Prompt Strategy
  + 不同的 Chunk Strategy
```

这体现了一个很典型的面向对象设计：复用完整 Ingestion Pipeline，只替换“如何理解输入”的策略部分。

`MultiModalStructMemReader` 同样继承 `SimpleStructMemReader`，但扩展范围更大。它额外创建 `MultiModalParser`，并可以为图片和文档分别配置 `image_parser_llm`、`document_parser_llm`；同时提供长 Memory 切分、窗口聚合和批量 Embedding 等处理逻辑。

因此：

```text
                 BaseMemReader
                       ↓
             SimpleStructMemReader
               /              \
              /                \
StrategyStructReader      MultiModalStructReader
      ↓                         ↓
改变 Prompt / Chunk       扩展输入 Modalities
```

从架构上看，这比为每种输入重新写一套 Memory Storage 更合理，因为最终：

```text
Chat
Document
Image
...
```

都需要被统一成：

```text
TextualMemoryItem
```

后面的 TreeTextMemory 根本不需要关心这些 Memory 最初是从聊天、PDF 还是图片来的。

## 6.4 记忆质量控制：从“抽出来”到“值得保存”

真正的长期 Memory 系统不能做到：

```text
LLM 抽出来什么
→ 就永久保存什么
```

否则很容易出现幻觉、重复和错误信息。MemReader 因此还提供了一些进一步加工能力。

首先是 `fine_transfer_simple_mem()`。它可以把已经存在的简单 Memory 再交给 LLM 做 Fine Transformation：

```text
Fast Memory
      ↓
fine_transfer_simple_mem()
      ↓
LLM
      ↓
更结构化的 Fine Memory
```

这意味着系统可以采用：

```text
第一阶段：
快速写入

第二阶段：
后台精炼
```

这样的两阶段策略。当前实现会根据 Chat / Doc 类型选择转换方法，并通过线程池并行处理已有 Memory。

其次，SimpleStructMemReader 还存在 Memory Rewrite 和 Hallucination Filter。`rewrite_memories()` 可以让通用 LLM 判断某条 Memory 是否需要改写；`filter_hallucination_in_memories()` 则根据原始 Messages 判断抽取结果是否应该保留。当前 `_read_memory()` 可以通过 `SIMPLE_STRUCT_ADD_FILTER` 开关，在抽取完成后再次执行幻觉过滤。

因此一个更加完整的 Memory Ingestion Pipeline 实际上可以是：

```text
Raw Input
   ↓
Normalize
   ↓
Chunk / Window
   ↓
Fast / Fine Extract
   ↓
TextualMemoryItem
   ↓
Rewrite（可选）
   ↓
Hallucination Filter（可选）
   ↓
Dedup / Conflict Check（扩展）
   ↓
Memory Storage
```

BaseMemReader 还预留 GraphDB 与 Searcher 注入接口，其设计目的就是允许 Reader 在写入新 Memory 前召回已有 Memory，从而辅助做语义去重和冲突判断。需要注意的是，这是 Reader 层提供的能力边界，并不意味着每一种 Reader、每条写入路径当前都会执行完整的冲突处理。

所以 MemReader 的职责不能简单概括成：

```text
LLM 摘要
```

更准确的是：

> **MemReader 是从原始信息到长期 Memory 的 ETL / Ingestion 层，负责输入规范化、切片、语义提取、分类、元数据补全、向量生成以及可选的质量治理。**

## 6.5 MemReader 在 MOS 写入链路中的位置

理解完 MemReader 本身以后，再回到 `MOS.add()`，整条链就非常清楚了。

当：

```text
text_mem.backend != tree_text
```

当前 MOS 可以直接：

```text
Message
 ↓
TextualMemoryItem
 ↓
text_mem.add()
```

并不会强制经过 MemReader。

但是当：

```text
text_mem.backend == tree_text
```

当前源码会执行：

```text
MOS.add()
   ↓
messages_list = [messages]
   ↓
mem_reader.get_memory(
    type="chat",
    user_id,
    session_id,
    mode
)
   ↓
list[list[TextualMemoryItem]]
   ↓
flatten
   ↓
TreeTextMemory.add()
```

同步写入通常使用 `fine`，异步模式前台路径则会采用 `fast`，后续再结合 Scheduler 继续处理。

因此完整关系变成：

```text
                         MOS.add()
                            ↓
                    判断 Memory Backend
                       /            \
                      /              \
            general_text           tree_text
                 ↓                    ↓
      直接构造 Memory             MemReader
                 ↓                    ↓
     GeneralTextMemory.add()   TextualMemoryItem[]
                                      ↓
                              TreeTextMemory.add()
                                      ↓
                               MemoryManager
                                      ↓
                                 Graph Store
```

如果输入是文档：

```text
MOS.add(doc_path)
       ↓
读取 Documents
       ↓
MemReader.get_memory(type="doc")
       ↓
Chunk + LLM Extraction
       ↓
TextualMemoryItem[]
       ↓
TreeTextMemory.add()
```

当前 `MOS.add()` 对 `doc_path` 的处理确实会先通过 MemReader 提取文档 Memory，再交给当前 Cube 的 `text_mem.add()`。

现在就可以准确区分三个核心类：

```text
MemReader
回答：
“原始输入里有什么值得记？”

TreeTextMemory
回答：
“这些 Memory 应该怎样组织和存储？”

Searcher
回答：
“需要的时候应该怎样把它们找回来？”
```

因此：

```text
           Memory 生命周期

Raw Information
       ↓
   MemReader
       ↓
Memory Formation
       ↓
TreeTextMemory
       ↓
Memory Storage / Organization
       ↓
   Searcher
       ↓
Memory Retrieval
```

这三个模块分别对应 **Memory Formation、Memory Storage、Memory Retrieval**，是理解 MemOS 文本长期记忆体系最重要的三段。

## 6.6 本章小结

MemReader 是 MemOS 中连接“原始世界”和“Memory 世界”的桥梁。它并不负责最终数据库的 CRUD，也不是检索器，而是负责把 Chat、Document 和更复杂输入转成统一的 `TextualMemoryItem`。

整个核心流程可以压缩成：

```text
                   MemReader

Raw Input
    ↓
Normalize
    ↓
Chunk / Window
    ↓
Fast or Fine
    ↓
LLM Extraction（Fine）
    ↓
key / value / tags / memory_type
    ↓
Metadata + Source + Embedding
    ↓
TextualMemoryItem
```

三种 Reader 的定位可以概括为：

| 实现                          | 核心定位                       |
| --------------------------- | -------------------------- |
| `SimpleStructMemReader`     | 标准文本 Chat / Document 抽取流程  |
| `StrategyStructMemReader`   | 在标准流程上强化 Prompt 与 Chunk 策略 |
| `MultiModalStructMemReader` | 将图片、文档等多模态输入统一转换为 Memory   |

而 Fast / Fine 的区别可以记成：

```text
Fast
= 先把信息快速变成 Memory

Fine
= 让 LLM 真正理解“应该记什么”
```

最重要的设计思想是：

> **Memory 系统不是把所有输入都存下来，而是把原始信息加工成适合长期保存、检索和演化的 Memory。**

从源码学习角度，本章最值得追的一条调用链是：

```text
BaseMemReader
 ↓
MemReaderFactory
 ↓
SimpleStructMemReader.get_memory()
 ↓
_read_memory()
 ↓
_process_chat_data()
 ↓
_get_llm_response()
 ↓
_make_memory_item()
 ↓
TextualMemoryItem
 ↓
TreeTextMemory.add()
```

只要这一条链真正看懂，就基本理解了 MemOS 中“聊天如何变成长记忆”。

下一章可以继续进入 **《记忆检索系统：从 Query 到 Top-K Memory 的完整检索链路》**，把 `Searcher → TaskGoalParser → Retriever → Reranker → Post-process` 作为一个完整的检索系统重新系统化讲一遍，而不是只依附在 TreeTextMemory 章节里零散理解。
