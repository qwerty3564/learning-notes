# 第二章：`_add_to_vector_store` —— V3 批处理记忆流水线全流程拆解

## 一、这段代码在系统里的位置

第一章里我们把 `Memory.add()` 比作"前台接待+安检"。它把权限校验、输入格式抹平、多租户作用域这些杂事处理完之后，真正干活的是后台这条流水线 —— **`_add_to_vector_store`**。

`add()` 只是定规矩，`_add_to_vector_store` 才是 mem0 里最核心、逻辑最重的一段代码：一条记忆从原始对话变成结构化知识，整个生命周期都在这里完成。

* `infer=False` 时：走**"极速直通车"**，不烧任何 LLM Token，原文直接入库；
* `infer=True` 时：启动 **"V3 批处理流水线"**（V3 Phased Batch Pipeline），从拉取上下文、大模型提炼事实、MD5 零成本查重、BM25 词形优化，一直做到跨对话的实体知识图谱对齐。

---

## 二、先看结果：一次对话最终在数据库里留下什么

在整个 mem0 记忆写入流水线中，最终总共有 **4 样东西** 被写入数据库，分别存放在 **2 种不同的数据库**（向量数据库 + 关系型数据库）里，各司其职。

| 写入内容 | 存储在什么数据库？ | 库中的具体位置/表名 | 核心作用 |
| :--- | :--- | :--- | :--- |
| **1. 提炼后的主记忆** | **向量数据库** (Qdrant / PgVector / Chroma) | 主记忆集合 (`memories` Collection) | 负责语义模糊搜索与事实召回 |
| **2. 记忆变更历史** | **关系型数据库** (SQLite / PostgreSQL / MySQL) | 审计历史表 (`history` Table) | 负责时间线追踪、版本回滚与审计 |
| **3. 知识图谱实体** | **向量数据库** (或图数据库 Neo4j) | 实体集合 (`entities` Collection) | 负责实体去重、同义词对齐与记忆连线 |
| **4. 原始对话流水** | **关系型数据库** (SQLite / PostgreSQL) | 消息表 (`messages` Table) | 负责聊天记录完整回放与会话上下文还原 |

### 1. 提炼后的主记忆（Memory Records）

- **存储介质**：**向量数据库（Vector Store）**
- **写入形态**：以"高维向量 + 元数据 Payload"的形式存储。
- **具体落库的数据样子**：

```json
{
  "id": "c1f7a8b9-4f1b-4231-9876-89abcdef0123",
  "vector": [0.0213, -0.0451, 0.0892, 0.1124, "... (共 1536 维浮点数)"],
  "payload": {
    "data": "用户喜欢吃日式兰州拉面",
    "text_lemmatized": "user like eat japanese lanzhou ramen",
    "hash": "8f14e45fceea167a5a36dedd4bea2543",
    "user_id": "user_alex",
    "created_at": "2026-08-14T17:48:00+00:00",
    "updated_at": "2026-08-14T17:48:00+00:00",
    "attributed_to": "user",
    "category": "preferences"
  }
}
```

### 2. 记忆变更审计日志（History Audit Records）

- **存储介质**：**关系型数据库（Relational DB，如 SQLite / Postgres）**
- **写入形态**：标准的 SQL 关系表行记录（`history` 表）。
- **具体落库的数据样子**：

| id | memory_id (外键) | old_memory | new_memory | event | is_deleted | created_at |
| :---: | :--- | :--- | :--- | :---: | :---: | :--- |
| `101` | `c1f7a8b9-...` | `NULL` | `"用户喜欢吃日式兰州拉面"` | `ADD` | `0` | `2026-08-14 17:48:00` |
| `102` | `c1f7a8b9-...` | `"用户喜欢吃日式兰州拉面"` | `"用户不吃面食，改吃沙拉"` | `UPDATE` | `0` | `2026-08-15 09:30:00` |

### 3. 知识图谱实体与关联边（Entity Nodes & Links）

- **存储介质**：**向量数据库的实体集合（`entity_store`）**
- **写入形态**：每个实体是一个节点，里面的 `linked_memory_ids` 是连接到具体记忆的"边"。
- **具体落库的数据样子**：

```json
{
  "id": "ent_uuid_7777-8888",
  "vector": [0.0812, 0.1543, -0.0331, "... (实体的向量特征)"],
  "payload": {
    "data": "兰州拉面",
    "entity_type": "FOOD",
    "user_id": "user_alex",
    "linked_memory_ids": [
      "c1f7a8b9-4f1b-4231-9876-89abcdef0123",  // 关联到了上面的那条记忆！
      "d9a2e3f4-5555-6666-7777-888899990000"   // 关联到了以前的另一条记忆
    ]
  }
}
```

> **说明**：如果新对话提到了老实体，不会插入新行，而是把老实体的 `linked_memory_ids` 从 `["id1"]` 更新为 `["id1", "id2"]`。

### 4. 原始对话历史流水（Raw Conversation Messages）

- **存储介质**：**关系型数据库（Relational DB）**
- **写入形态**：标准的 SQL 消息流水表（`messages` 表）。
- **具体落库的数据样子**：

| id | session_id | role | content | created_at |
| :---: | :--- | :---: | :--- | :--- |
| `1` | `sess_001` | `user` | `"我今天好累，晚上打算去吃最爱吃的日式兰州拉面。"` | `2026-08-14 17:47:50` |
| `2` | `sess_001` | `assistant` | `"听起来很美味！好好享受晚餐，放松一下。"` | `2026-08-14 17:47:55` |

### 为什么数据要这样兵分两路？

```text
               ┌──► 向量数据库 (Vector DB) ──► 存【记忆语义向量】+【实体知识图谱】 (管模糊搜索)
一次对话输入 ──┤
               └──► 关系型数据库 (SQL DB)   ──► 存【审计变更日志】+【原始聊天记录】 (管精确事务)
```

1. **向量数据库**：只负责高维数学计算（余弦相似度），通过 `vector` 快速检索"用户爱吃什么"、"提到了什么实体"。
2. **关系数据库**：发挥 ACID 事务优势，确保每条记忆被创建的时间、被修改的历史、以及未经篡改的对话原文能安全、顺序、精确地沉淀下来。

---

## 三、双轨架构概览：两条截然不同的写入路径

```text
_add_to_vector_store(messages, metadata, filters, infer, prompt)
   │
   ├──► [路径 A: infer=False] 极速直通车
   │      └── 过滤非法/系统消息 ──► 单句逐条 Embedding ──► 直接入库 ──► 返回
   │
   └──► [路径 B: infer=True] V3 批处理流水线 (Phase 0 ~ Phase 8)
          ├─ Phase 0: 上下文准备 (拉取最近 10 条历史会话)
          ├─ Phase 1: 关联记忆召回与「抗幻觉编号映射」
          ├─ Phase 2: 单次 LLM 结构化事实提取与健壮解析
          ├─ Phase 3: 提取文本批量向量化 (Batch Embedding)
          ├─ Phase 4 & 5: MD5 极速双重查重 + BM25 词形预处理
          ├─ Phase 6: 向量与历史审计双库批量持久化 (Vector + SQL)
          ├─ Phase 7: 知识图谱实体抽取、批量向量化与双轨对齐
          └─ Phase 8: 原始对话归档、脱敏遥测与标准结果交付
```

---

## 四、路径 A：`infer=False` —— 极速直通车

如果你手上的数据已经清洗好了，或者就是想存原文，那传 `infer=False` 就行。

```python
if not infer:
    returned_memories = []
    for message_dict in messages:
        # 1. 严格的防御性格式校验
        if (
            not isinstance(message_dict, dict)
            or message_dict.get("role") is None
            or message_dict.get("content") is None
        ):
            logger.warning(f"Skipping invalid message format: {message_dict}")
            continue

        # 2. 忽略系统指令（System Prompt 不作为记忆存储）
        if message_dict["role"] == "system":
            continue

        # 3. 组装单条元数据（记录说话人角色和名字）
        per_msg_meta = deepcopy(metadata)
        per_msg_meta["role"] = message_dict["role"]
        actor_name = message_dict.get("name")
        if actor_name:
            per_msg_meta["actor_id"] = actor_name

        # 4. 向量化并创建记忆
        msg_content = message_dict["content"]
        msg_embeddings = self.embedding_model.embed(msg_content, "add")
        mem_id = self._create_memory(msg_content, {msg_content: msg_embeddings}, per_msg_meta)

        returned_memories.append(
            {
                "id": mem_id,
                "memory": msg_content,
                "event": "ADD",
                "actor_id": actor_name if actor_name else None,
                "role": message_dict["role"],
            }
        )
    return returned_memories
```

几个值得注意的点：

1. **`system` 消息直接跳过**：系统提示词（比如 *"You are a helpful assistant"*）是运行时指令，不是需要长期记住的用户事实，存了也是噪音。
2. **记下 `actor_id`**：如果消息里带了 `name`（群聊里具体是谁说的），会写进元数据，之后想追溯发言人就有据可查。
3. **零 Token 消耗**：全程不碰大模型，只调一次 Embedding 算向量入库，速度在几十毫秒级别。

---

## 五、路径 B：`infer=True` —— V3 批处理流水线逐阶段拆解

`infer=True` 时，代码进入真正的重头戏：一条 9 个 Phase 的批处理流水线。先把整条流程串起来看一遍：在开启智能提炼模式（`infer=True`）时，系统首先拉取最近 10 条历史对话并从向量库召回相似的旧记忆（同时将长 UUID 临时转为数字简码以防大模型产生幻觉）；接着调用大模型将本次对话提炼为结构化的核心事实，并批量计算它们的特征向量；随后利用 MD5 哈希在 0 毫秒内剔除完全重复的陈旧事实，并执行 BM25 词形还原以优化后续的混合检索；紧接着将新记忆批量写入向量数据库，并在关系型数据库中同步记录一笔带时间戳的 ADD 审计日志；之后利用本地模型抽取人名、地名等实体，通过"字面比对 + 向量相似度"进行双轨认亲对齐（老实体仅追加关联记忆 ID，新实体批量建节点入库以编织知识图谱）；最后将未经修改的原始对话流水归档存入关系库，完成隐私脱敏打点，并将清洗包装好的记忆结果交付给调用方。

---

### Phase 0 & 1：先看上下文，再把 UUID 换成好认的编号

让大模型提炼记忆，不能让它"断章取义"——它得知道最近聊了什么、库里已经存了什么，否则提炼出来的东西很容易跑偏。

```python
# Phase 0: 上下文收集
session_scope = _build_session_scope(filters)
last_messages = self.db.get_last_messages(session_scope, limit=10) # 拉取最近 10 条历史消息
parsed_messages = parse_messages(messages)

# Phase 1: 检索已有的相关记忆
search_filters = {k: v for k, v in filters.items() if k in ("user_id", "agent_id", "run_id") and v}
query_embedding = self.embedding_model.embed(parsed_messages, "search")
existing_results = self.vector_store.search(
    query=parsed_messages,
    vectors=query_embedding,
    top_k=10,
    filters=search_filters,
)

# 核心亮点：UUID 映射为整数编号（防大模型幻觉）
existing_memories = []
uuid_mapping = {}
for idx, mem in enumerate(existing_results):
    uuid_mapping[str(idx)] = mem.id
    existing_memories.append({"id": str(idx), "text": mem.payload.get("data", "")})
```

**为什么非要把 UUID 换成 `"0"`、`"1"`、`"2"`？**

数据库主键是 `c1f7a8b9-4f1b-4231-9876-89abcdef0123` 这种 36 位长 UUID。直接把它塞给大模型，模型在生成 JSON 时很容易抄错一位字符（Token 级幻觉），后面反查主键就全对不上了。所以送进去之前先换成 `0、1、2` 这种简单编号，本地用 `uuid_mapping` 记住对应关系——既稳，又省 Token。

---

### Phase 2：一次 LLM 调用搞定提取，外加两道 JSON 容错

```python
is_agent_scoped = bool(filters.get("agent_id")) and not filters.get("user_id")
system_prompt = ADDITIVE_EXTRACTION_PROMPT
if is_agent_scoped:
    system_prompt += AGENT_CONTEXT_SUFFIX

user_prompt = generate_additive_extraction_prompt(
    existing_memories=existing_memories,
    new_messages=parsed_messages,
    last_k_messages=last_messages,
    custom_instructions=prompt or self.custom_instructions,
)

try:
    response = self.llm.generate_response(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        response_format={"type": "json_object"}, # 强制约束 JSON 输出
    )
except Exception as e:
    logger.error(f"LLM extraction failed: {e}")
    return []

# 健壮的 JSON 解析逻辑（双重容错）
try:
    response = remove_code_blocks(response)
    if not response or not response.strip():
        extracted_memories = []
    else:
        try:
            extracted_memories = json.loads(response, strict=False).get("memory", [])
        except json.JSONDecodeError:
            extracted_json = extract_json(response) # 正则强行抠出 JSON 块
            extracted_memories = json.loads(extracted_json, strict=False).get("memory", [])
except Exception as e:
    logger.error(f"Error parsing extraction response: {e}")
    extracted_memories = []

# 如果大模型认为本次对话没有任何值得记录的事实
if not extracted_memories:
    self.db.save_messages(messages, session_scope) # 依然保存原始对话流水
    return []
```

要点：

1. **一次请求全办完**：新对话、历史上下文、库里已有的相似记忆，全打包进同一次 LLM 调用，省延迟也省开销。
2. **JSON 解析留了两道防线**：先正常 `json.loads`；万一模型输出带脏字符解析失败，再用 `extract_json` 正则把 `{ ... }` 硬抠出来重试一次，尽可能救回有效输出。

---

### Phase 3：批量算向量，不行就逐条兜底

```python
mem_texts = [m.get("text", "") for m in extracted_memories if m.get("text")]
try:
    # 优先：单次 Batch 请求计算全部向量
    mem_embeddings_list = self.embedding_model.embed_batch(mem_texts, "add")
    embed_map = dict(zip(mem_texts, mem_embeddings_list))
except Exception:
    # 降级：若批量接口不可用或超时，回退为单条循环计算
    embed_map = {}
    for text in mem_texts:
        try:
            embed_map[text] = self.embedding_model.embed(text, "add")
        except Exception as e:
            logger.warning(f"Failed to embed memory text: {e}")
```

这里的 `embed_map` 是个"文本 → 向量"的映射表。注意一个小细节：某条文本如果降级计算也失败了，它就不会出现在 `embed_map` 里，下一步会被安全跳过——**算不出向量的数据根本进不了库**，从源头挡住脏数据。

---

### Phase 4 & 5：MD5 双重查重 + BM25 词形优化

这段是整条流水线里性价比最高的优化。

```python
# 1. 提取库里已有的 MD5 哈希集合
existing_hashes = set()
for mem in existing_results:
    h = mem.payload.get("hash") if hasattr(mem, "payload") and mem.payload else None
    if h:
        existing_hashes.add(h)

records = []
seen_hashes = set() # 当前批次内的防重集合

for mem in extracted_memories:
    text = mem.get("text")
    if not text or text not in embed_map:
        continue

    # 2. 计算新事实的 MD5 指纹
    mem_hash = hashlib.md5(text.encode()).hexdigest()
    
    # 3. 双重防线拦截（库级重复 OR 当前批次内重复）
    if mem_hash in existing_hashes or mem_hash in seen_hashes:
        logger.debug(f"Skipping duplicate memory (hash match): {text[:50]}")
        continue
    seen_hashes.add(mem_hash)

    # 4. BM25 词形还原（例如将 "running" 还原为 "run"）
    text_lemmatized = lemmatize_for_bm25(text)

    # 5. 打包完整 Payload
    memory_id = str(uuid.uuid4())
    mem_metadata = deepcopy(metadata)
    mem_metadata["data"] = text
    mem_metadata["text_lemmatized"] = text_lemmatized
    mem_metadata["hash"] = mem_hash
    if "created_at" not in mem_metadata:
        mem_metadata["created_at"] = datetime.now(timezone.utc).isoformat()
    mem_metadata["updated_at"] = mem_metadata["created_at"]
    if mem.get("attributed_to"):
        mem_metadata["attributed_to"] = mem["attributed_to"]

    records.append((memory_id, text, embed_map[text], mem_metadata))

if not records:
    self.db.save_messages(messages, session_scope)
    return []
```

核心作用：

1. **双重 MD5 拦截**：库里的哈希集合挡一遍，当前批次内的 `seen_hashes` 再挡一遍，完全一模一样的旧事实在 0.001 毫秒内被过滤掉，不重复占存储、不重复建向量索引。
2. **`lemmatize_for_bm25`**：把文本做词形还原（`running` → `run`）。这样后面做混合检索（向量 + BM25）时，用户不管用过去时、单复数怎么搜，都能命中。

---

### Phase 6：双库批量写入，失败就逐条降级

数据备齐了，开始真正落盘：

```python
# 1. 批量写入向量数据库 (Vector Store)
all_vectors = [r[2] for r in records]
all_ids = [r[0] for r in records]
all_payloads = [r[3] for r in records]

try:
    self.vector_store.insert(vectors=all_vectors, ids=all_ids, payloads=all_payloads)
except Exception:
    # 批量失败降级：逐条重试，故障隔离
    for mid, vec, pay in zip(all_ids, all_vectors, all_payloads):
        try:
            self.vector_store.insert(vectors=[vec], ids=[mid], payloads=[pay])
        except Exception as e:
            logger.error(f"Failed to insert memory {mid}: {e}")

# 2. 批量写入关系型数据库审计表 (History Audit Log)
history_records = [
    {
        "memory_id": r[0],
        "old_memory": None,
        "new_memory": r[1],
        "event": "ADD",
        "created_at": r[3].get("created_at"),
        "is_deleted": 0,
    }
    for r in records
]
try:
    self.db.batch_add_history(history_records)
except Exception:
    for hr in history_records:
        try:
            self.db.add_history(hr["memory_id"], None, hr["new_memory"], "ADD", created_at=hr.get("created_at"))
        except Exception as e:
            logger.error(f"Failed to add history for {hr['memory_id']}: {e}")
```

**为什么是"批量优先 + 逐条降级"？**

正常情况各发 1 次请求就能写完，网络 I/O 效率最高；但如果第 3 条数据因为编码异常之类的问题挂了，整批操作会失败。降级成逐条插入后，第 1、2、4 条照样能落库——**绝不让整批健康数据给一条坏数据陪葬**。

---

### Phase 7：实体知识图谱，双轨对齐（7a ~ 7e）

除了整句记忆，系统还会把句子里的"人名、地名、机构名"抽出来，织成一张**实体知识图谱**。

#### 7a: 全局实体抽取 + 倒排去重
```python
all_texts = [r[1] for r in records]
all_entities = extract_entities_batch(all_texts) # spaCy 本地批量识别

global_entities = {} # normalized_key -> [entity_type, entity_text, {memory_ids}]
for idx, (memory_id, text, embedding, payload) in enumerate(records):
    entities = all_entities[idx] if idx < len(all_entities) else []
    for entity_type, entity_text in entities:
        key = self._normalize_entity_text(entity_text) # 转小写、去空格归一化
        if key in global_entities:
            global_entities[key][2].add(memory_id)      # 关联多个记忆 ID
        else:
            global_entities[key] = [entity_type, entity_text, {memory_id}]
```

先用 spaCy 在本地批量识别实体，再用归一化后的文本当 key 做倒排：同一个实体出现在多条记忆里，就把这些记忆 ID 都挂到它名下。

#### 7b: 实体批量向量化 + 防御性对齐（Padding / Truncating）
```python
if global_entities:
    ordered_keys = list(global_entities.keys())
    entity_texts = [global_entities[k][1] for k in ordered_keys]

    try:
        entity_embeddings = self.embedding_model.embed_batch(entity_texts, "add")
    except Exception:
        entity_embeddings = []
        for t in entity_texts:
            try:
                entity_embeddings.append(self.embedding_model.embed(t, "add"))
            except Exception:
                entity_embeddings.append(None)

    # 防御性对齐：如果第三方模型返回的数量不对等，用 None 补齐或截断，防止索引错位
    if len(entity_embeddings) != len(ordered_keys):
        logger.warning(...)
        entity_embeddings = list(entity_embeddings[: len(ordered_keys)])
        entity_embeddings += [None] * (len(ordered_keys) - len(entity_embeddings))
```

这里有个很实际的坑：第三方 embedding 模型偶尔会少返回几条向量。如果不处理，后面按索引 zip 就会错位——明明是"兰州拉面"的向量，可能被当成"纽约"的去建索引。所以先按数量补齐或截断（缺的补 `None`），再进下一步。

#### 7c & 7d: 双轨对齐：先字面，再语义
```python
valid = [(i, k) for i, k in enumerate(ordered_keys) if entity_embeddings[i] is not None]
if valid:
    valid_indices, valid_keys = zip(*valid)
    valid_vectors = [entity_embeddings[i] for i in valid_indices]
    
    # 轨道 1：内存字典字面匹配（0 毫秒、100% 确定性）
    exact_matches = self._existing_entities_by_text(search_filters)

    # 轨道 2：向量数据库 Top-1 相似度检索（智能识别同义词与缩写）
    valid_texts = [global_entities[k][1] for k in valid_keys]
    existing_matches = self.entity_store.search_batch(
        queries=valid_texts,
        vectors_list=valid_vectors,
        top_k=1,
        filters=search_filters,
    )

    to_insert_vectors, to_insert_ids, to_insert_payloads = [], [], []
    for j, key in enumerate(valid_keys):
        entity_type, entity_text, memory_ids = global_entities[key]
        matches = existing_matches[j] if j < len(existing_matches) else []
        exact_match = exact_matches.get(key)
        
        # 相似度达到 0.95 判定为同义实体
        semantic_match = matches[0] if matches and matches[0].score >= 0.95 else None
        match = exact_match or semantic_match

        if match:
            # 老实体：并集追加记忆关联 ID，仅更新 Payload 元数据（vector=None）
            payload = match.payload or {}
            linked = set(payload.get("linked_memory_ids", []))
            linked |= memory_ids
            payload["linked_memory_ids"] = sorted(linked)
            try:
                self.entity_store.update(vector_id=match.id, vector=None, payload=payload)
            except Exception as e:
                logger.debug(f"Entity update failed: {e}")
        else:
            # 全新实体：打包准备批量新建节点
            to_insert_vectors.append(valid_vectors[j])
            to_insert_ids.append(str(uuid.uuid4()))
            to_insert_payloads.append({
                "data": entity_text,
                "entity_type": entity_type,
                "linked_memory_ids": sorted(memory_ids),
                **search_filters,
            })

    # 7e: 批量插入所有新实体
    if to_insert_vectors:
        self.entity_store.insert(
            vectors=to_insert_vectors,
            ids=to_insert_ids,
            payloads=to_insert_payloads,
        )
```

判断"这个实体是不是已经存在"用了两条轨道：先查内存字典做字面匹配（快且准），再用向量相似度找同义实体（`"NYC"` 和 `"New York City"` 这种，相似度到 0.95 就认定是同一个）。命中老实体就只把新的记忆 ID 追加进 `linked_memory_ids`，没命中才新建节点——这也对应了上一章说的"实体不重复插，只更新连线"。

---

### Phase 8：原始消息归档、遥测与收尾

```python
# 1. 原始对话存入关系数据库（用于前端聊天历史回溯与会话还原）
self.db.save_messages(messages, session_scope)

# 2. 组装给调用者的标准数据
returned_memories = [
    {"id": r[0], "memory": r[1], "event": "ADD"}
    for r in records
]

# 3. 隐私脱敏与匿名遥测
keys, encoded_ids = process_telemetry_filters(filters)
capture_event(
    "mem0.add",
    self,
    {"version": self.api_version, "keys": keys, "encoded_ids": encoded_ids, "sync_type": "sync"},
)
return returned_memories
```

到这里一轮写入才真正结束：原始对话存进关系库（以后聊天记录回放、会话还原都靠它），提炼出的记忆以标准结构返回给调用方，再顺带发一条脱敏后的匿名遥测。

---

## 六、设计要点总结

1. **能批量就批量，不行就逐条兜底**：向量计算、检索、数据库插入全用 Batch 接口，每处又都备了单条循环重试——批量失败不至于全军覆没。
2. **实体消歧走"双轨"**：先内存字典做字面快速匹配，再用向量相似度（≥ 0.95）做语义聚类，把 `"NYC"` 和 `"New York City"` 这类同义实体打通。
3. **多库各管一摊**：
   * **向量库**：存记忆和实体的高维向量，管语义模糊召回；
   * **关系库**：存变更历史（`history`）和原始对话（`messages`），管事务与精确审计；
   * **图谱关联**：靠实体的 `linked_memory_ids` 把记忆节点连成拓扑。

---

## 七、本章小结

拆完 `_add_to_vector_store` 你会发现：写一条记忆远不是一句 `insert` 那么简单。背后是一整套流水线——上下文组装、防幻觉映射、语义提取、双重查重、双库持久化、图谱关联，每一步都有讲究。

> **下一章预告**：  
> 数据入库之后，Agent 收到用户新问题时，又是怎么把这些记忆快速、精准地捞出来的？  
> 下一章我们拆《第三章：`Memory.search` —— 向量语义检索与实体图记忆的多路召回机制》。
