# 第一章：MemOS 的使用方式与系统入口

**先理解"MemOS 怎么被使用"**

MemOS 是给 LLM/Agent 提供长期记忆能力的基础设施。对上层应用来说，核心能力抽象成三个操作：

- `add`：把新信息写入长期记忆；
- `search`：根据问题检索相关记忆；
- `chat`：检索记忆 + 调用 LLM 完成带记忆的回答。

从源码调用入口看，有四种使用方式，底层处理的都是同一件事——记忆的写入、检索、管理和使用，区别只在于 MemOS 与应用的运行位置，以及通信方式（函数调用 / HTTP / MCP 协议）：

```text
Python SDK → 进程内调用
REST API  → 网络服务调用
Cloud API → 官方托管服务
MCP       → Agent 工具调用
```

**方式一：Python SDK（读源码最重要的一条路）**

MemOS 与业务程序运行在同一个 Python 进程中，不经过 HTTP。

```bash
pip install -U "MemoryOS[all]"
```

```python
from memos import MOS

memory = MOS.simple()          # 按环境变量+默认配置一键创建可用的 MOS
memory.add(messages=[{"role": "user", "content": "我喜欢喝冰美式，不喜欢太甜。"}])
memory.search(query="我喜欢喝什么？")
memory.chat(query="按我的口味推荐一种咖啡。")
```

- `MOS` 导出自 `src/memos/mem_os/main.py`，核心逻辑在 `src/memos/mem_os/core.py`；
- `MOS.simple()` 会自动组装 LLM、Memory、MemCube 等组件；
- `add()` 支持 `messages`、`memory_content`、`doc_path` 等输入；`search()` 接受 `query`、`user_id`、Cube、Top-K、检索模式、`session_id` 等参数；`chat()` 先检索用户有权限的 Cube，再拼接记忆与聊天历史调用 Chat LLM。

调用链：

```text
程序 → MOS.add/search/chat → MemCube → Memory → Vector DB / Graph DB
```

优点：无 HTTP 开销、调用链最直接、易调试、可直接操作组件。缺点：与业务进程耦合深，不适合多语言/多服务统一访问。

**方式二：REST API（把 MemOS 服务化）**

当 Java 后端、Python Agent、Web 服务、多个微服务要共享一套记忆系统时，把 MemOS 单独部署成服务。

- 基于 FastAPI：`server_api.py` 创建应用，Router 挂 `/product` 前缀；
- 启动：Docker Compose（MemOS + Neo4j + Qdrant）或 `uvicorn memos.api.server_api:app --port 8000`，`http://localhost:8000/docs` 可看接口文档；
- 主要接口：

```text
POST /product/create_cube      创建记忆空间（Cube）
POST /product/add              写入记忆
POST /product/search           检索记忆
POST /product/chat/complete    完整回答
POST /product/chat/stream      SSE 流式回答
```

- Cube 是独立记忆空间；读写权限用 `readable_cube_ids` / `writable_cube_ids` 区分，旧的 `mem_cube_id` 正逐步被取代；
- Router 不实现记忆逻辑，把请求交给 `AddHandler` / `SearchHandler`；
- 注意：**Handler 不再经过 MOS 类**，而是通过 `HandlerDependencies` 直接持有底层组件（MemCube、Searcher、Embedder、Reranker、Vector/Graph DB 等），所以 REST 调用链比 SDK 更深入：

```text
HTTP → Router → Handler → MemCube / 组件层 → Memory
```

**方式三：Cloud API**

免自建 Server/Neo4j/Qdrant/Scheduler，直接用官方托管服务，需要 API Key：

```text
POST /add/message    写入记忆
POST /search/memory  检索记忆
```

Base URL 形如 `https://memos.memtensor.cn/api/openmem/v1`，请求头 `Authorization: Token <API_KEY>`。客户端侧只是 HTTP 调用，服务端是官方黑盒，无法从开源仓库确认其内部实现。

**MemOSClient：容易混淆的"第二种 Python SDK"**

- `from memos import MOS`：进程内直接调用 MemOS 本体，无 HTTP；
- `from memos.api.client import MemOSClient`：本质是 HTTP 客户端封装，`add_message()` 对应 `/add/message`，`search_memory()` 对应 `/search/memory`。

阅读源码前务必分清这条边界：MOS 是本体，MemOSClient 只是帮你封装 HTTP。

**方式四：MCP（给 Agent 用）**

把记忆能力暴露成 MCP Tool，Cursor、Claude 等 MCP Client 直接当工具使用，不需要知道具体调用方式。

- 支持 `stdio` / `HTTP` / `SSE`（已弃用但仍兼容）；
- 启动：`python -m memos.api.mcp_serve --transport stdio`（或 `--transport http`）；
- `mcp_serve.py` 里直接 `from memos.mem_os.main import MOS`，MCP Server 接收或创建 MOS 实例，因此 MCP 与 SDK 一样经过 MOS 封装层。

一句话区分：MCP 解决"怎么让 Agent 把 MemOS 当工具用"，REST 解决"怎么让普通服务把 MemOS 当后端用"。

**四种方式核心区别**

| 使用方式 | 调用关系 | MemOS 运行位置 | 更适合 |
|---|---|---|---|
| MOS Python SDK | 函数调用 | 与业务同进程 | 源码学习、实验、Python Agent |
| Self-host REST | HTTP | 自己部署的独立服务 | 后端系统、多服务、多语言 |
| Cloud API / MemOSClient | HTTPS | 官方服务器 | 不想维护基础设施 |
| MCP | MCP Tool | 本地或远程 MCP Server | Cursor、Agent、MCP Client |

核心认知：这些入口都落在同一套底层记忆组件（MemCube → Memory）上，没有第二套记忆系统；区别只在封装层级——SDK 与 MCP 经过 MOS 类，REST 直接操作组件层，Cloud 是官方托管的黑盒服务。

**产品入口 → 源码目录映射**

```text
Python SDK  → src/memos/mem_os/           → MOS.add / search / chat
REST API    → src/memos/api/server_api.py → routers/ → handlers/ → 组件层（MemCube / DB）
HTTP Client → src/memos/api/client.py     → 远程 HTTP API
MCP         → src/memos/api/mcp_serve.py  → MOS → Memory
```

**本章结论**

1. MemOS 既是 Python Library，也可以作为独立 Memory Service；
2. 不同入口最终都落在同一套核心记忆组件上（MemCube → Memory），但没有都经过 MOS 类：SDK 与 MCP 经过 MOS 封装层，REST 直接操作组件层，Cloud 为官方托管黑盒；
3. 源码阅读应从最短路径开始，下一步追 `MOS.simple()`：当我们写下 `memory = MOS.simple()` 时，MemOS 到底在后台创建了什么？
