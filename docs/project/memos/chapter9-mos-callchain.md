# 第九章 MOS 调用链：从记忆写入、检索到对话生成

前面的章节已经分别拆解了 MemCube、GeneralTextMemory、TreeTextMemory、MemReader、Searcher 以及各种特殊 Memory。现在需要重新回到系统最高层，将这些组件串成完整的运行链路。对于 Python SDK 来说，`MOS` 的核心价值并不是亲自实现 Memory 的存储算法，而是根据用户、会话、Cube、Memory Backend 和运行模式，把一次请求路由到正确的组件。当前 `MOSCore` 明确承担多 MemCube 与多用户场景下的统一编排职责，其最重要的业务入口就是 `add()`、`search()` 和 `chat()`。

可以先把三条主链压缩成：

```text
写入：
Input
→ MOS.add()
→ User / Cube Routing
→ MemReader（部分路径）
→ Memory.add()
→ Storage

检索：
Query
→ MOS.search()
→ User / Cube Routing
→ text_mem.search() / pref_mem.search()
→ Result Aggregation

对话：
Query
→ MOS.chat()
→ Memory Retrieval
→ System Prompt
→ Chat History
→ LLM
→ Response
```

这三条链共享用户权限、MemCube 和 Memory，但目的完全不同：`add()` 解决“信息如何进入记忆系统”，`search()` 解决“记忆如何被显式取回”，`chat()` 解决“记忆如何真正参与模型生成”。

## 9.1 MOS 作为系统级编排层

理解 `MOS` 时，最重要的是区分“业务编排”和“底层能力”。例如：

```text
MOS.add()
并不负责：
Embedding 怎么计算
Graph Node 怎么创建
Qdrant 怎么插入数据

MOS.search()
并不负责：
Cosine Similarity 怎么算
Graph Traversal 怎么执行
Reranker 怎么打分
```

这些能力分别下沉到：

```text
MemReader
Memory
Searcher
Embedder
VecDB
GraphDB
Reranker
```

MOS 负责的是：

```text
谁在操作？
      ↓
允许访问什么 Cube？
      ↓
这次应该使用哪个 Cube？
      ↓
使用什么 Memory Backend？
      ↓
同步还是异步？
      ↓
调用哪些组件？
      ↓
怎样汇总最终结果？
```

因此整个 SDK 可以看成：

```text
                    MOS
                     │
        ┌────────────┼────────────┐
        ↓            ↓            ↓
   UserManager    MemCubes    ChatHistory
                     │
              ┌──────┼──────┐
              ↓             ↓
          text_mem        pref_mem
              │
          MemReader /
          Searcher /
          Storage
```

`MOS` 不拥有真正的长期 Memory 数据，而是持有已注册的 MemCube，并通过 `UserManager` 判断不同用户可以访问哪些 Cube。`_validate_cube_access()` 当前会先验证用户存在，再调用 `validate_user_cube_access()` 校验用户与 Cube 的访问关系。

这也是后面三条链共同的第一步：

```text
Request
 ↓
确定 target_user_id
 ↓
检查用户 / Cube
 ↓
找到 Runtime MemCube
 ↓
继续执行具体操作
```

## 9.2 `MOS.add()`：一次输入如何进入记忆系统

当前 `MOS.add()` 支持三种主要输入：

```python
messages
memory_content
doc_path
```

同时允许指定：

```python
mem_cube_id
user_id
session_id
task_id
```

源码要求 `messages / memory_content / doc_path` 至少提供一个。

因此可以把 `add()` 入口理解成：

```text
MOS.add()
├── Conversation Messages
├── Direct Memory Content
└── Document Path
```

### 用户与 Cube 路由

首先确定：

```text
target_user_id
target_session_id
```

如果显式提供 `mem_cube_id`：

```text
user
 ↓
_validate_cube_access()
 ↓
指定 Cube
```

如果没有提供，则当前实现会：

```text
UserManager.get_user_cubes(user)
 ↓
得到用户可访问 Cube
 ↓
取 accessible_cubes[0]
```

源码这里甚至保留了：

```text
TODO not only first
```

说明当前默认写入策略仍然只是选择用户可访问 Cube 中的第一个，并没有完成更高级的自动多 Cube 写入路由。

因此：

```text
add()
→ 默认写一个 Cube

search()
→ 可以搜索多个 Cube
```

这是当前实现中很重要的不对称关系。

找到 Cube 后，MOS 会读取：

```text
cube.text_mem.mode
```

确定当前属于：

```text
sync
或
async
```

如果是异步模式，则要求 MemScheduler 已经启用。

### Messages 写入：GeneralText 与 TreeText 两条不同路径

收到：

```python
messages=[
    {"role": "user", "content": "..."}
]
```

以后，MOS 首先处理文本记忆。

如果：

```text
text_mem.backend != tree_text
```

当前源码直接：

```text
Message
 ↓
TextualMemoryMetadata
 ↓
TextualMemoryItem
 ↓
text_mem.add()
```

具体来说，每条 `message["content"]` 被包装成 `TextualMemoryItem`，Metadata 中写入 `user_id`、`session_id` 和 `source="conversation"`，然后直接交给当前 Cube 的 Text Memory。

所以：

```text
GeneralText 路径

messages
 ↓
直接包装
 ↓
TextualMemoryItem
 ↓
GeneralTextMemory.add()
 ↓
Embedding
 ↓
Vector DB
```

如果：

```text
text_mem.backend == tree_text
```

路径发生变化：

```text
messages
 ↓
MemReader.get_memory()
 ↓
TextualMemoryItem[]
 ↓
flatten
 ↓
TreeTextMemory.add()
 ↓
MemoryManager
 ↓
Graph Store
```

同步模式使用 `fine` Reader，异步模式前台使用 `fast` Reader。

也就是说：

```text
GeneralText
重点：
快速保存文本

TreeText
重点：
先理解输入，再形成结构化 Memory
```

这也是前面多次强调的：

```text
GeneralTextMemory.extract() 存在
≠
MOS.add(general_text) 一定调用它
```

真正的调用方式由 MOS 编排决定。

### Preference Memory 与 Text Memory 可以同时处理

如果配置开启：

```text
enable_preference_memory
```

且当前 Cube 存在 `pref_mem`，`MOS.add()` 还会启动偏好处理。

同步模式：

```text
messages
 ↓
pref_mem.get_memory()
 ↓
Preference Memories
 ↓
pref_mem.add()
```

异步模式：

```text
messages
 ↓
ScheduleMessageItem
label = PREF_ADD_TASK_LABEL
 ↓
MemScheduler
```

当前 Text Memory 与 Preference Memory 的处理函数会通过 `ContextThreadPoolExecutor(max_workers=2)` 并行执行。

所以一次：

```python
mos.add(messages)
```

并不一定只产生一种 Memory。

概念上可能是：

```text
                 Messages
                    ↓
               MOS.add()
                    ↓
          ┌─────────┴─────────┐
          ↓                   ↓
   Textual Pipeline     Preference Pipeline
          ↓                   ↓
    text_mem.add()       pref_mem.add()
```

例如：

```text
用户：
“我最近搬到上海了，
以后回答我简单一点。”
```

可能同时产生：

```text
Text Memory：
用户最近搬到上海

Preference Memory：
用户偏好简洁回答
```

### `memory_content` 与 `doc_path`

如果直接传：

```python
memory_content="用户正在学习 MemOS"
```

普通非 Tree backend 会直接构造 `TextualMemoryItem` 并写入；Tree backend 则先把字符串包装成一条 user message，再通过 MemReader 形成结构化 Memory。

因此：

```text
memory_content

GeneralText：
String
→ TextualMemoryItem
→ add

TreeText：
String
→ User Message
→ MemReader
→ TextualMemoryItem
→ add
```

如果传入：

```python
doc_path="docs/"
```

MOS 会先扫描支持的文档文件，再调用：

```text
MemReader.get_memory(
    type="doc"
)
```

生成文档 Memory，最后写入 `text_mem`。当前支持扫描的扩展名包括 `.txt/.pdf/.json/.md/.ppt/.pptx`。

完整 `add()` 主链可以压缩成：

```text
                         MOS.add()
                            ↓
                  User / Session Resolution
                            ↓
                     Cube Selection
                            ↓
                       Sync / Async
                            ↓
        ┌───────────────────┼────────────────────┐
        ↓                   ↓                    ↓
     messages         memory_content          doc_path
        ↓                   ↓                    ↓
 Backend Decision      Backend Decision         MemReader
   /        \             /       \                ↓
General     Tree       General    Tree        Doc Extraction
  ↓          ↓           ↓         ↓                ↓
Wrap     MemReader      Wrap    MemReader     TextualMemoryItem
  ↓          ↓           ↓         ↓                ↓
  └──────────┴───────────┴─────────┴────────────────┘
                         ↓
                    text_mem.add()
                         ↓
                     Storage
```

如果 Scheduler 开启，Tree Memory 写入后还可能根据同步/异步模式提交 `MEM_READ_TASK_LABEL` 或 `ADD_TASK_LABEL` 等后台任务，后续继续进行记忆加工。

## 9.3 `MOS.search()`：跨 Cube 的系统级记忆检索

`MOS.search()` 和 `text_mem.search()` 最大的区别是：

```text
text_mem.search()
= 一个 Memory Backend 的搜索能力

MOS.search()
= 用户权限 + 多 Cube + 多 Memory 类型 + 结果聚合
```

当前接口主要接收：

```python
query
user_id
install_cube_ids
top_k
mode
internet_search
moscube
session_id
```

如果 `install_cube_ids` 没有指定，当前实现默认使用该用户全部可访问的 Cube。

所以第一阶段是：

```text
Query
 ↓
确定 target_user_id
 ↓
验证用户
 ↓
UserManager.get_user_cubes()
 ↓
得到：
Cube A
Cube B
Cube C
```

随后只对：

```text
用户有权访问
+
当前已经加载到 self.mem_cubes
```

的 Cube 执行搜索。

整个结构：

```text
                         Query
                           ↓
                      MOS.search()
                           ↓
                       UserManager
                           ↓
                 Accessible MemCubes
                   /       |       \
                  ↓        ↓        ↓
               Cube A    Cube B    Cube C
```

对于每个 Cube，MOS 定义两条主要搜索路径：

```text
search_textual_memory()
search_preference_memory()
```

文本路径调用：

```python
cube.text_mem.search(...)
```

并把 `user_id`、`session_id`、`chat_history` 等信息传给底层 Memory，同时继续传递 `mode`、Internet 开关和 `search_filter`。

Preference 路径则调用：

```python
cube.pref_mem.search(...)
```

并同样传递用户、Session 和 Chat History。

两条路径当前也是并行执行：

```text
Cube
 ↓
┌─────────────────────┐
│                     │
↓                     ↓
text_mem.search()   pref_mem.search()
│                     │
└──────────┬──────────┘
           ↓
      Merge Result
```

当前实现通过两个 Future 同时运行文本和偏好检索，然后分别写入：

```text
result["text_mem"]
result["pref_mem"]
```

。

因此 `MOS.search()` 返回的结果还保留：

```text
Memory Type
+
Cube ID
```

信息，而不是简单把所有 Memory 压成一个 List：

```text
result
├── text_mem
│   ├── Cube A → memories
│   └── Cube B → memories
│
├── pref_mem
│   ├── Cube A → memories
│   └── Cube B → memories
│
├── act_mem
└── para_mem
```

当前初始化结果结构中明确包含 `text_mem / act_mem / para_mem / pref_mem` 四个键。

这体现了 MOS 搜索层的核心职责：

> **MOS 不负责决定一条 Memory 为什么相关，而负责决定去哪里搜、搜哪些 Memory Backend，并保留结果的来源边界。**

因此：

```text
MOS.search()
          ↓
   Permission Routing
          ↓
     Multi-Cube
          ↓
 ┌────────┴────────┐
 ↓                 ↓
Text Search     Preference Search
 ↓                 ↓
Memory Backend Internal Retrieval
 ↓                 ↓
 └────────┬────────┘
          ↓
 Result Aggregation
```

如果 `text_mem` 是 `GeneralTextMemory`：

```text
内部搜索
→ Embedding + Vector Top-K
```

如果是 `TreeTextMemory`：

```text
内部搜索
→ TaskGoalParser
→ Hybrid Recall
→ Graph
→ Reranker
→ Top-K
```

MOS 不需要改变自己的主要调用方式。

这就是抽象接口带来的价值：

```text
MOS
只调用：
text_mem.search()

具体怎么搜
由 Memory Backend 决定
```

## 9.4 `MOS.chat()`：Memory 如何真正参与 LLM 生成

`search()` 只是把 Memory 返回给程序，而 `chat()` 才真正体现“有记忆的 LLM”与普通 Chat LLM 的区别。

当前 `MOS.chat()` 的主流程可以压缩成：

```text
Query
 ↓
User / Cube Permission
 ↓
Search Text Memory
 ↓
Top-K Memories
 ↓
Build System Prompt
 ↓
Recent Chat History
 ↓
Current Query
 ↓
Chat LLM
 ↓
Response
 ↓
Update Chat History
 ↓
Scheduler（可选）
```

当前 `chat()` 首先获得目标用户可以访问的全部 Cube，并准备该用户的 Chat History。随后遍历当前加载的 Cube，只对用户有权限且存在 `text_mem` 的 Cube执行搜索。

也就是说：

```text
User Query
   ↓
Accessible Cubes
   ↓
Cube A.text_mem.search()
Cube B.text_mem.search()
Cube C.text_mem.search()
   ↓
memories_all
```

这里有一个值得标红的源码事实：

> **当前 `MOS.chat()` 主路径直接搜索的是各 Cube 的 `text_mem`，并没有像 `MOS.search()` 那样同时显式调用独立 `pref_mem.search()`。**

因此如果 Preference 是作为 TreeTextMemory 内部的 `PreferenceMemory` 节点参与 Tree Search，它仍可能被 text search 检索；但如果只依赖 GeneralMemCube 独立的 `pref_mem` Slot，当前 `chat()` 这条主路径并没有显式执行独立 Preference Search。这是理解“独立 pref_mem”与“Tree 内部 PreferenceMemory”差异时一个很有价值的源码观察。

搜索完成后：

```text
TextualMemoryItem[]
 ↓
_build_system_prompt()
 ↓
Memory Context
```

当前 `_build_system_prompt()` 会取每个 `TextualMemoryItem.memory`，按编号组成文本。如果自定义 `base_prompt` 中有：

```text
{memories}
```

则直接替换；如果没有 placeholder，则把 Memory 追加到 `## Memories:` 区域。

最终发给 LLM 的消息结构是：

```text
[
  System Prompt
  + Retrieved Memories,

  Recent Chat History,

  Current User Query
]
```

也就是：

```text
             Retrieved Memory
                    ↓
             System Prompt
                    +
              Chat History
                    +
              Current Query
                    ↓
                Chat LLM
```

这里要再次区分：

```text
Memory
= 长期信息

Chat History
= 当前近期对话上下文
```

例如：

```text
Long-term Memory：
用户正在学习 MemOS
用户偏好技术内容

Chat History：
User：TreeTextMemory 是什么？
Assistant：...
User：那 Searcher 呢？

Current Query：
它和普通向量搜索有什么区别？
```

最终模型看到的是三者组合，而不是只看当前 Query。

### Activation Memory：另一条完全不同的 Chat Memory

如果：

```text
enable_activation_memory = True
```

且 Chat Model backend 是：

```text
huggingface
或
huggingface_singleton
```

当前 `chat()` 还会尝试从用户有权限的 Cube 中找到 `act_mem`，取出一条 KV Cache，并作为：

```python
past_key_values
```

传给 LLM。对于其他 Chat Model backend，源码会直接跳过 Activation Memory。

因此 Chat 可以同时存在两种“Memory 使用方式”：

```text
Text Memory
 ↓
转换成文字
 ↓
放进 Prompt


Activation Memory
 ↓
取 KV Cache
 ↓
past_key_values
 ↓
直接参与模型推理
```

前者属于：

```text
Memory-Augmented Prompt
```

后者属于：

```text
Computation State Reuse
```

它们虽然都叫 Memory，但参与 LLM 的方式完全不同。

生成完成后，当前 `chat()` 会把：

```text
User Query
Assistant Response
```

追加回 Chat History，然后返回 Response。

如果 Scheduler 开启，还会围绕 Query 和 Answer 提交后台任务：检索前可以提交 `QUERY_TASK_LABEL`，生成后对用户可访问 Cube 提交 `ANSWER_TASK_LABEL`，使新的交互继续进入后续 Memory 管理流程。

因此 `chat()` 实际形成了一个非常重要的循环：

```text
已有 Memory
    ↓
帮助回答当前问题
    ↓
产生新的 Query / Answer
    ↓
Scheduler / Memory Pipeline
    ↓
形成未来 Memory
    ↓
下一次继续检索
```

这就是长期 Memory 系统真正的闭环。

## 9.5 三条调用链的统一理解

现在可以把 `add/search/chat` 放在同一张图中：

```text
                         Application
                             ↓
                            MOS
              ┌──────────────┼──────────────┐
              ↓              ↓              ↓
             add           search           chat
              ↓              ↓              ↓
         Cube Routing    Cube Routing    Cube Routing
              ↓              ↓              ↓
        MemReader?       Memory.search   Memory.search
              ↓              ↓              ↓
         Memory.add      Aggregate       Memories
              ↓              ↓              ↓
           Storage        Return       System Prompt
                                             ↓
                                        Chat History
                                             ↓
                                          Chat LLM
                                             ↓
                                          Response
```

其中每个模块的职责可以重新总结为：

| 组件                  | 在完整调用链中的职责                             |
| ------------------- | -------------------------------------- |
| `MOS`               | 用户、Cube、流程与组件编排                        |
| `UserManager`       | 判断用户能访问哪些 Cube                         |
| `GeneralMemCube`    | 提供具体 Memory Slot                       |
| `MemReader`         | 原始输入 → 结构化 Memory                      |
| `GeneralTextMemory` | 简单向量型文本存储与搜索                           |
| `TreeTextMemory`    | 图结构记忆的组织与高级搜索                          |
| `PreferenceMemory`  | 用户偏好的形成与检索                             |
| `Searcher`          | Query Understanding + Hybrid Retrieval |
| `Scheduler`         | 将部分 Memory 工作转入异步后台                    |
| `Chat LLM`          | 使用 Memory 和对话上下文生成答案                   |

因此最值得掌握的三条源码主线就是：

```text
写入：

MOS.add()
 ↓
UserManager
 ↓
MemCube
 ↓
MemReader（Tree）
 ↓
text_mem / pref_mem
 ↓
Storage
```

```text
检索：

MOS.search()
 ↓
UserManager
 ↓
Accessible Cubes
 ↓
text_mem.search()
+
pref_mem.search()
 ↓
Result Aggregation
```

```text
对话：

MOS.chat()
 ↓
Accessible Cubes
 ↓
text_mem.search()
 ↓
Retrieved Memories
 ↓
_build_system_prompt()
 ↓
Chat History
 ↓
chat_llm.generate()
 ↓
Response
```

从源码设计角度看，`add/search/chat` 也形成了三个不同层次：

```text
add
→ Memory Formation

search
→ Memory Retrieval

chat
→ Memory Utilization
```

也就是：

```text
原始信息
   ↓
ADD
   ↓
长期记忆
   ↓
SEARCH
   ↓
相关记忆
   ↓
CHAT
   ↓
模型使用记忆
   ↓
新的交互
   ↓
继续 ADD
```

这实际上就是 MemOS 最核心的运行闭环：

```text
              ┌────────────────────┐
              │                    │
              ↓                    │
Raw Interaction                    │
      ↓                            │
   Memory Add                      │
      ↓                            │
 Memory Storage                    │
      ↓                            │
 Memory Search                     │
      ↓                            │
Memory-Augmented Chat              │
      ↓                            │
 New Interaction ──────────────────┘
```

到这里，前面关于 MemCube、MemReader、TreeTextMemory、Searcher 和特殊 Memory 的知识已经第一次真正连接成了一套运行系统。

下一章可以进入 **《MemScheduler：从同步调用到异步记忆演化》**。前面的所有流程基本都可以在当前请求线程中理解，而 Scheduler 要解决的是另一个工程问题：**当记忆抽取、偏好分析、重组、Skill 提炼等任务越来越慢时，如何把这些工作从用户请求链路中拆出去，同时保证 Memory 仍然能够持续更新。**
