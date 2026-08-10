# 第十章 MemScheduler：异步任务调度与记忆演化

前面的 `MOS.add()`、`MOS.search()` 和 `MOS.chat()` 都可以直接完成记忆写入、检索和对话，但随着 Memory Pipeline 越来越复杂，一个明显的问题会出现：**如果每一次记忆抽取、偏好分析、图重组和工作记忆更新都同步执行，用户请求的延迟会越来越高。** MemScheduler 就是为了解决这个问题而存在的。官方将它定位为后台运行的“记忆组织调度器”，通过消息队列异步管理 Working Memory、Long-term Memory、Activation Memory 等记忆之间的流转和更新，并支持 Local Queue 与 Redis Stream 两种任务队列。

可以先把没有 Scheduler 和有 Scheduler 的系统对比一下：

```text
没有 Scheduler：

User Request
    ↓
MemReader Fine Extraction
    ↓
Preference Extraction
    ↓
Memory Organization
    ↓
Graph Update
    ↓
全部完成
    ↓
Response

问题：
用户必须等待所有 Memory 工作完成
```

加入 Scheduler 后：

```text
User Request
    ↓
完成当前请求必须做的工作
    ↓
产生 ScheduleMessageItem
    ↓
Task Queue
    ↓
立即继续主流程
    │
    └───────────────┐
                    ↓
              MemScheduler
                    ↓
                Handler
                    ↓
       Fine Extract / Update /
       Organize / Preference ...
                    ↓
              Memory Storage
```

因此 Scheduler 的本质并不是另一个 Memory Backend，而是：

> **把耗时、可延迟执行的 Memory 工作从前台请求链路中拆出来，通过事件驱动的异步 Pipeline 持续更新记忆系统。**

## 10.1 从同步写入到异步记忆处理

上一章已经看到，`MOS.add()` 会读取：

```python
sync_mode = cube.text_mem.mode
```

如果模式是：

```text
sync
```

TreeTextMemory 路径直接使用：

```text
MemReader
→ fine
→ TreeTextMemory.add()
```

也就是当前请求直接完成较精细的 Memory Formation。

但如果：

```text
mode = async
```

当前 `MOS.add()` 明确要求 MemScheduler 已经工作，否则直接触发断言；此时 MemReader 首先使用 `fast` 模式，把可以快速生成的 Memory 写进去，然后将这些 Memory ID 封装成 `MEM_READ_TASK_LABEL` 消息交给 Scheduler。

因此异步写入的核心不是：

```text
什么都不存
→ 全部扔给后台
```

而更接近：

```text
第一阶段：Fast Path

Messages
 ↓
MemReader(mode="fast")
 ↓
简单 Memory
 ↓
TreeTextMemory.add()
 ↓
马上可用
```

随后：

```text
第二阶段：Background Fine Path

Fast Memory IDs
 ↓
ScheduleMessageItem
label = MEM_READ_TASK_LABEL
 ↓
MemScheduler
 ↓
MemReader.fine_transfer_simple_mem()
 ↓
Fine Memories
 ↓
TreeTextMemory.add()
```

当前 `mem_read_handler` 的源码就是先根据 ID 取回之前生成的 Fast Memory，再调用：

```python
mem_reader.fine_transfer_simple_mem(...)
```

进行更深入处理，随后把增强后的 Memory 再写回 `text_mem`；如果其中生成 `RawFileMemory`，还可以继续单独建立 RawFile 节点和相关边。

这实际上形成了一种非常典型的两阶段 Memory Pipeline：

```text
                 Raw Input
                    ↓
              Fast Extraction
                    ↓
              Working Result
                    ↓
           ┌────────┴────────┐
           ↓                 ↓
     当前立即可用        Scheduler Queue
                             ↓
                       Fine Extraction
                             ↓
                     Enhanced Memory
                             ↓
                      Graph / Storage
```

这种设计解决的是性能与记忆质量之间的矛盾：

```text
全部 Fast：
延迟低
但 Memory 质量一般

全部 Fine：
Memory 质量高
但请求延迟高

Fast + Async Fine：
前台速度较快
+
后台逐渐提高 Memory 质量
```

这也是理解 MemScheduler 最重要的第一点：

> **Scheduler 让“当前能用的记忆”和“最终高质量的记忆”不必在同一个时间点完成。**

需要注意，当前 `sync` 模式即使开启 Scheduler，也不是完全不产生 Scheduler 任务。TreeTextMemory 同步完成写入后，MOS 会提交 `ADD_TASK_LABEL`；而 `async` 路径提交的是 `MEM_READ_TASK_LABEL`。也就是说，同步和异步的差异不是“有没有 Scheduler”，而是 **Scheduler 后台承担的工作深度不同**。

## 10.2 消息驱动架构：Queue、Label 与 Handler

MemScheduler 采用的不是：

```text
if task == A:
    ...
elif task == B:
    ...
```

这种所有业务逻辑堆在一个 Scheduler 类里的模式，而是典型的事件驱动架构：

```text
Producer
   ↓
ScheduleMessageItem
   ↓
Task Queue
   ↓
Dispatcher / Registry
   ↓
根据 label
选择 Handler
   ↓
执行 Memory Task
```

当前 `GeneralScheduler` 本身已经非常薄。初始化时，它先由 `BaseScheduler` 提供基础调度能力，再创建 `SchedulerHandlerServices` 与 `SchedulerHandlerContext`，最后通过 `SchedulerHandlerRegistry.build_dispatch_map()` 建立 Label → Handler 的映射并注册。

可以把结构理解成：

```text
                 GeneralScheduler
                       │
         ┌─────────────┼──────────────┐
         ↓             ↓              ↓
       Queue         Registry       Context
         │             │              │
         ↓             ↓              ↓
       Task         Label →       Memory /
      Buffer        Handler        Reader /
                                  Retriever
```

Scheduler 中流转的统一数据对象叫：

```python
ScheduleMessageItem
```

主要字段包括：

```text
item_id
user_id
mem_cube_id
label
content
timestamp
session_id
trace_id
user_name
task_id
info
```

其中一个很重要的设计是：**队列消息不会直接携带 `GeneralMemCube` Python 对象，而只携带 `mem_cube_id`，Scheduler 在处理时再根据 ID 找到实际 Cube。** 这样消息才能更容易被序列化进 Redis，也避免把复杂 Runtime Object 塞进消息队列。

因此消息更像：

```text
ScheduleMessageItem

user_id = alice
mem_cube_id = cube_01

label =
mem_read

content =
["memory_id_1", "memory_id_2"]

task_id =
task_123
```

Scheduler 看见：

```text
label = mem_read
```

就路由给：

```text
MemRead Handler
```

看见：

```text
label = pref_add
```

就路由给：

```text
Preference Handler
```

当前官方文档列出的核心任务包括：

```text
query
answer
mem_update
add
mem_read
mem_organize
pref_add
mem_feedback
api_mix_search
```

这些 Label 分别负责查询事件、回答事件、工作记忆更新、记忆新增记录、Fine Memory Processing、图重组、偏好提取、反馈修正以及异步混合检索。

所以：

```text
Label
不是 Memory Type

Label
= “后台现在应该做什么任务”
```

例如：

```text
SkillMemory
PreferenceMemory
LongTermMemory
```

描述的是：

```text
“这是什么记忆？”
```

而：

```text
MEM_READ_TASK_LABEL
PREF_ADD_TASK_LABEL
MEM_ORGANIZE_TASK_LABEL
```

描述的是：

```text
“现在要执行什么操作？”
```

这两个层级一定要分开。

### Local Queue 与 Redis Queue

Scheduler 的任务最终需要一个 Queue 保存。当前官方提供两种主要方式：

```text
Local Queue
Redis Stream
```

Local Queue 更适合：

```text
开发
测试
单机脚本
```

特点是简单、快，但进程退出后任务无法像持久队列那样保留，也不适合多实例共享。

Redis Stream 更适合：

```text
生产环境
多进程
分布式实例
```

它支持持久化与 Consumer Group，因此多个 Scheduler 实例可以共同消费任务。

因此从部署视角：

```text
开发：

MOS
 ↓
Local Queue
 ↓
Scheduler Thread


生产：

App Instances
      ↓
Redis Stream
      ↓
Consumer Group
 ↓          ↓
Scheduler A Scheduler B
```

Scheduler 因此同时承担了两个作用：

```text
异步化
+
解耦
```

前台只负责：

```python
submit_messages(...)
```

至于任务什么时候消费、在哪个 Worker 执行，Producer 不需要知道。

## 10.3 Add Pipeline：Fast Memory 如何逐渐演化成 Fine Memory

现在把 `MOS.add()` 和 Scheduler 连起来看。

假设用户输入：

```text
“我最近开始研究 MemOS，
主要在看 TreeTextMemory，
以后回答我简洁一点。”
```

如果 TreeTextMemory 配置：

```text
mode = async
```

第一阶段：

```text
MOS.add()
 ↓
MemReader.get_memory(mode="fast")
 ↓
Fast Memory

M1：
原始对话相关文本
 ↓
TreeTextMemory.add()
 ↓
得到 mem_id
```

然后：

```text
mem_id
 ↓
ScheduleMessageItem

label =
MEM_READ_TASK_LABEL
 ↓
submit_messages()
 ↓
Scheduler Queue
```

这一部分当前由 `MOS.add()` 直接完成。

后台消费者拿到任务以后：

```text
MEM_READ_TASK
 ↓
MemRead Handler
 ↓
根据 mem_id 获取 Fast Memory
 ↓
MemReader.fine_transfer_simple_mem()
 ↓
Fine Memory Extraction
```

可能将一条粗 Memory 进一步拆成：

```text
M2：
用户正在研究 MemOS

M3：
用户当前重点研究 TreeTextMemory
```

然后重新：

```text
TreeTextMemory.add()
```

写入图中。当前处理器还会从新 Memory 中提取 `working_binding` 等信息，并在 Fine Memory 成功写入后进一步尝试触发 Organize Task。

因此异步 Tree Memory 的写入闭环可以表示为：

```text
Conversation
 ↓
FAST READER
 ↓
Fast Memory
 ↓
Graph Store
 ↓
MEM_READ Task
 ↓
FINE READER
 ↓
Fine Memory
 ↓
Graph Store
 ↓
MEM_ORGANIZE Task（条件满足时）
 ↓
Graph Reorganization
```

这时候 Scheduler 就已经不只是“异步执行一个函数”，而开始承担：

```text
Memory Refinement
+
Memory Organization
```

### Preference 走另一条独立异步路径

如果同时启用了：

```text
pref_mem
+
async mode
```

`MOS.add()` 不会在当前请求中同步执行 Preference Extraction，而是直接提交：

```text
PREF_ADD_TASK_LABEL
```

其 `content` 保存原始 Message List。

后台 `Preference Handler` 收到任务以后：

```text
Messages
 ↓
pref_mem.get_memory()
 ↓
Preference Extraction
 ↓
PreferenceTextMemory.add()
```

当前 `pref_add_handler` 会校验目标 Memory 确实是 `PreferenceTextMemory`，然后通过 `get_memory()` 抽取偏好，再调用 `add()` 写入。

所以一次异步 `MOS.add(messages)` 实际上可能出现两个并行演化方向：

```text
                     Messages
                        ↓
                     MOS.add
                        ↓
              ┌─────────┴─────────┐
              ↓                   ↓
          Text Pipeline       Preference Pipeline
              ↓                   ↓
          Fast Memory         PREF_ADD Task
              ↓                   ↓
        MEM_READ Task        Pref Extraction
              ↓                   ↓
          Fine Memory        Preference Memory
              ↓                   ↓
        Graph Organize           Store
```

这也是为什么 Scheduler 与前面第八章的特殊 Memory 紧密相关：**很多高级 Memory 的形成并不一定要阻塞当前用户请求，可以通过 Scheduler 后台继续完成。**

## 10.4 Query Pipeline：Scheduler 不只处理“写入”

Scheduler 还有一个容易忽略的重要作用：**用户的 Query 本身也会成为 Memory 调度事件。**

在当前 `MOS.chat()` 中，对每个用户可以访问的 Cube，在执行正常 `text_mem.search()` 前，如果 Scheduler 已启用，会先提交：

```text
QUERY_TASK_LABEL
```

随后前台仍然立即执行原来的 Memory Search 和 Chat Generation，并不会等待 Scheduler 才回答。

因此：

```text
User Query
   ↓
MOS.chat()
   ↓
┌─────────────────────────┐
│                         │
↓                         ↓
正常 Search           QUERY_TASK
↓                         ↓
LLM Response          Scheduler
```

用户 Query 同时进入两个世界：

```text
前台：
为了回答当前问题

后台：
为了更新 Memory 状态
```

`QueryMessageHandler` 当前的一个关键行为是把：

```text
QUERY_TASK_LABEL
```

进一步转换成：

```text
MEM_UPDATE_TASK_LABEL
```

并重新提交到 Scheduler。

所以形成：

```text
QUERY
 ↓
Query Handler
 ↓
MEM_UPDATE
 ↓
Memory Update Handler
```

`MEM_UPDATE` 才是真正负责工作记忆动态调整的核心任务。当前处理逻辑会先提取 Query Keywords，写入 Query Monitor，然后结合当前 Working Memory 与用户查询判断是否需要触发新的检索；如果触发，则获得新的候选 Memory，并调用 `replace_working_memory()` 替换 Working Memory。

概念上：

```text
用户不断提问
      ↓
Query Monitor
      ↓
最近用户现在关心什么？
      ↓
是否应该刷新 Working Memory？
      ↓
No ─────────→ 保持不变

Yes
 ↓
从 Long-term Memory
检索新的候选
 ↓
替换部分 Working Memory
```

例如长期记忆中：

```text
M1：用户研究 Python
M2：用户研究 MemOS
M3：用户研究 TreeTextMemory
M4：用户以前做 Java 项目
```

最开始 Working Memory：

```text
M1
M4
```

用户连续询问：

```text
TreeTextMemory 怎么存？
Graph Retriever 怎么工作？
MemoryManager 是干什么的？
```

Scheduler 可以发现当前 Query 主题发生变化：

```text
当前主要关注：
MemOS / TreeTextMemory
```

于是：

```text
旧 Working Memory

Python
Java

        ↓
Scheduler Retrieval
        ↓

新 Working Memory

MemOS
TreeTextMemory
```

因此 WorkingMemory 不是：

```text
一批写进去以后永远不变的数据
```

而更接近：

```text
根据用户近期任务动态维护的 Memory Cache
```

这也解释了前面 Tree Memory 中：

```text
WorkingMemory
```

为什么和普通 LongTermMemory 的意义不同。

`memory_update_handler` 当前还支持根据 Intent 与时间间隔判断是否真的需要触发检索，而不是每一个 Query 都无条件刷新 Working Memory；完成新候选召回后，通过 `replace_working_memory()` 更新工作区，如果启用了 Activation Memory，还可以继续触发 Activation Memory 的周期性更新。

所以 Scheduler 的 Query Pipeline 更完整地表示为：

```text
Query
 ↓
QUERY_TASK
 ↓
Query Handler
 ↓
MEM_UPDATE_TASK
 ↓
Extract Keywords
 ↓
Update Query Monitor
 ↓
Intent / Time Trigger
 ↓
Need Retrieval?
    │
 ┌──┴───┐
No      Yes
│        ↓
│    Retrieve Long Memory
│        ↓
│    Candidate Memories
│        ↓
│    Replace Working Memory
│        ↓
│    Activation Update（可选）
│
└──────────────→ Done
```

这就是 Scheduler 真正“调度 Memory”的地方：它不只是把任务扔到后台，而是在维护 **Long-term Memory → Working Memory** 的动态流转。

## 10.5 Answer、Organize、Feedback 与可扩展任务

用户 Query 会进入 Scheduler，Assistant Answer 也一样。

当前 `MOS.chat()` 在 LLM 返回结果并写入 Chat History 后，会针对用户有权限的 Cube 提交：

```text
ANSWER_TASK_LABEL
```

给 Scheduler。

于是完整 Chat 变成：

```text
                   User Query
                       ↓
                     MOS.chat
                 ┌─────┴─────┐
                 ↓           ↓
           QUERY_TASK      Search
                 ↓           ↓
            Scheduler     Chat LLM
                             ↓
                          Response
                             ↓
                        ANSWER_TASK
                             ↓
                          Scheduler
```

这意味着 Scheduler 能同时观察：

```text
用户问了什么
+
模型答了什么
```

为之后的 Memory Update、日志和演化机制提供完整事件流。

除了 Query / Answer，当前 Scheduler 还包含：

```text
MEM_ORGANIZE_TASK_LABEL
```

用于触发记忆重组与 Merge；`MEM_FEEDBACK_TASK_LABEL` 用于处理反馈并修正或强化 Memory；`OptimizedScheduler` 还增加 `API_MIX_SEARCH_TASK_LABEL`，用于异步混合搜索。

当前代码目录中还存在 `mem_dream_handler.py`，Dream 机制则进一步通过插件接入 Scheduler。现有 Community Dream Plugin 默认关闭，但它已经能够创建 `MEM_DREAM_TASK_LABEL` 的 `ScheduleMessageItem` 并提交给 Scheduler，为更高级的记忆整合和离线演化提供扩展入口。

可以把这些后台任务分成几类：

```text
输入事件
├── QUERY
└── ANSWER

记忆形成
├── MEM_READ
├── PREF_ADD
└── ADD

记忆维护
├── MEM_UPDATE
├── MEM_ORGANIZE
└── MEM_FEEDBACK

高级扩展
├── API_MIX_SEARCH
└── MEM_DREAM
```

这体现的是一个非常重要的架构思想：

> **Memory 不再只是数据库里的静态数据，而变成一个可以被事件不断触发、更新、重组和再加工的长期状态系统。**

Scheduler 还允许注册自定义 Handler：

```python
scheduler.register_handlers({
    MY_TASK_LABEL: my_handler
})
```

然后任何地方都可以构造 `ScheduleMessageItem(label=MY_TASK_LABEL, ...)` 提交。官方文档明确把这种 Label → Handler 注册机制作为 Scheduler 的扩展方式。

所以 Scheduler 实际上也是一个简单的：

```text
Event Bus
+
Task Dispatcher
```

如果未来想扩展：

```text
MEMORY_SUMMARY
USER_PROFILE_UPDATE
SKILL_EXTRACT
MEMORY_COMPRESS
```

理论上都可以沿相同机制：

```text
定义 Label
 ↓
实现 Handler
 ↓
register_handlers()
 ↓
submit_messages()
```

而不需要修改 MOS 主请求逻辑。

## 10.6 MemScheduler 在完整系统中的位置

现在可以重新画整个 MemOS：

```text
                    Application
                         ↓
                        MOS
              ┌──────────┼──────────┐
              ↓          ↓          ↓
             add       search      chat
              ↓                     ↓
          MemReader              Query / Answer
              ↓                     ↓
          Memory.add            Scheduler Event
              ↓                     ↓
         MemCube / Store       MemScheduler
                                    ↓
                           ┌────────┼─────────┐
                           ↓        ↓         ↓
                       MemRead   MemUpdate  PrefAdd
                           ↓        ↓         ↓
                         Fine    Working    Preference
                       Memory    Memory      Memory
                           ↓        ↓         ↓
                           └────────┼─────────┘
                                    ↓
                              Memory System
```

从职责角度：

```text
MOS
→ 当前请求怎么执行

MemReader
→ 输入怎么变成 Memory

Memory
→ Memory 怎么存和搜

Searcher
→ Query 怎么检索 Memory

MemScheduler
→ 哪些 Memory 工作应该什么时候执行
```

这句尤其重要：

```text
MemScheduler
不是负责“Memory 怎么存”

而是负责：
“Memory 相关任务什么时候做、
按什么事件触发、
由哪个 Handler 做”
```

因此 `MemoryManager` 和 `MemScheduler` 也不要混：

```text
MemoryManager
→ 一个 TreeTextMemory 内部
→ Memory 节点如何组织

MemScheduler
→ 系统级异步调度
→ 什么时候触发 Memory Processing
```

两者关系更像：

```text
Scheduler
决定：
“现在需要整理 Memory 了”

        ↓

MemoryManager
真正执行：
“这些节点应该怎么写和组织”
```

从源码阅读角度，这一章最值得追的主链有三条。

第一条是 Scheduler 初始化：

```text
MOSCore.__init__()
 ↓
enable_mem_scheduler
 ↓
_initialize_mem_scheduler()
 ↓
SchedulerFactory.from_config()
 ↓
GeneralScheduler
 ↓
initialize_modules()
 ↓
start()
```

当前 MOS 会把 `chat_llm`、MemReader 的 `general_llm` 和 UserManager 的 DB Engine 注入 Scheduler，然后启动调度器，并把 `mem_cubes` 与 `mem_reader` 共享给它。

第二条是异步写入：

```text
MOS.add()
 ↓
MemReader fast
 ↓
TreeTextMemory.add()
 ↓
MEM_READ_TASK
 ↓
Scheduler
 ↓
MemRead Handler
 ↓
fine_transfer_simple_mem()
 ↓
Fine Memory
 ↓
TreeTextMemory.add()
 ↓
MEM_ORGANIZE（可选）
```

第三条是对话驱动 Working Memory：

```text
MOS.chat()
 ↓
QUERY_TASK
 ↓
Query Handler
 ↓
MEM_UPDATE_TASK
 ↓
Memory Update Handler
 ↓
Query Monitor
 ↓
Intent Detection
 ↓
Retrieve Long Memory
 ↓
replace_working_memory()
```

把 Scheduler 再压缩成伪代码：

```python
class MemScheduler:

    def submit_messages(messages):
        queue.push(messages)

    def worker_loop():
        while True:
            messages = queue.consume()

            for label, batch in group_by_label(messages):
                handler = registry[label]
                handler(batch)
```

然后 Handler 可以继续产生新任务：

```python
def query_handler(message):

    submit_messages(
        ScheduleMessageItem(
            label=MEM_UPDATE_TASK_LABEL,
            content=message.content
        )
    )
```

最终形成：

```text
Event
 ↓
Queue
 ↓
Handler
 ↓
New Event
 ↓
Queue
 ↓
Another Handler
```

也就是一条事件驱动的 Memory Workflow。

本章最终要建立三个核心认识。

第一：

```text
Async Memory
≠ 延迟把同一件事做一遍

而是：
Fast Result
+
Background Refinement
```

第二：

```text
Scheduler
≠ Memory Storage

Scheduler
= Event-driven Memory Orchestration
```

第三：

```text
Memory 不再只是：

Add
→ Store
→ Search

而是：

Add
→ Refine
→ Search
→ Observe Query
→ Update Working Memory
→ Reorganize
→ Feedback
→ Continue Evolving
```

所以 MemScheduler 是 MemOS 从“一个带长期记忆的 RAG 系统”继续走向“**持续运行的 Memory Operating System**”时非常关键的一层。官方架构也将它定义为独立运行、基于消息队列的调度系统，用于协调记忆更新、工作记忆管理、检索与监控。

下一章可以进入 **《多用户、多 MemCube 与权限模型：Memory 如何真正服务多个用户与多个记忆空间》**。这一章会重点解释 `UserManager`、用户与 Cube 的绑定关系、`register_mem_cube()`、访问校验、多 Cube 搜索，以及为什么 MOS 的“多用户能力”并不只是给 Memory 加一个 `user_id` 字段。
