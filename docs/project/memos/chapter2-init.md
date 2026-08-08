# 第二章：MOS 的初始化与组件装配

## 本章要解决的问题

第一章已经知道，MemOS 有多种使用入口，其中：

```text
Python SDK → MOS → MemCube / Memory
MCP        → MOS → MemCube / Memory

REST API   → Handler → 底层组件
```

因此，`MOS` 并不是整个 MemOS 所有请求的唯一入口，而是 **Python SDK 侧最主要的高层编排器（Orchestrator / Facade）**。

官方文档也将 MOS 定义为负责协调多个 MemCube 和记忆操作的编排层。

本章重点回答：

```text
from memos import MOS

mos = MOS(...)
```

这一句执行之后，内存里到底创建了什么？

最终我们希望理解：

```text
MOS
│
├── MOSConfig
│
├── Chat LLM
│
├── MemReader
│
├── UserManager
│
├── ChatHistory
│
├── MemCube Registry
│     ├── Cube A
│     ├── Cube B
│     └── ...
│
└── MemScheduler（可选）
```

---

## MOS 与 MOSCore 的关系及三种初始化方式

源码首先要看：

```text
src/memos/mem_os/main.py
src/memos/mem_os/core.py
```

类关系非常简单：

```text
MOSCore
   ↑
   │ extends
   │
  MOS
```

也就是：

```python
class MOS(MOSCore):
    ...
```

当前源码明确说明，`MOS` 继承 `MOSCore`；`MOSCore` 才是管理多个 MemCube、用户以及主要 Memory 操作的核心编排类。

可以先粗略理解：

```text
MOS
=
对外使用入口
+
自动配置
+
部分高级 Chat 能力


MOSCore
=
真正的 Memory OS 编排核心
```

所以：

```python
mos = MOS(...)
```

创建过程中最终一定会执行：

```python
MOSCore.__init__(...)
```

这也是为什么读源码不能只看 `main.py`。

真正重要的初始化逻辑大量集中在：

```text
core.py
```

---


**第一种：`MOS.simple()`**

最简单：

```python
from memos import MOS

mos = MOS.simple()
```

但源码里 `simple()` 本身几乎什么都没做。

它最终只是调用：

```text
MOS.simple()
    ↓
MOS()
```

真正的自动配置发生在：

```text
MOS.__init__(config=None)
```

而不是发生在 `simple()` 内部。当前 `simple()` 的实现最终直接返回一个无参 `MOS` 实例。

所以：

```text
MOS.simple()
≈
MOS()
```

当前版本两者走的是同一套自动初始化逻辑。

---

**第二种：直接 `MOS()`**

例如：

```python
from memos import MOS

mos = MOS()
```

因为：

```text
config = None
```

所以进入：

```text
MOS.__init__()
    ↓
_auto_configure()
```

当前 `_auto_configure()` 会读取包括：

```text
OPENAI_API_KEY
OPENAI_API_BASE
MOS_TEXT_MEM_TYPE
```

在内的环境配置，然后通过默认配置构造逻辑获得：

```text
MOSConfig
+
默认 MemCube
```

随后进入正常的 `MOSCore` 初始化，并在最后自动注册这个默认 Cube。

因此自动模式可以画成：

```text
MOS()
 ↓
config == None
 ↓
_auto_configure()
 ↓
读取环境变量
 ↓
get_default(...)
 ↓
得到：

MOSConfig
+
Default MemCube
 ↓
MOSCore.__init__(config)
 ↓
register_mem_cube(Default Cube)
 ↓
得到可以直接工作的 MOS
```

这也是为什么 `MOS.simple()` 看起来只需要一行代码。

很多底层组件已经由默认配置替你准备好了。

---

**第三种：`MOS(custom_config)`**

高级使用方式是：

```python
from memos import MOS, MOSConfig

config = MOSConfig(
    ...
)

mos = MOS(config)
```

这时候：

```text
config != None
```

所以不会进入：

```text
_auto_configure()
```

也不会自动生成默认 Cube。

当前源码在收到自定义 `MOSConfig` 时，会将自动注册 Cube 的变量设置为空，然后直接进入 `MOSCore.__init__(config)`。

所以：

```text
MOS(custom_config)
        ↓
不会 _auto_configure()
        ↓
不会自动创建默认 Cube
        ↓
MOSCore.__init__(config)
        ↓
初始化 MOS 基础组件
```

这时候后续通常还需要：

```text
创建 / 加载 GeneralMemCube
        ↓
register_mem_cube(...)
```

所以真正理解源码时，比起：

```python
MOS.simple()
```

更应该理解：

```text
MOSConfig
   ↓
MOS

+

GeneralMemCube
   ↓
register_mem_cube()
```

---


可以把当前源码简化成下面这段逻辑：

```text
MOS.__init__(config)

if 没有 config:
    自动生成 MOSConfig
    自动生成 Default Cube
else:
    使用传入的 MOSConfig

↓
处理 PRO_MODE 等 MOS 自身配置

↓
super().__init__(config)

↓
进入 MOSCore.__init__()

↓
如果之前自动生成了 Default Cube:
    register_mem_cube(Default Cube)
```

当前实际代码就是先判断 `config` 是否为空；为空时调用 `_auto_configure()`，然后调用父类 `MOSCore.__init__()`，最后再处理自动生成 Cube 的注册。

这里有一个很重要的设计：

> **创建 MOS 和创建 MemCube 是两件不同的事情。**

也就是说：

```text
MOS
≠
MemCube
```

MOS 初始化负责：

```text
创建“管理系统”
```

MemCube 初始化负责：

```text
创建“被管理的记忆空间”
```

然后通过：

```python
mos.register_mem_cube(...)
```

将两者关联起来。

---

## MOSCore.__init__()：组件装配过程

进入：

```text
src/memos/mem_os/core.py
```

之后才真正开始组装 Memory OS。

当前构造函数接收：

```text
MOSConfig
+
可选 UserManager
```

源码中的初始化过程可以拆成几个关键步骤。

---

**第一步：保存当前用户和会话信息**

首先从 `MOSConfig` 中拿出：

```text
user_id
session_id
```

形成：

```text
MOS
├── user_id
└── session_id
```

可以理解为：

> 这个 MOS 默认正在为谁、哪次会话工作？

例如：

```text
user_id = alice
session_id = session_001
```

以后执行：

```python
mos.add(...)
mos.search(...)
mos.chat(...)
```

如果没有显式提供其他用户信息，就可以使用 MOS 当前的默认上下文。

---

**第二步：创建 Chat LLM**

接着执行的核心逻辑可以抽象成：

```text
MOSConfig.chat_model
        ↓
LLMFactory
        ↓
具体 LLM
```

源码调用 `LLMFactory.from_config(config.chat_model)` 创建 `chat_llm`。

例如配置写：

```text
backend = OpenAI
```

那么：

```text
LLMFactory
    ↓
OpenAI LLM
```

如果配置改成其他已注册 Provider：

```text
Qwen
DeepSeek
HuggingFace
...
```

Factory 就负责创建对应实现。

因此 MOS 不直接写死：

```python
OpenAI(...)
```

而是：

```text
Config
  ↓
Factory
  ↓
具体 Provider
```

这是一种非常典型的 **Factory Pattern**。

后面你会发现：

```text
LLM
Embedding
Vector DB
Graph DB
Memory
Scheduler
```

MemOS 大量组件都采用这种设计。

---

**第三步：创建 MemReader**

接下来：

```text
MOSConfig.mem_reader
       ↓
MemReaderFactory
       ↓
具体 MemReader
```

源码将结果保存在：

```text
self.mem_reader
```

中。

MemReader 负责的是：

> **把原始输入进一步解析、抽取或组织成适合长期保存的 Memory。**

例如：

```text
用户：
“以后酒店最好控制在 500 元以内。”
```

经过记忆抽取后，可能形成更适合长期保存的信息：

```text
住宿预算偏好：
≤ 500 元
```

所以：

```text
chat_llm
```

主要解决：

```text
怎么回答用户
```

而：

```text
mem_reader
```

主要解决：

```text
怎么理解和提取记忆
```

二者虽然底层都可能使用 LLM，但职责不同。

---

**第四步：准备聊天历史**

MOSCore 会维护：

```text
chat_history_manager
```

它本质上记录不同会话对应的近期 Chat History。

例如：

```text
chat_history_manager

session_A
├── user message 1
├── assistant message 1
├── user message 2
└── assistant message 2

session_B
├── ...
```

需要特别区分：

```text
Chat History
≠
Long-term Memory
```

Chat History 更偏：

```text
最近发生了什么？
```

Memory 更偏：

```text
从过去大量交互中，有什么值得长期保留？
```

真正执行 `MOS.chat()` 时，两者会一起参与 Prompt 构造。

---

**第五步：创建 MemCube Registry**

MOSCore 里面还会创建：

```text
self.mem_cubes
```

它可以理解成：

> **MOS 当前已经加载了哪些 MemCube 的注册表。**

概念上类似：

```python
mem_cubes = {
    "alice_private": cube_a,
    "project_shared": cube_b,
    "company_public": cube_c,
}
```

因此：

```text
MOS
│
└── mem_cubes
     ├── Cube A
     ├── Cube B
     └── Cube C
```

MOS 自己并不等于某一个 Cube。

而是：

> **MOS 可以同时管理多个 Cube。**

官方架构设计也明确把 MOS 定义为编排层，把 MemCube 定义为可独立服务于用户、Agent 或 Session 的模块化记忆容器。

---

**第六步：初始化 UserManager**

接下来：

```text
MOS
 ↓
UserManager
```

如果外部已经提供：

```text
user_manager
```

MOS 就直接使用。

否则 MOS 自己创建一个 `UserManager`。

随后还会验证：

```text
当前 user_id 是否存在并且有效
```

如果用户无效，初始化就会失败。

UserManager 的作用不是：

```text
存 Memory
```

而是维护：

```text
用户
角色
Cube
用户 ↔ Cube 权限
```

例如：

```text
Alice
├── Alice_Private    ✅
├── Project_A        ✅
└── Bob_Private      ❌
```

因此以后：

```python
mos.search(user_id="alice")
```

MOS 才知道：

> Alice 到底可以搜索哪些 Cube？

---

**第七步：按配置初始化 MemScheduler**

最后一个比较大的组件是：

```text
MemScheduler
```

MOS 会检查：

```text
enable_mem_scheduler
```

如果没有开启：

```text
MOS
└── scheduler = None
```

如果开启：

```text
MOSConfig.mem_scheduler
       ↓
SchedulerFactory
       ↓
General / Optimized Scheduler
```

当前源码中，Scheduler 创建之后还会获得 MOS 的：

```text
MemCube Registry
MemReader
Chat LLM
处理用 LLM
UserManager 数据库 Engine
```

随后进行模块初始化并启动。

所以最终变成：

```text
MOS
│
├── LLM
├── MemReader
├── UserManager
├── MemCubes
└── Scheduler
       │
       ├── 能访问 MemCubes
       ├── 能调用 MemReader
       └── 能执行后台记忆任务
```

Scheduler 并不是 MemOS 必须存在的组件。

它主要针对：

```text
异步记忆抽取
记忆重组
偏好处理
后台检索处理
Dream
高吞吐任务
```

后面会单独拆 Scheduler。

---


整个初始化过程可以压缩为：

```text
              MOSConfig
                  ↓
          MOSCore.__init__()
                  ↓
     ┌────────────┼─────────────┐
     ↓            ↓             ↓
 Chat LLM      MemReader    UserManager
     │            │             │
     └────────────┼─────────────┘
                  ↓
                 MOS
                  │
        ┌─────────┼─────────┐
        ↓         ↓         ↓
 ChatHistory   MemCubes   Scheduler
```

所以：

> **MOSCore 初始化的本质不是“创建 Memory”，而是把操作 Memory 所需要的各种管理组件准备好。**

---

## MemCube 的注册与两套配置

这里就是：

```python
register_mem_cube(...)
```

它非常重要。

假设：

```python
cube = GeneralMemCube(...)
```

此时只是：

```text
内存中存在一个 Cube
```

MOS 并不知道这个 Cube。

调用：

```python
mos.register_mem_cube(cube)
```

以后：

```text
GeneralMemCube
       ↓
register_mem_cube()
       ↓
MOS.mem_cubes
```

才真正进入 MOS 的管理范围。

---


当前源码支持几种情况。

第一种最直接：

```text
已经存在的 GeneralMemCube 对象
```

例如：

```python
mos.register_mem_cube(cube)
```

第二种：

```text
本地 Cube 目录
```

MOS 会尝试从目录初始化 Cube。

第三种：

```text
不是本地存在的路径
```

当前实现还会尝试按远程仓库方式加载对应 Cube。

所以整体可以理解成：

```text
                  register_mem_cube()

             ┌─────────┼─────────┐
             ↓         ↓         ↓
         Cube对象    本地目录    远程来源
             │         │         │
             └─────────┼─────────┘
                       ↓
                GeneralMemCube
                       ↓
                MOS.mem_cubes
```

---


这是源码里很值得注意的一点。

你可能以为：

```python
mos.register_mem_cube(cube)
```

只是：

```python
self.mem_cubes[id] = cube
```

实际上不止。

当前实现还会：

```text
确定 target user
        ↓
检查用户存在
        ↓
确定 cube_id
        ↓
加载 / 保存 Cube 对象
        ↓
检查 UserManager 中是否已有这个 Cube
        ↓
建立：
user ↔ cube
访问关系
```

如果 Cube 已经在用户管理数据库中存在，但当前用户还没有访问权，则会尝试把用户加入该 Cube；如果不存在，则通过用户管理层创建 Cube 记录。

也就是说：

```text
register_mem_cube
=
加载 Cube
+
加入 MOS Registry
+
登记 Cube
+
建立用户访问关系
```

这解释了为什么后面的：

```python
mos.search(user_id="alice")
```

能够根据 Alice 找到她有权限访问的 Cube。

---


这里很容易混淆。

MOS 有：

```text
MOSConfig
```

Cube 又有：

```text
GeneralMemCubeConfig
```

两者解决的问题完全不同。

可以简单理解成：

```text
MOSConfig
=
“总经理怎么工作？”

包括：
Chat LLM
MemReader
User
Session
Scheduler
默认检索参数
...
```

而：

```text
GeneralMemCubeConfig
=
“这个记忆库里面装什么？”

包括：
text_mem
pref_mem
act_mem
para_mem
以及它们各自的底层配置
```

所以：

```text
MOSConfig
       ↓
      MOS
       │
       │ manages
       ↓
GeneralMemCube
       ↑
GeneralMemCubeConfig
```

官方源码结构也将 `MOSConfig` 和 `GeneralMemCubeConfig` 作为两套主要配置对象分别维护。

这就是为什么不能觉得：

> “我已经创建 `MOSConfig` 了，为什么还要配置 MemCube？”

因为一个配置的是：

```text
操作系统
```

另一个配置的是：

```text
这个操作系统管理的记忆空间
```

---

## 自动/自定义模式与设计动机

现在可以把两条链放在一起。

**自动模式**

```text
MOS.simple()
     ↓
    MOS()
     ↓
config = None
     ↓
_auto_configure()
     ↓
生成：

MOSConfig
+
Default Cube
     ↓
MOSCore.__init__()
     ↓
创建：
LLM
MemReader
UserManager
Scheduler...
     ↓
register_mem_cube(Default Cube)
     ↓
可以直接 add/search/chat
```

当前源码就是这种行为。

**自定义模式**

```text
MOSConfig
   ↓
MOS(config)
   ↓
MOSCore.__init__()
   ↓
创建：
LLM
MemReader
UserManager
Scheduler...
   ↓

此时还没有自动 Cube

   ↓
GeneralMemCube(...)
   ↓
register_mem_cube(...)
   ↓
可以 add/search/chat
```

因此有一个非常重要的结论：

> **`MOS` 初始化成功，不代表已经存在可读写的记忆库。**

真正用于保存 Memory 的还是：

```text
MemCube
```

而 MOS 只是：

```text
管理和编排 MemCube
```

---


假设完整启动完成：

```text
                    MOS
                     │
          ┌──────────┼───────────┐
          ↓          ↓           ↓
      Chat LLM    MemReader   UserManager
                                  │
                                  ↓
                           用户/Cube权限
                     │
                     │
                     ↓
               MemCube Registry
               /       |        \
              /        |         \
             ↓         ↓          ↓
        AliceCube  ProjectCube  SharedCube
             │
       ┌─────┼─────┐
       ↓     ↓     ↓
    text   pref   act ...
     mem    mem    mem
                     │
                     ↓
                Scheduler
                （可选）
```

因此 MOS 的本质可以总结为：

```text
MOS
不是 Memory
不是 Database
不是 Vector DB

MOS
=
Memory System Orchestrator
```

它把：

```text
用户
会话
LLM
MemReader
MemCube
Scheduler
```

组织在一起。

---


假设没有这些抽象，可能变成：

```python
class MOS:
    def __init__(self):
        self.openai = OpenAI(...)
        self.qdrant = Qdrant(...)
        self.neo4j = Neo4j(...)
        self.reader = ...
        self.memory = ...
        self.scheduler = ...
```

问题是：

```text
换 Qdrant → 要改 MOS
换 LLM → 要改 MOS
换 Memory → 要改 MOS
换 Scheduler → 要改 MOS
```

而 MemOS 当前大量采用：

```text
Config
   ↓
Factory
   ↓
Interface
   ↓
Concrete Implementation
```

例如：

```text
MOSConfig.chat_model
        ↓
LLMFactory
        ↓
OpenAI / Qwen / HuggingFace / ...
```

这样 MOS 只负责：

```text
“我要一个 LLM”
```

而不用负责：

```text
“这个 LLM 到底怎么创建”
```

这也是整个 MemOS 源码非常重要的一种设计思想：**通过 Config + Factory 解耦高层编排和具体实现。** 项目自身的开发说明也明确要求各类 Provider 采用 `base + factory + backend implementation` 的结构。

---


真正读源码时，建议按：

```text
from memos import MOS

        ↓

src/memos/mem_os/main.py

MOS.__init__()
        ↓
_auto_configure()   （可选）
        ↓
super().__init__()

        ↓

src/memos/mem_os/core.py

MOSCore.__init__()
        ↓
LLMFactory
        ↓
MemReaderFactory
        ↓
UserManager
        ↓
MemCube Registry
        ↓
SchedulerFactory（可选）

        ↓

register_mem_cube()

        ↓

GeneralMemCube
```

只要这一条能追下来，MOS 的初始化基本就已经看懂了。

---

## 本章结论

这一章最终只需要记住几个核心关系：

```text
MOS.simple()
=
MOS() 的快捷入口
```

```text
MOS()
=
自动生成 Config + Default Cube
```

```text
MOS(config)
=
自己控制 MOS 配置
但不会自动给你准备默认 Cube
```

```text
MOSCore.__init__()
=
真正完成主要组件装配
```

```text
register_mem_cube()
=
把一个 Cube 加入 MOS 管理
+
建立用户和 Cube 的访问关系
```

最后：

```text
MOS
=
编排层

MemCube
=
记忆空间

Memory
=
真正的记忆能力

Storage
=
真正的数据保存位置
```

所以：

```text
MOS
   ↓ manages
MemCube
   ↓ contains
Memory
   ↓ uses
Embedder / Vector DB / Graph DB / LLM
```

这就是整个 SDK 侧源码最基本的对象关系。

---

## 下一章要解决的问题

现在已经知道：

```text
MOS 怎么创建
↓
MOS 怎么获得 LLM
↓
MOS 怎么获得 MemReader
↓
MOS 怎么管理用户
↓
MOS 怎么注册 MemCube
```

但是还有一个最关键的问题没有回答：

> **`GeneralMemCube(...)` 自己又是怎么被创建出来的？**

也就是：

```text
GeneralMemCubeConfig
        ↓
GeneralMemCube.__init__()
        ↓
MemoryFactory
        ↓
text_mem
pref_mem
act_mem
para_mem
        ↓
这些 Memory 到底是什么？
```

所以下一章应该进入：

**第三章：MemCube 与 Memory——一个记忆空间内部到底装了什么？**
