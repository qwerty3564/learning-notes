# 第一章：`Memory.add` —— mem0 记忆写入的总入口

## 一、这段代码在系统里的位置

在 **mem0** 项目中，核心控制器是 `Memory` 类，它对外暴露了记忆管理的基础接口：`add`（写入）、`search`（搜索）、`get_all`（查看全部）、`update`（手动更新）、`delete`（删除）以及 `chat`（带记忆对话）。

其中，**`add` 是整个系统写入记忆的唯一入口**。

无论是普通的一句话、一段长对话历史，还是一张带图的多模态消息，只要想沉淀为 Agent 的长期记忆，都必须经过 `add` 这道总闸门。它的核心职责就是：**“快速安检、绑定身份作用域、格式归一化、类型路由分流，然后交由底层存储流水线进行提炼与入库。”**

```python
def add(
    self,
    messages,
    *,
    user_id=None, agent_id=None, run_id=None,
    metadata=None, timestamp=None, expiration_date=None,
    infer=True, memory_type=None, prompt=None,
):
```

> 💡 **代码防呆设计**：  
> 在方法签名中，`messages` 是唯一的必填位置参数；后面的 `*` 强制规定其余所有参数**必须使用关键字形式传递**（如必须写 `user_id="user_123"`，不可按位置盲传），从语法层面避免了多参数调用时的错位风险。

---

## 二、参数逐个拆解

| 参数名 | 默认值 | 作用与大白话解释 | 代码里的具体去向 |
| :--- | :---: | :--- | :--- |
| **`messages`** | **必填** | 待处理的对话内容，支持纯字符串、单条字典或消息列表 | 归一化为标准的 `list[dict]` 格式进入主流水线 |
| **`user_id` / `agent_id` / `run_id`** | `None` | **记忆归属作用域（三选一）**：标记这条记忆属于哪个用户、哪个 Agent 或单次运行 | 由 `_build_filters_and_metadata` 写入元数据与向量库过滤条件，终生绑定 |
| **`metadata`** | `None` | 附加的自定义元数据（如业务标签、分类等） | 与身份作用域合并后存入底层数据库 |
| **`timestamp`** | `None` | 商业平台版专用的“时间感知”能力 | **开源版不支持**。只要传入非空值，立刻抛出 `ValueError` |
| **`expiration_date`** | `None` | 记忆的过期日期（`YYYY-MM-DD` 格式） | `_normalize_expiration_date` 规范化后写入元数据，过期记忆检索时自动隐藏 |
| **`infer`** | `True` | **是否调用大模型提炼事实**（核心开关） | 传给 `_add_to_vector_store`：`True` 表示用 LLM 提炼关键事实；`False` 表示原始文本直接向量化入库 |
| **`memory_type`** | `None` | 记忆类型 | 开源版仅支持 `procedural_memory`（技能/规则记忆），传其他值直接报错 |
| **`prompt`** | `None` | 自定义提炼提示词 | 透传给程序性记忆提取或事实提炼路径，用于定制提取逻辑 |

---

## 三、执行流程逐段拆解

整个 `add` 方法的执行流程如同一条严密的安检与分流通道：

```text
[外部输入 messages]
   │
   ├─► 3.1 平台能力守卫 (Fail-Fast 检查开源版不支持的 timestamp)
   ├─► 3.2 作用域与元数据固化 (将 user_id 等信息锁定在 metadata 中)
   ├─► 3.3 记忆类型校验 (非法类型抛出结构化错误)
   ├─► 3.4 格式归一化 (无论传入 str/dict/list，统一转为 list[dict])
   │
   ├───► 3.5 分叉一：程序性记忆 ──► [调用 _create_procedural_memory] ──► 提前返回
   │
   └───► 3.6 分叉二：通用记忆 (主线) ──► [视觉图文解析] ──► [_add_to_vector_store 提炼入库] ──► 组装返回
```

---

### 3.1 平台能力守卫（快速失败 Fail-Fast）

```python
if timestamp is not None:
    raise ValueError(get_temporal_feature_error_message("sync", "add", "timestamp"))
```

* **为什么这么写？**  
  `timestamp` 是商业云平台版的高级时序图谱功能，开源版暂不提供。
* **设计原则**：代码没有选择“静默忽略”，而是在入口第一行**直接主动报错**。这种 Fail-Fast（快速失败）设计让开发者能立刻意识到功能边界，避免数据悄无声息地丢失时间属性。

---

### 3.2 过期时间与元数据预处理：固化记忆的“身份证”

```python
normalized_expiration_date = _normalize_expiration_date(expiration_date)
temporal_usage_notice = detect_temporal_usage_from_metadata(metadata)

processed_metadata, effective_filters = _build_filters_and_metadata(
    user_id=user_id,
    agent_id=agent_id,
    run_id=run_id,
    input_metadata=metadata,
)
if normalized_expiration_date is not None:
    processed_metadata["expiration_date"] = normalized_expiration_date
```

这里完成了三项关键准备：
1. **日期格式规范化**：`_normalize_expiration_date` 校验日期格式是否合法；
2. **多租户身份锁定（核心）**：`_build_filters_and_metadata` 提取 `user_id / agent_id / run_id`，生成两份核心数据：
   * `processed_metadata`：随记忆一同落库的元数据字典；
   * `effective_filters`：以后从向量库检索时的硬过滤条件（如 `{"user_id": "alex"}`）。
3. **安全意义**：**“这条记忆属于谁”从进门的第一刻就被锁定**，后续所有异步或分批操作都严格带着这个身份，从物理根源上杜绝了多租户数据串扰。

---

### 3.3 记忆类型校验：结构化的“说明书式错误”

```python
if memory_type is not None and memory_type != MemoryType.PROCEDURAL.value:
    raise Mem0ValidationError(
        message=f"Invalid 'memory_type'. Please pass {MemoryType.PROCEDURAL.value} to create procedural memories.",
        error_code="VALIDATION_002",
        details={"provided_type": memory_type, "valid_type": MemoryType.PROCEDURAL.value},
        suggestion=f"Use '{MemoryType.PROCEDURAL.value}' to create procedural memories."
    )
```

* 目前系统只显式支持 `procedural_memory`（程序性记忆）。
* **设计亮点**：抛出的 `Mem0ValidationError` 包含 `error_code`、`details` 与明确的 `suggestion`。这种**“错误即文档”**的设计，使调用方捕获异常后能立刻得知修复方式。

---

### 3.4 输入格式归一化：“宽进严出”的多态兼容

外部调用者的输入习惯各异，有的传单句文本，有的传完整会话字典。`add` 在入口统一做了抹平：

```python
if isinstance(messages, str):
    # 单句字符串 -> 包装为单条 user 消息
    messages = [{"role": "user", "content": messages}]

elif isinstance(messages, dict):
    # 单个字典 -> 包装为单元素列表
    messages = [messages]

elif not isinstance(messages, list):
    # 非法类型 -> 拦截报错
    raise Mem0ValidationError(
        message="messages must be str, dict, or list[dict]",
        error_code="VALIDATION_003",
        details={"provided_type": type(messages).__name__, "valid_types": ["str", "dict", "list[dict]"]},
        suggestion="Convert your input to a string, dictionary, or list of dictionaries."
    )
```

无论调用方传入字符串、单条字典还是多条对话列表，进入下游流水线的数据都被规范化为标准的 `[{"role": "...", "content": "..."}]` 结构。

---

### 3.5 分叉一：程序性记忆（Agent 技能与规则）

```python
if agent_id is not None and memory_type == MemoryType.PROCEDURAL.value:
    results = self._create_procedural_memory(messages, metadata=processed_metadata, prompt=prompt)
    
    # 状态提示与返回
    scale_threshold_notice = detect_scale_threshold_from_add_result(self, results)
    if temporal_usage_notice:
        display_temporal_usage_notice(self, "sync", "add", *temporal_usage_notice)
    elif scale_threshold_notice:
        display_scale_threshold_notice(self, "sync", "add", *scale_threshold_notice)
    else:
        display_first_run_notice(self, "sync", "add")
    return results
```

* **什么是程序性记忆？**  
  事实记忆存的是“客观事实”（如 *用户喜欢喝拿铁*）；程序性记忆存的是 **Agent 的工作技能与行为准则**（如 *当用户要求重构代码时，必须先给出单元测试*）。
* **独立路径**：如果声明了该类型并传入了 `agent_id`，系统走专用的 `_create_procedural_memory` 提取技能并直接 `return`，不再走通用记忆管道。

---

### 3.6 分叉二：通用记忆主线（事实提炼与向量入库）

大部分日常记忆都会进入这条主线：

```python
# 1. 多模态视觉图文解析（若配置开启）
if self.config.llm.config.get("enable_vision"):
    messages = parse_vision_messages(messages, self.llm, self.config.llm.config.get("vision_details"))
else:
    messages = parse_vision_messages(messages)

# 2. 核心：进入底层向量存储与知识提取流水线
vector_store_result = self._add_to_vector_store(
    messages, processed_metadata, effective_filters, infer, prompt=prompt
)
```

1. **多模态图文解析**：若输入包含图片，视觉大模型先将图片解析为文本描述，确保多模态信息不丢失；
2. **交棒核心车间 `_add_to_vector_store`**：
   * **当 `infer=True`（默认）**：调用 LLM 从对话中**智能提炼出核心事实列表**（`extracted_memories`），经过 MD5 查重后，将全新事实作为新记忆（`event: "ADD"`）批量写入向量库；
   * **当 `infer=False`**：跳过 LLM 理解，直接将传入的原始文本进行向量化并存入；
   * **演化机制解耦**：新版架构不再让大模型在文本层做复杂的 `UPDATE/DELETE` 对比，而是保持事实文本的高效增量沉淀，将知识的关联与演化交由底层的**实体知识图谱层（`entity_store.update`）**处理。

---

### 3.7 结果组装与统一返回

```python
scale_threshold_notice = detect_scale_threshold_from_add_result(self, vector_store_result)
if temporal_usage_notice:
    display_temporal_usage_notice(self, "sync", "add", *temporal_usage_notice)
elif scale_threshold_notice:
    display_scale_threshold_notice(self, "sync", "add", *scale_threshold_notice)
else:
    display_first_run_notice(self, "sync", "add")

return {"results": vector_store_result}
```

* **非阻塞提示**：在控制台按需输出引导信息或用量告警；
* **结构化交付**：最终返回统一的字典包装 `{"results": [...]}`。
  * 返回示例：
    ```python
    {
        "results": [
            {"id": "c1f7...-4f1b", "memory": "用户下个月打算去东京旅游", "event": "ADD"},
            {"id": "9a2e...-8c3d", "memory": "用户喜欢吃日式拉面", "event": "ADD"}
        ]
    }
    ```

---

## 四、设计要点总结

1. **单一入口，双轨路由**：对外暴露极简的 `add()`，对内自动路由“通用事实记忆”与“Agent 技能记忆”，上层调用心智负担极低。
2. **校验全部前置（Fail-Fast）**：不支持的特性、非法的类型以及畸形的数据格式在入口处立即拦截，防止脏数据渗透至下游。
3. **作用域从入口固化**：多租户身份信息（`user_id` 等）在一进入方法就被封装进不可变的 `filters`，从机制上保障了租户安全隔离。
4. **格式宽进严出**：对外界输入保持高度多态兼容（`str`、`dict`、`list` 全支持），在内部统一收敛为严格的格式标准。
5. **轻量事实沉淀与关系演化解耦**：`infer=True` 专注高效提炼新事实，记忆主体以 Append-only + MD5 查重快速入库，复杂关系的更新沉淀由实体图谱层承载，兼顾了吞吐性能与系统稳定性。

---

## 五、本章小结

`Memory.add` 作为 mem0 写入侧的总入口，它的核心使命是把“杂乱的原始对话”转化为“规范干净的标准输入”，并安全分发给后续流水线。

> **下一章预告**：  
> 当数据跨过 `add` 的大门，进入真正的核心生产流水线 `_add_to_vector_store` 时：  
> *大模型是如何把长对话拆解为事实的？MD5 哈希如何实现 0 毫秒去重？BM25 词形还原是如何配合向量做混合检索的？实体又如何在知识图谱中完成双轨对齐？*  
> 我们在第二章深入源码细节！