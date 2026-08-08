# 第三章：MemCube 与 Memory——一个记忆空间内部到底装了什么？

## 本章要解决的问题

上一章已经知道，SDK 侧的 `MOS` 本身并不保存具体 Memory，它更像整个记忆系统的编排器：

```text
MOS
 ↓ manages
MemCube
 ↓ contains
Memory
 ↓ uses
LLM / Embedder / VecDB / GraphDB
```

因此接下来最重要的问题是：**MOS 管理的 MemCube 到底是什么？一个 Cube 内部为什么还要再分 text_mem、pref_mem、act_mem、para_mem？这些 Memory 又是怎么被创建出来的？**
MemOS 当前把 `GeneralMemCube` 定义为主要的通用记忆容器。`BaseMemCube` 规定 MemCube 至少应该拥有 `text_mem`、`act_mem`、`para_mem`、`pref_mem` 四个逻辑位置，并提供 `load()`、`dump()` 两个持久化接口；`GeneralMemCube` 则真正实现这些能力。
最重要的认识是：

```text
MemCube ≠ 一条 Memory
MemCube ≠ 一个 Vector DB
MemCube ≠ 一个数据库文件

MemCube
= 一组相关 Memory 能力的逻辑容器
```

例如 Alice 可以拥有一个自己的 Cube：

```text
AliceCube
├── text_mem
├── pref_mem
├── act_mem
└── para_mem
```

MOS 管理的是 `AliceCube`，而真正执行 `add/search/update/delete` 的，是 Cube 内部具体的 Memory 实现。

## 为什么要 MemCube：从存储中抽象出记忆容器

假设最简单的记忆系统只有：

```text
User
 ↓
MemoryRecord
 ↓
SQLite
```

确实不需要 MemCube。但 MemOS 想同时支持多种形态的记忆，例如文本知识、用户偏好、KV Cache、LoRA 参数，这些东西甚至不一定存在同一种数据库中：

```text
Alice 的记忆
├── 文本事实        → Vector DB / Graph DB
├── 用户偏好        → Preference Memory
├── KV Cache       → 模型运行时缓存
└── LoRA           → 参数文件
```

如果 MOS 直接管理这些底层对象，就会变成：

```text
MOS
├── Qdrant
├── Neo4j
├── Preference Store
├── KV Cache
└── LoRA
```

这样 MOS 会和各种底层技术强耦合。MemCube 在中间增加了一层：

```text
MOS
 ↓
MemCube
 ↓
Memory Interface
 ↓
具体 Storage / Model
```

所以 MOS 只需要知道“我要操作这个 Cube”，Cube 再决定内部有哪些 Memory；Memory 再决定具体怎么存、怎么搜。这也是 MemOS 当前仓库把 `mem_os`、`mem_cube`、`memories` 和各种 Provider 分成独立模块的原因。

**`BaseMemCube`：MemCube 最小抽象**

文件：

```text
src/memos/mem_cube/base.py
```

当前 `BaseMemCube` 非常薄，它主要规定：

```text
BaseMemCube
├── text_mem
├── act_mem
├── para_mem
├── pref_mem
├── load(dir)
└── dump(dir)
```

源码中 `BaseMemCube` 是抽象类，构造接口接收 `BaseMemCubeConfig`；四个 Memory Slot 分别要求是 `BaseTextMemory`、`BaseActMemory`、`BaseParaMemory` 和 `BaseTextMemory`，同时要求子类实现 `load()` 和 `dump()`。
所以 `BaseMemCube` 并没有规定：

```text
必须使用 Qdrant
必须使用 Neo4j
必须使用 OpenAI
```

它只规定：

> 一个 MemCube 应该能够组合若干种 Memory，并且能够整体加载和保存。
> 真正创建具体 Memory 的工作放到了 `GeneralMemCube`。

**`GeneralMemCubeConfig`：先描述 Cube 里面要装什么**

文件：

```text
src/memos/configs/mem_cube.py
```

`GeneralMemCubeConfig` 的核心结构可以简化成：

```python
GeneralMemCubeConfig
├── user_id
├── cube_id
├── text_mem
├── act_mem
├── para_mem
└── pref_mem
```

其中 `user_id` 用于标识该 Cube 对应的用户，`cube_id` 用于区分不同 Cube；四个 Memory 字段并不是已经创建好的 Memory，而是 `MemoryConfigFactory`——也就是“应该创建什么 Memory”的配置说明。
所以这里一定要区分：

```text
GeneralMemCubeConfig.text_mem
= Text Memory 的配置

GeneralMemCube._text_mem
= 已经创建出来的 Text Memory 实例
```

数据关系是：

```text
GeneralMemCubeConfig
        ↓
MemoryFactory
        ↓
GeneralMemCube Runtime Object
```

**四个 Memory Slot 分别允许什么实现**

当前 `GeneralMemCubeConfig` 会对四个 Slot 的 backend 做校验。

| Slot       | 当前允许的主要 backend                                               | 含义               |
| ---------- | ------------------------------------------------------------- | ---------------- |
| `text_mem` | `naive_text` / `general_text` / `tree_text` / `uninitialized` | 文本、事实、知识类长期记忆    |
| `pref_mem` | `pref_text` / `uninitialized`                                 | 用户偏好             |
| `act_mem`  | `kv_cache` / `vllm_kv_cache` / `uninitialized`                | 模型 KV Cache 激活记忆 |
| `para_mem` | `lora` / `uninitialized`                                      | LoRA 等参数化记忆      |
| 其中：        |                                                               |                  |

```text
backend = "uninitialized"
```

表示这个 Cube 不启用对应 Memory。
因此一个实际 Cube 完全可以只有文本记忆：

```text
Cube
├── text_mem = general_text ✅
├── pref_mem = None
├── act_mem  = None
└── para_mem = None
```

也可以同时启用：

```text
Cube
├── text_mem = tree_text
├── pref_mem = pref_text
├── act_mem  = kv_cache
└── para_mem = lora
```

所以 **GeneralMemCube 不是固定的四套存储，而是四个可选插槽。**

## GeneralMemCube 组装与 MemoryFactory

文件：

```text
src/memos/mem_cube/general.py
```

当前初始化逻辑非常直接：

```text
GeneralMemCube(config)
        ↓
保存 config
        ↓
检查 text_mem.backend
        ↓
MemoryFactory.from_config(config.text_mem)
        ↓
得到 _text_mem

检查 act_mem.backend
        ↓
MemoryFactory.from_config(config.act_mem)
        ↓
得到 _act_mem

检查 para_mem.backend
        ↓
MemoryFactory.from_config(config.para_mem)
        ↓
得到 _para_mem

检查 pref_mem.backend
        ↓
MemoryFactory.from_config(config.pref_mem)
        ↓
得到 _pref_mem
```

如果某个 backend 是 `uninitialized`，该字段直接设为 `None`。当前源码确实分别通过 `MemoryFactory.from_config()` 创建四种 Memory Slot。
所以创建 Cube 的本质是：

```text
Config
 ↓
Factory
 ↓
Memory Object
 ↓
装入 Cube
```

这也是整个 MemOS 最重要的“配置驱动 + 工厂创建”模式之一。

**`MemoryFactory`：backend 到具体类的映射器**

文件：

```text
src/memos/memories/factory.py
```

`GeneralMemCube` 自己并不知道 `general_text` 对应哪个 Python 类，它只调用：

```python
MemoryFactory.from_config(config.text_mem)
```

当前 `MemoryFactory` 维护了一张 backend → implementation 的映射，例如：

```text
naive_text        → NaiveTextMemory
general_text      → GeneralTextMemory
tree_text         → TreeTextMemory
simple_tree_text  → SimpleTreeTextMemory
pref_text         → PreferenceTextMemory
simple_pref_text  → SimplePreferenceTextMemory
kv_cache          → KVCacheMemory
vllm_kv_cache     → VLLMKVCacheMemory
lora              → LoRAMemory
```

`from_config()` 读取 `config_factory.backend`，从映射表找到对应类，再把 `config_factory.config` 传给这个类的构造函数。
因此：

```text
backend = "general_text"
        ↓
MemoryFactory
        ↓
GeneralTextMemory(config)
```

这意味着以后如果新增：

```text
backend = "postgres_text"
```

理想情况下不需要修改 `GeneralMemCube`，只需要实现新的 Memory 类、对应 Config，并注册到 Factory。也就是说：

```text
GeneralMemCube
不关心具体 Memory 怎么实现

它只关心：
这个 Slot 最后给我一个符合 BaseMemory 契约的对象
```

## Memory 抽象体系：BaseMemory 与 BaseTextMemory

文件：

```text
src/memos/memories/base.py
```

`BaseMemory` 当前只定义两个最通用的方法：

```python
load(dir)
dump(dir)
```

也就是说，不管是文本、KV Cache 还是 LoRA，最底层共同点只有：

> 我能够从持久化目录恢复，也能够把自己的状态保存出去。
> 具体业务能力继续由子类扩展：

```text
BaseMemory
├── BaseTextMemory
├── BaseActMemory
└── BaseParaMemory
```

因此 Memory 的抽象关系可以理解成：

```text
                  BaseMemory
                      │
       ┌──────────────┼──────────────┐
       ↓              ↓              ↓
BaseTextMemory   BaseActMemory   BaseParaMemory
       ↓              ↓              ↓
 GeneralText       KVCache          LoRA
 TreeText
 Preference
```

**`BaseTextMemory`：最值得重点掌握的接口**

绝大多数日常 Agent Memory 最终都和文本记忆有关，所以最值得研究的是：

```text
src/memos/memories/textual/base.py
```

`BaseTextMemory` 当前定义了完整的文本 Memory 操作契约，包括：

```text
extract(messages)
add(memories)
update(memory_id, new_memory)
search(query, top_k)
get(memory_id)
get_by_ids(memory_ids)
get_all()
delete(memory_ids)
delete_all()
drop()
load()
dump()
```

其中 `extract()` 把 Message 转换成 `TextualMemoryItem`，`add()` 负责保存，`search()` 根据 Query 返回 Top-K Memory，其余方法构成 CRUD 和持久化能力。
因此，从架构角度可以把 Text Memory 看成：

```text
Message
  ↓ extract
Memory Item
  ↓ add
Storage

Query
  ↓ search
Memory Item
```

这也是为什么以后真正拆写入和检索源码时，最终都会落到某个 `BaseTextMemory` 实现。

## 四种 Memory Slot：text / pref / act / para

`text_mem` 是最接近传统长期 Memory / RAG 的部分，但它并不等于“一个向量数据库”。
例如：

```text
GeneralTextMemory
│
├── Extractor LLM
├── Embedder
└── Vector DB
```

它本身是一个领域对象，负责组织：

```text
抽取
写入
Embedding
搜索
更新
删除
```

而 Vector DB 只是它内部使用的基础设施。
所以：

```text
text_mem ≠ Qdrant

text_mem
 ↓ uses
Embedder + Qdrant
```

同理，`TreeTextMemory` 可以额外组合 Graph DB、Reranker 等组件。项目当前明确把 textual/tree/preference/skill/KV/LoRA 等视作不同 Memory implementation，而向量库和图数据库则放在 Provider 层。

**`pref_mem` 为什么单独一个 Slot**

偏好虽然最终也是文本形式，但它和普通事实 Memory 的更新逻辑不同。例如：

```text
普通事实：
Alice 在上海工作

偏好：
Alice 喜欢简短回答
```

普通事实检索的主要目标是“查询时找到相关知识”，而 Preference 往往需要持续合并、覆盖、增强：

```text
旧：
喜欢美式

新：
最近更喜欢拿铁

↓
偏好更新 / 冲突处理
```

所以 MemOS 给 Preference 一个独立的 `pref_mem` Slot。值得注意的是，在类型层面 `pref_mem` 仍被声明成 `BaseTextMemory`，说明它依旧遵守 Text Memory 的抽取、CRUD 和检索接口，只是实现和业务策略不同。`GeneralMemCube` 的 property setter 也明确要求 `pref_mem` 必须是 `BaseTextMemory`。
因此：

```text
pref_mem
属于 Text Memory 家族
但具有自己的业务语义和处理策略
```

**`act_mem`：存的不是“知识”，而是模型计算状态**

`act_mem` 对应 Activation Memory，当前 Cube 配置允许 `kv_cache` 和 `vllm_kv_cache`。
它和 Text Memory 最大区别是：

```text
text_mem:
"用户喜欢冰美式"

act_mem:
Transformer 推理过程中产生的 KV Cache
```

前者是“模型应该知道什么”，后者是“模型以前已经算过什么”。
因此：

```text
Text Memory
→ 减少信息遗忘

Activation Memory
→ 减少重复计算
```

它们都是“Memory”，但存储的数据类型、使用方式和生命周期完全不同。这也是 MemOS 把“Memory”概念做得比普通 RAG 更宽的地方。

**`para_mem`：把经验沉淀进模型参数**

`para_mem` 当前主要对应 `lora` backend。
它表达的是另一种记忆思路：

```text
text_mem
→ 需要搜索出来
→ 放进 Prompt
→ 模型读取

para_mem
→ 已经写入 Adapter / 参数
→ 模型自身行为发生变化
```

比如某些长期稳定的任务经验，不一定每次都以文本形式检索：

```text
“遇到这种任务应该按照 A→B→C 处理”
```

理论上可以通过训练形成 LoRA 参数化记忆。所以：

```text
Textual Memory    = 外部记忆
Activation Memory = 运行时记忆
Parametric Memory = 模型内部参数记忆
```

这是理解 MemOS “Memory Operating System”设计思想的关键。

## Cube 是逻辑容器，不是物理存储

现在就能更准确理解：

```text
AliceCube
├── text_mem
│      ↓
│   Qdrant
│
├── pref_mem
│      ↓
│   Preference Storage
│
├── act_mem
│      ↓
│   KV Cache
│
└── para_mem
       ↓
    LoRA Files
```

这些数据甚至可能分散在不同的进程、数据库、文件系统和模型 Runtime 中，但在逻辑上都属于：

```text
AliceCube
```

所以 Cube 最大的价值是：

> **把逻辑上属于同一个用户、Agent、项目或知识空间的不同 Memory 能力聚合成一个统一管理单位。**
> 这也是为什么多 Cube 系统可以表示：

```text
MOS
├── Alice_Private_Cube
├── Bob_Private_Cube
├── Project_A_Cube
└── Company_Public_Cube
```

而不是简单把所有 Memory 塞进一个全局数据库。

**Property：为什么不直接访问 `_text_mem`**

`GeneralMemCube` 内部实际保存：

```text
_text_mem
_act_mem
_para_mem
_pref_mem
```

外部通常通过：

```text
cube.text_mem
cube.act_mem
cube.para_mem
cube.pref_mem
```

访问。
Property setter 会检查对象类型，例如给 `text_mem` 塞一个不是 `BaseTextMemory` 的对象会抛 `TypeError`；如果某种 Memory 没有初始化，getter 会记录 warning 并返回 `None`。
这意味着 Cube 对内部组件做了一层最基本的类型保护：

```text
GeneralMemCube
不允许：

text_mem = QdrantClient()

而要求：

text_mem = BaseTextMemory 的实现
```

QdrantClient 应该由 `GeneralTextMemory` 自己管理，而不是直接塞进 Cube。

## 持久化、恢复与远程加载

`GeneralMemCube.dump(dir)` 并不是简单把一张表导出。当前实现首先要求目标目录为空，然后始终把 `GeneralMemCubeConfig` 保存成配置文件，再根据 `memory_types` 分别调用：

```text
text_mem.dump()
act_mem.dump()
para_mem.dump()
pref_mem.dump()
```

如果没有指定 `memory_types`，默认处理四种 Memory Slot。
因此：

```text
GeneralMemCube
        ↓ dump

cube_directory/
├── config.json
├── text memory data
├── preference data
├── activation data
└── parametric data
```

具体文件形式由各 Memory backend 自己决定。
所以 `dump()` 的设计重点是：

> **Cube 负责统一协调保存，各 Memory 负责保存自己的内部数据。**
> 这仍然体现了：

```text
Container 管组合
Component 管自己的实现
```

**`load()`：恢复的不是一条 Memory，而是一整套 Memory Space**

`load(dir)` 与 `dump()` 相反。当前代码会先读取目录里的配置 schema，并检查是否与当前 Cube 的 schema 匹配；之后再根据指定的 `memory_types` 分别调用各 Memory 的 `load()`。默认情况下会尝试加载 text、activation、parametric、preference 四类。
因此：

```text
目录
 ↓
config
 ↓
GeneralMemCube
 ↓
text_mem.load
pref_mem.load
act_mem.load
para_mem.load
```

这说明 MemCube 可以作为一个相对独立的记忆资产进行：

```text
保存
恢复
迁移
复用
```

而不是只能依附在某一个 MOS Runtime 中。

**`init_from_dir()`：从保存目录直接恢复 Cube**

当前 `GeneralMemCube.init_from_dir()` 会：

```text
读取 dir/config.json
        ↓
GeneralMemCubeConfig.from_json_file()
        ↓
可选与 default_config 合并
        ↓
GeneralMemCube(config)
        ↓
创建各 Memory Runtime Object
        ↓
mem_cube.load(dir)
        ↓
返回完整 Cube
```

这里一定要注意：

```text
__init__()
→ 根据配置创建 Memory 对象

load()
→ 给这些对象恢复已经保存的数据
```

不是同一件事。
所以：

```text
创建对象
≠
加载数据
```

**`init_from_remote_repo()`：为什么 Cube 可以从远程加载**

当前 `GeneralMemCube` 还提供 `init_from_remote_repo()`：先通过 `download_repo()` 下载远程 Cube，默认基础地址指向 Hugging Face datasets，然后继续复用 `init_from_dir()` 完成创建和加载。
调用链实际上是：

```text
Remote Repo
 ↓
download_repo()
 ↓
Local Directory
 ↓
init_from_dir()
 ↓
GeneralMemCube
```

这说明项目想把 Cube 做成：

> **可以独立发布、下载、迁移和复用的一套 Memory Asset。**
> 它的思路有点像：

```text
Model
→ 可以保存、下载、加载

MemCube
→ 也希望可以保存、下载、加载
```

## 完整创建案例与设计模式

假设配置：

```text
AliceCube

text_mem:
backend = general_text

pref_mem:
backend = pref_text

act_mem:
backend = uninitialized

para_mem:
backend = uninitialized
```

创建：

```python
cube = GeneralMemCube(config)
```

内部发生：

```text
GeneralMemCubeConfig
        ↓
GeneralMemCube.__init__()
        ↓
text_mem.backend = general_text
        ↓
MemoryFactory
        ↓
GeneralTextMemory

pref_mem.backend = pref_text
        ↓
MemoryFactory
        ↓
PreferenceTextMemory

act_mem = uninitialized
        ↓
None

para_mem = uninitialized
        ↓
None
```

最后 Runtime Object：

```text
AliceCube
├── _text_mem = GeneralTextMemory(...)
├── _pref_mem = PreferenceTextMemory(...)
├── _act_mem  = None
└── _para_mem = None
```

然后：

```python
mos.register_mem_cube(cube)
```

MOS 才正式开始管理这个 Cube。
以后：

```text
MOS.add()
 ↓
选择 AliceCube
 ↓
AliceCube.text_mem.add(...)
```

或者：

```text
MOS.search()
 ↓
选择 AliceCube
 ↓
AliceCube.text_mem.search(...)
```

所以 MemCube 是 **MOS 和具体 Memory 之间非常关键的一层边界。**

**这一层最重要的设计模式**

理解这一章其实主要是理解三个设计思想。

```text
第一：组合模式

GeneralMemCube
├── Text Memory
├── Preference Memory
├── Activation Memory
└── Parametric Memory
```

Cube 自己不是每种 Memory，而是组合它们。

```text
第二：工厂模式

Config
 ↓
MemoryFactory
 ↓
Concrete Memory
```

高层代码不依赖具体实现。

```text
第三：依赖倒置

MOS
 ↓
MemCube / BaseMemory
 ↓
具体实现
```

高层编排逻辑尽可能依赖抽象，而不是直接依赖 Qdrant、Neo4j、OpenAI 等 Provider。

**源码中一个值得注意的小细节**

当前 `GeneralMemCube` 的类注释仍写着：

```text
"box for loading and dumping three types of memories"
```

但实际源码已经明确包含：

```text
text_mem
act_mem
para_mem
pref_mem
```

四个 Slot，而且 `load()` / `dump()` 默认也处理四种类型。
这说明项目演进过程中，部分 docstring 没有完全同步最新结构。因此读 MemOS 这类快速迭代项目时，优先级最好是：

```text
Runtime Code
>
类型定义
>
文档 / 注释
```

不能只根据 docstring 判断当前真实行为。

## 本章结论

把整章压缩成一张图：

```text
                MOS
                 ↓
          GeneralMemCube
                 │
      ┌──────────┼──────────┐
      ↓          ↓          ↓
   text_mem    pref_mem   act_mem    para_mem
      │          │          │          │
BaseTextMemory   │     BaseActMemory BaseParaMemory
      │          │          │          │
      ↓          ↓          ↓          ↓
 GeneralText   Preference  KV Cache    LoRA
 TreeText
      │
      ↓
LLM / Embedder / VecDB / GraphDB
```

最核心的关系是：

```text
GeneralMemCubeConfig
        ↓
MemoryFactory
        ↓
GeneralMemCube
        ↓ contains
Memory Runtime Object
        ↓ uses
Provider / Storage
```

因此：**MemCube 负责“这一组记忆包含什么”，Memory 负责“这种记忆怎么工作”，Provider 负责“具体技术怎么实现”。**
下一章就应该正式进入最核心的一条链：**《文本 Memory 的实现：GeneralTextMemory 如何完成 extract → add → embedding → Vector DB → search》**。这一章会第一次真正从用户的一句话一路追到数据库，再从 Query 追回来。
