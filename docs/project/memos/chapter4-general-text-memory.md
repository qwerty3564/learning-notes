# 第四章：GeneralTextMemory——文本记忆的写入与检索

## 核心定位

`GeneralTextMemory` 是 MemOS 中最基础的文本记忆实现，文件：

```text
src/memos/memories/textual/general.py
```

它继承 `BaseTextMemory`，负责完成：

```text
extract → add → search → update → delete → dump/load
```

整体链路：

```text
Messages
→ extract()
→ TextualMemoryItem
→ add()
→ Embedder
→ VecDBItem
→ Vector DB

Query
→ Embedder
→ Vector DB.search()
→ VecDBItem
→ TextualMemoryItem
```

可以把它理解成：**带 Memory 数据模型、抽取能力和 CRUD 封装的 Vector Memory。**

## 初始化：三个核心依赖

`GeneralTextMemory` 主要依赖：

```text
extractor_llm → 从聊天中抽取记忆
embedder      → Text → Vector
vector_db     → 存储向量并执行 Top-K 搜索
```

初始化关系：

```text
GeneralTextMemoryConfig
├── extractor_llm → LLMFactory
├── embedder      → EmbedderFactory
└── vector_db     → VecDBFactory
                    ↓
             GeneralTextMemory
```

因此：

```text
GeneralTextMemory ≠ Vector DB
GeneralTextMemory = Memory 业务层
Vector DB = 基础设施层
```

## 写入链路：extract() 与 add()

输入：

```text
“我最近搬到上海了，以后酒店最好控制在500元以内。”
```

流程：

```text
Messages
→ 拼接文本
→ Memory Extraction Prompt
→ extractor_llm.generate()
→ 解析 JSON
→ TextualMemoryItem[]
```

可能得到：

```text
Memory 1
key = 居住地
memory = 用户目前居住在上海

Memory 2
key = 酒店预算
memory = 用户酒店预算偏好不超过500元
```

所以：

```text
extract()
解决的是：
“原始对话里什么值得长期记住？”
```

返回的是 `TextualMemoryItem`，还没有进入数据库。

**`TextualMemoryItem`**

核心结构：

```text
TextualMemoryItem
├── id
├── memory
└── metadata
```

例如：

```text
id = mem-001
memory = 用户目前居住在上海

metadata
├── user_id = alice
├── session_id = xxx
├── source = conversation
├── key = 居住地
└── tags = [location]
```

它是 Memory 层的领域对象，不是数据库对象。

**注意：`MOS.add()` 不一定调用 `extract()`**

这是源码里非常重要的一点。
当前普通 `general_text` 路径：

```text
MOS.add(messages)
→ 直接把 message.content
   包装成 TextualMemoryItem
→ text_mem.add()
```

而不是：

```text
MOS.add()
→ text_mem.extract()
→ text_mem.add()
```

当前 `tree_text` 分支才会显式经过：

```text
MemReader.get_memory()
```

因此：

```text
GeneralTextMemory.extract()
= 这个 Backend 提供的能力

MOS.add()
= 高层实际选择怎样组合这些能力
```

**有 `extract()` 方法，不代表所有写入流程都会调用它。**

**`add()`：Memory 怎么进入向量数据库**

已有：

```text
TextualMemoryItem
memory = "用户目前居住在上海"
```

调用：

```python
text_mem.add(memories)
```

流程：

```text
TextualMemoryItem[]
→ 提取 memory 文本
→ embedder.embed()
→ Vector[]
→ 构造 VecDBItem[]
→ vector_db.add()
```

最关键的转换：

```text
TextualMemoryItem
        ↓
      Embedding
        ↓
VecDBItem
├── id
├── vector
└── payload = TextualMemoryItem
```

概念上：

```text
id = mem-001

vector =
[0.12, -0.51, ...]

payload =
{
  memory: "用户目前居住在上海",
  metadata: {...}
}
```

所以 Vector DB 同时保存：

```text
vector  → 用于相似度搜索
payload → 用于恢复完整 Memory
```

**为什么要区分 `TextualMemoryItem` 和 `VecDBItem`**

```text
TextualMemoryItem
= Memory Domain Object
= 上层业务认识的“一条记忆”

VecDBItem
= Storage Object
= 向量数据库认识的一条记录
```

转换关系：

```text
TextualMemoryItem
→ VecDBItem
→ Vector DB
```

这样 MOS 不需要知道 Qdrant/Milvus 的内部数据结构，只需要处理 `TextualMemoryItem`。

## 检索链路：search()

用户问：

```text
“我现在住在哪？”
```

流程：

```text
Query
→ embedder.embed()
→ Query Vector
→ vector_db.search(top_k)
→ VecDBItem[]
→ 按 score 排序
→ payload
→ TextualMemoryItem[]
```

所以核心就是：

```text
Memory 写入：
Text → Vector

Query 检索：
Query → Vector

两个 Vector 在同一向量空间中比较相似度
```

例如：

```text
Memory:
“用户目前居住在上海”

Query:
“我的居住地是哪里？”
```

虽然文字不同，但 Embedding 接近，因此可以被召回。

**`GeneralTextMemory.search()` 和 `MOS.search()` 的区别**

`GeneralTextMemory.search()`：

```text
只搜索一个 Text Memory Backend
```

负责：

```text
Query
→ Embedding
→ Vector Top-K
→ Memory
```

`MOS.search()`：

```text
用户权限
→ 找可访问 Cube
→ 多 Cube 搜索
→ text_mem / pref_mem
→ 聚合结果
```

所以：

```text
GeneralTextMemory.search()
= 单库检索能力

MOS.search()
= 系统级检索编排
```

## 更新、查询与持久化

原来：

```text
用户住在北京
```

更新为：

```text
用户住在上海
```

不能只修改 payload，因为旧 vector 仍然表示“北京”。
正确流程：

```text
新 Memory Text
→ 重新 Embedding
→ 新 Vector
→ VecDBItem
→ vector_db.update()
```

否则会出现：

```text
payload = 上海
vector  = 北京
```

造成搜索语义错误。

**`get / delete / dump / load`**

`get()`：

```text
memory_id
→ vector_db.get_by_id()
→ VecDBItem
→ payload
→ TextualMemoryItem
```

`delete()`：

```text
memory_ids
→ vector_db.delete()
```

`delete_all()`：

```text
删除 Collection
→ 重新创建 Collection
```

`dump()`：

```text
Vector DB
→ VecDBItem[]
→ JSON
```

保存：

```text
id + vector + payload
```

`load()`：

```text
JSON
→ VecDBItem
→ vector_db.add()
```

因为 dump 已经保存了 vector，所以 load 时不需要重新 Embedding。

## 成本、与 RAG 的关系

```text
extract()
= 理解自然语言
= 判断“什么值得记”
→ 需要 LLM

search()
= 找语义相近 Memory
→ Embedding + Vector DB
→ 不一定需要 LLM
```

因此：

```text
extract：LLM 推理
add：Embedding + DB
search：Embedding + Vector Search
```

`GeneralTextMemory` 的搜索本身非常接近传统 RAG。

**和普通 RAG 的关系**

传统 RAG：

```text
Document
→ Embedding
→ Vector DB

Query
→ Embedding
→ Top-K
```

`GeneralTextMemory`：

```text
Message
→ 可选 extract
→ TextualMemoryItem
→ Embedding
→ Vector DB

Query
→ Embedding
→ Top-K
→ TextualMemoryItem
```

相比普通 RAG，它多了：

```text
Memory Item
Metadata
Memory CRUD
extract()
用户/Session 信息
dump/load
MemCube / MOS 集成
```

但检索核心仍然是：

```text
Embedding + Vector Top-K
```

## 伪代码

```python
class GeneralTextMemory:

    def __init__(config):
        self.llm = LLMFactory.from_config(...)
        self.embedder = EmbedderFactory.from_config(...)
        self.vector_db = VecDBFactory.from_config(...)

    def extract(messages):
        result = self.llm.generate(
            build_memory_prompt(messages)
        )
        return parse_to_memory_items(result)

    def add(memories):
        vectors = self.embedder.embed(
            [m.memory for m in memories]
        )

        items = [
            VecDBItem(
                id=m.id,
                vector=v,
                payload=m.model_dump()
            )
            for m, v in zip(memories, vectors)
        ]

        self.vector_db.add(items)

    def search(query, top_k):
        vector = self.embedder.embed([query])[0]

        results = self.vector_db.search(
            vector,
            top_k
        )

        return [
            TextualMemoryItem(**r.payload)
            for r in results
        ]
```

## 本章核心结论

只需要牢牢记住两条链：

```text
写入：

Messages
→ 可选 extract()
→ TextualMemoryItem
→ Embedding
→ VecDBItem
→ Vector DB
```

```text
检索：

Query
→ Embedding
→ Vector DB Top-K
→ VecDBItem
→ TextualMemoryItem
```

各层职责：

```text
MOS
→ 决定操作哪个用户、哪个 Cube

GeneralMemCube
→ 持有 text_mem

GeneralTextMemory
→ 决定文本 Memory 怎么写、怎么搜

Embedder
→ Text → Vector

Vector DB
→ 保存 Vector + Payload，并执行相似搜索
```

最值得标红的源码结论：

```text
GeneralTextMemory.extract() 存在
≠
MOS.add(general_text) 一定调用 extract()
```

`GeneralTextMemory` 定义的是**文本记忆 Backend 能做什么**；`MOS` 决定的是**当前业务流程实际调用哪些能力**。

下一章进入 `TreeTextMemory`，重点只回答一个问题：

> **为什么 `Embedding + Vector Top-K` 还不够，MemOS 为什么还需要树结构、Graph DB、Reranker 和 fast/fine 检索？**
