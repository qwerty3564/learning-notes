# 五个长期记忆评估数据集笔记

> 适用场景：理解 MemOS `evaluation/scripts/` 下的 `locomo`、`long_bench-v2`、`longmemeval`、`personamem` 和 `PrefEval` 五套评估脚本。  
> 核心问题：每个数据集长什么样、测什么能力、MemOS 如何评估、最终看哪些指标。

---

## 1. 总览

这五个数据集虽然都被放在“记忆评估”目录下，但关注点并不相同。

| 数据集 | 核心能力 | 输入形式 | 输出形式 | 主要指标 |
|---|---|---|---|---|
| LoCoMo | 长期对话事实记忆、跨会话推理、时间推理 | 多轮、多日期、双人对话 | 自由文本 | LLM Judge、F1、ROUGE、语义相似度 |
| LongBench v2 | 超长文档理解与检索 | 长文档/代码/结构化数据 + 四选一题 | A/B/C/D | Accuracy |
| LongMemEval | 多会话记忆、信息更新、时间关系、拒答 | 多个历史会话 + 问题日期 + QA | 自由文本 | LLM Judge、分题型准确率、检索召回 |
| PersonaMem | 动态用户画像与个性化决策 | 用户历史 + 四选一问题 | A/B/C/D | Accuracy、分类准确率 |
| PrefEval | 用户偏好记忆与偏好遵循 | 偏好对话 + 后续请求 | 自由文本 | 个性化回答比例、偏好违反类型 |

可以把它们理解成五个不同层次：

```text
LongBench v2
    超长文档里找答案
        ↓
LoCoMo
    长期对话里记住事实
        ↓
LongMemEval
    处理时间、更新、跨会话和无答案问题
        ↓
PersonaMem
    维护会变化的用户画像
        ↓
PrefEval
    在最终回答中真正遵守用户偏好
```

---

## 2. MemOS 的统一评估流程

这几套脚本通常都采用类似的四阶段流程：

```text
原始数据
  ↓
1. Ingestion：写入记忆系统
  ↓
2. Search：根据问题检索相关记忆
  ↓
3. Response：让回答模型使用检索结果作答
  ↓
4. Metric / Eval：比较标准答案并计算指标
```

目录中的文件名一般也对应这几个阶段：

```text
xxx_ingestion.py   # 写入历史数据
xxx_search.py      # 检索相关记忆
xxx_responses.py   # 调用模型生成答案
xxx_eval.py        # LLM Judge 或答案判定
xxx_metric.py      # 汇总分数、耗时和分类结果
```

因此，最终分数不是只由记忆系统决定，而是由以下模块共同决定：

```text
记忆抽取质量
+ 存储组织方式
+ 检索召回能力
+ 检索排序能力
+ 回答模型能力
+ 裁判模型稳定性
```

---

# 3. LoCoMo

## 3.1 它测什么

LoCoMo 主要测试长期自然对话中的记忆能力，包括：

- 单个事实的记忆；
- 多个会话信息的组合；
- 事件发生时间和先后关系；
- 根据长期历史进行开放式回答。

它更接近真实聊天场景：两个人隔几天或几个月聊一次，每次聊不同的话题，后面再针对之前的内容提问。

---

## 3.2 数据大致长什么样

一条完整样本通常是一组人物之间的长期对话，其中包含多个 session。

```json
{
  "sample_id": "conv-0",
  "conversation": {
    "speaker_a": "Melanie",
    "speaker_b": "Caroline",

    "session_1_date_time": "1:30 PM on 8 May, 2023",
    "session_1": [
      {
        "speaker": "Melanie",
        "text": "我上周带孩子们去露营了。",
        "dia_id": "D1:1"
      },
      {
        "speaker": "Caroline",
        "text": "听起来很不错！",
        "dia_id": "D1:2"
      }
    ],

    "session_2_date_time": "2:31 PM on 17 July, 2023",
    "session_2": [
      {
        "speaker": "Melanie",
        "text": "两周前和家人露营后，我这个周末一直在休息。",
        "dia_id": "D2:1"
      }
    ]
  },

  "qa": [
    {
      "question": "Melanie 最近和谁去露营了？",
      "answer": "她的家人和孩子。",
      "category": 1,
      "evidence": ["D1:1", "D2:1"]
    }
  ]
}
```

这里最重要的字段是：

| 字段 | 含义 |
|---|---|
| `session_n` | 第 n 次对话 |
| `session_n_date_time` | 该次对话发生时间 |
| `speaker` | 当前说话人 |
| `text` | 对话文本 |
| `dia_id` | 对话轮次编号 |
| `question` | 测试问题 |
| `answer` | 标准答案 |
| `evidence` | 支持答案的对话轮次 |
| `category` | 问题类型 |

---

## 3.3 问题类型

MemOS 的脚本会按类别统计：

1. **Single Hop**
   - 只需要一条记忆。
   - 例如：“Melanie 的孩子参加了什么活动？”

2. **Multi Hop**
   - 需要组合多个 session 中的信息。
   - 例如：先知道某人喜欢户外，再知道他最近膝盖受伤，最后判断适合什么活动。

3. **Temporal Reasoning**
   - 需要判断时间先后、持续时间或相对日期。
   - 例如：“她是在搬家之前还是之后换工作的？”

4. **Open Domain**
   - 答案更开放，可能需要对历史进行概括或推理。

---

## 3.4 MemOS 怎么评估

### 第一步：写入记忆

MemOS 会分别站在两个说话人的视角构造消息。

```text
Melanie 视角：
Melanie 的话 → user
Caroline 的话 → assistant

Caroline 视角：
Caroline 的话 → user
Melanie 的话 → assistant
```

每条消息还会带上对应 session 的时间。

### 第二步：检索

根据问题，从对应用户的记忆中搜索 Top-K 相关内容。

### 第三步：生成答案

将以下内容交给回答模型：

```text
检索到的记忆
+ 当前问题
+ 回答提示词
```

### 第四步：判分

LoCoMo 是自由文本答案，因此不能简单做字符串完全匹配。

MemOS 使用的指标主要有：

#### 主指标：LLM-as-a-Judge

让裁判模型判断：

```text
模型答案是否在语义上与标准答案一致
```

每题通常转换为：

```text
正确 = 1
错误 = 0
```

如果裁判运行多次，则报告：

```text
平均分 ± 标准差
```

#### 辅助词面指标

- Token F1
- ROUGE-1
- ROUGE-2
- ROUGE-L
- BLEU-1 ~ BLEU-4
- METEOR

#### 辅助语义指标

- BERTScore F1
- Embedding Similarity

#### 系统效率指标

- 搜索耗时；
- 回答耗时；
- 总耗时；
- P50；
- P95；
- 检索上下文 token 数。

---

## 3.5 它实际测到的东西

LoCoMo 的最终成绩大致由以下部分共同决定：

```text
长期对话能否被正确写入
+ 重要事实能否被抽取
+ 问题能否召回正确证据
+ 多条证据能否被组合
+ 回答模型能否正确表达
```

### 优点

- 对话自然；
- 有明确时间信息；
- 支持跨 session 推理；
- 接近真实助手的长期聊天场景。

### 局限

- 数据规模不大；
- 自由文本判分依赖裁判模型；
- 很难完全区分“检索失败”和“回答模型推理失败”。

---

# 4. LongBench v2

## 4.1 它测什么

LongBench v2 原本是一个超长上下文理解 benchmark，不是专门为记忆系统设计的。

它主要测试模型处理以下长内容的能力：

- 长文档；
- 多文档；
- 长对话；
- 代码仓库；
- 结构化数据；
- 超长推理材料。

MemOS 把它改造成了一个 RAG/记忆检索任务。

---

## 4.2 数据大致长什么样

一条数据通常包含一个很长的 `context` 和一道四选一题。

```json
{
  "_id": "sample_001",
  "domain": "Code",
  "sub_domain": "Repository Understanding",
  "difficulty": "hard",
  "length": "long",

  "context": "这里是一整个代码仓库、长文档或大量结构化记录……",

  "question": "哪个函数负责加载配置文件？",
  "choice_A": "load_model",
  "choice_B": "load_config",
  "choice_C": "run_server",
  "choice_D": "build_prompt",

  "answer": "B"
}
```

重要字段：

| 字段 | 含义 |
|---|---|
| `context` | 超长输入内容 |
| `question` | 问题 |
| `choice_A~D` | 四个候选答案 |
| `answer` | 正确选项 |
| `difficulty` | easy / hard |
| `length` | short / medium / long |
| `domain` | 所属领域 |
| `sub_domain` | 子领域 |

---

## 4.3 原始评估方式

原始 LongBench v2 通常把完整上下文直接交给长上下文模型，然后要求输出：

```text
The correct answer is (B)
```

最后提取 A/B/C/D，并计算：

\[
Accuracy = \frac{\text{正确题数}}{\text{总题数}}
\]

---

## 4.4 MemOS 怎么评估

MemOS 没有直接把整个 `context` 放进回答模型，而是：

```text
超长 context
  ↓
作为文件写入记忆系统
  ↓
使用 question 检索相关片段
  ↓
把检索片段和四个选项交给模型
  ↓
提取 A/B/C/D
  ↓
与 answer 精确比较
```

回答提示大致是：

```text
Please read the following retrieved text chunks.

<text>
检索片段 1
检索片段 2
...
</text>

Question: ...
Choices:
(A) ...
(B) ...
(C) ...
(D) ...

The correct answer is (...)
```

---

## 4.5 主要指标

MemOS 会计算：

- Overall Accuracy；
- Easy Accuracy；
- Hard Accuracy；
- Short Accuracy；
- Medium Accuracy；
- Long Accuracy；
- 不同 Domain 的 Accuracy；
- 平均 Prompt Tokens；
- 正确样本数；
- 总样本数。

### 一个需要注意的实现细节

当前 metric 脚本会先过滤没有有效搜索结果的样本。

也就是说：

```text
没有检索到任何记忆的样本
可能不会进入最终 Accuracy 的分母
```

因此比较不同系统时，最好同时报告：

```text
有效检索样本数
检索覆盖率
有效样本上的 Accuracy
全量样本上的 Accuracy
```

否则可能出现：

```text
检索系统只回答了少量容易题
但在“有效样本”上的准确率很高
```

---

## 4.6 它实际测到的东西

MemOS 版本的 LongBench v2 更像是在测：

```text
超长文档切分
+ 文档记忆化
+ 问题相关片段检索
+ 四选一阅读理解
```

它与原始 LongBench v2 的“模型直接读取完整超长上下文”并不完全等价。

### 优点

- 答案是确定选项，判分客观；
- 可以按难度、长度和领域拆分；
- 适合测试长文档 RAG 和记忆检索。

### 局限

- 不是典型用户长期记忆任务；
- 结果高度依赖文档切分；
- 过滤空检索样本可能造成分数偏高。

---

# 5. LongMemEval

## 5.1 它测什么

LongMemEval 专门用于评估多会话长期记忆。

它重点测试：

- 单个 session 中的事实；
- 跨多个 session 的组合；
- 时间推理；
- 信息更新；
- 用户偏好；
- 历史中没有答案时的拒答能力。

相比 LoCoMo，LongMemEval 的题型设计更加严格和可控。

---

## 5.2 数据大致长什么样

```json
{
  "question_id": "q_001",
  "question_type": "knowledge-update",

  "question": "我现在使用哪一台笔记本电脑？",
  "answer": "MacBook Pro",
  "question_date": "2024/01/20",

  "haystack_session_ids": [
    "session_1",
    "session_2",
    "session_3"
  ],

  "haystack_dates": [
    "2023/08/10 (Thu) 10:00",
    "2023/12/15 (Fri) 15:30",
    "2024/01/18 (Thu) 11:00"
  ],

  "haystack_sessions": [
    [
      {
        "role": "user",
        "content": "我现在使用 ThinkPad。"
      },
      {
        "role": "assistant",
        "content": "好的。"
      }
    ],
    [
      {
        "role": "user",
        "content": "我准备换一台电脑。"
      }
    ],
    [
      {
        "role": "user",
        "content": "我最终买了 MacBook Pro。",
        "has_answer": true
      }
    ]
  ],

  "answer_session_ids": ["session_3"]
}
```

关键字段：

| 字段 | 含义 |
|---|---|
| `question_type` | 问题类型 |
| `question` | 当前问题 |
| `answer` | 标准答案 |
| `question_date` | 提问发生的时间 |
| `haystack_sessions` | 大量历史 session |
| `haystack_dates` | 每个 session 的时间 |
| `answer_session_ids` | 答案来自哪些 session |
| `has_answer` | 某轮是否包含关键证据 |

---

## 5.3 典型题型

### 1. Single-session

答案只来自一个 session。

```text
历史：用户说自己养了一只叫 Milo 的猫。
问题：用户的猫叫什么？
```

### 2. Multi-session

需要组合多个 session。

```text
Session 1：用户计划去日本。
Session 2：用户后来取消东京，改去京都。
问题：用户最终准备去哪里？
```

### 3. Temporal Reasoning

需要理解时间顺序或相对日期。

```text
5 月：开始新工作。
8 月：搬家。
问题：搬家发生在换工作之前还是之后？
```

### 4. Knowledge Update

后来的信息覆盖早期信息。

```text
3 月：用户住在北京。
8 月：用户搬到了上海。
10 月提问：用户现在住在哪里？
答案：上海。
```

### 5. Preference

需要记住用户偏好。

```text
历史：用户不喜欢辛辣食物。
问题：应该给用户推荐哪种晚餐？
```

### 6. Abstention

历史中没有答案，模型应表示不知道。

```text
历史从未提到用户的护照号码。
问题：用户的护照号码是什么？
正确行为：说明历史中没有相关信息。
```

---

## 5.4 为什么 `question_date` 很重要

评估时必须把 `question_date` 当作当前时间。

例如：

```text
1 月：用户住在北京。
3 月：用户搬到上海。
问题日期：2 月。
```

此时正确答案应该是：

```text
北京
```

不能使用 3 月发生的未来信息。

因此检索接口若支持 `reference_time`，应传入：

```text
reference_time = question_date
```

否则会发生未来信息泄漏，尤其影响：

- 时间推理；
- 信息更新；
- 当前状态问题。

---

## 5.5 MemOS 怎么评估

### 数据写入

每个 session 按原始时间写入记忆系统：

```text
session 1 + date 1
session 2 + date 2
session 3 + date 3
...
```

### 检索

使用当前问题搜索相关历史，并尽量基于 `question_date` 限制时间范围。

### 回答

将检索结果交给回答模型，生成自由文本答案。

### 判分

主指标通常是 LLM-as-a-Judge：

```text
模型答案与标准答案是否语义一致
```

辅助指标包括：

- F1；
- ROUGE；
- BLEU；
- METEOR；
- BERTScore；
- 语义相似度；
- 检索耗时；
- 回答耗时；
- 总耗时；
- P50 / P95；
- 上下文 token 数。

还可以按 `question_type` 统计准确率。

---

## 5.6 检索层评估

LongMemEval 提供答案所在 session，因此适合单独评估检索器。

例如标准证据是：

```text
answer_session_ids = ["session_37"]
```

如果 Top-5 检索结果包含 `session_37`：

```text
Recall@5 = 1
```

可以计算：

- Session Recall@K；
- Turn Recall@K；
- Evidence Hit Rate；
- MRR；
- nDCG。

### 为什么要分开评估

端到端回答错误有两种可能：

```text
情况 1：正确证据没有被检索到
情况 2：证据检索到了，但回答模型推理错误
```

只看最终 Accuracy 无法区分二者。

---

## 5.7 LoCoMo 与 LongMemEval 的区别

| 对比项 | LoCoMo | LongMemEval |
|---|---|---|
| 对话风格 | 更自然、更接近真实聊天 | 人工控制更严格 |
| 重点 | 长期自然对话理解 | 多会话记忆能力诊断 |
| 时间推理 | 有 | 更强调 |
| 信息更新 | 有，但不是唯一重点 | 核心题型之一 |
| 无答案拒答 | 较弱 | 专门包含 |
| 证据定位 | 有 evidence | 有 answer session |
| 适合用途 | 测真实对话体验 | 测记忆系统能力边界 |

---

# 6. PersonaMem

## 6.1 它测什么

PersonaMem 测试模型能否从很长的历史中维护一个动态用户画像。

它不只是问：

```text
用户过去说过什么？
```

而是问：

```text
根据用户当前的长期偏好、近期状态和限制，
现在应该给出什么答案？
```

---

## 6.2 数据文件

常见数据文件包括：

```text
questions_32k.csv
shared_contexts_32k.jsonl
```

通常一个文件保存长历史，一个文件保存问题和选项。

---

## 6.3 历史数据示例

```json
{
  "shared_context_id": "ctx_001",
  "messages": [
    {
      "role": "user",
      "content": "我平时喜欢安静、自然风景多的旅行。"
    },
    {
      "role": "assistant",
      "content": "明白。"
    },
    {
      "role": "user",
      "content": "不过最近膝盖受伤了，暂时不能长距离徒步。"
    }
  ]
}
```

问题文件可能类似：

```csv
persona_id,question_id,question_type,topic,user_question_or_message,correct_answer,all_options,shared_context_id
p001,q001,dynamic_preference,travel,"周末适合去哪里？",C,"['A','B','C','D']",ctx_001
```

对应选项：

```text
A. 高强度登山穿越
B. 三天沙漠徒步
C. 湖边度假并安排短距离散步
D. 攀岩训练营
```

正确答案是 C，因为需要同时考虑：

```text
长期偏好：喜欢自然、安静
当前状态：膝盖受伤
```

---

## 6.4 它与普通事实记忆的区别

普通事实记忆：

```text
用户喜欢户外。
```

动态画像需要进一步处理：

```text
用户喜欢户外。
但是用户最近受伤。
所以当前推荐不能是高强度户外活动。
```

因此 PersonaMem 测的是：

```text
历史事实抽取
+ 当前状态更新
+ 冲突信息处理
+ 个性化决策
```

---

## 6.5 MemOS 怎么评估

流程：

```text
长用户历史
  ↓
写入记忆系统
  ↓
根据问题检索相关画像信息
  ↓
将上下文、问题和选项交给模型
  ↓
模型选择 A/B/C/D
  ↓
与 golden answer 比较
```

答案提取时通常会识别：

```text
(A)
A
<final_answer>A</final_answer>
```

然后判断是否等于标准答案。

---

## 6.6 主要指标

MemOS 默认可能对每道题运行多次，例如 3 次。

最终统计：

- Overall Accuracy；
- Accuracy 标准差；
- 每类问题 Accuracy；
- 每个用户的 Accuracy；
- 每次运行的 Accuracy；
- 搜索耗时；
- 回答耗时；
- Mean；
- Median；
- P50；
- P95；
- Min / Max；
- Standard Deviation。

多次运行的原因是观察回答稳定性：

```text
同样的记忆和问题
模型是否每次都能选对
```

---

## 6.7 优点与局限

### 优点

- 重点关注动态画像；
- 四选一判分客观；
- 适合测试个性化推荐；
- 可以测试远距离记忆。

### 局限

- 选项可能给模型提供额外提示；
- 最终 Accuracy 仍受回答模型能力影响；
- 未必能覆盖真实开放式个性化回答。

---

# 7. PrefEval

## 7.1 它测什么

PrefEval 专门测试：

```text
模型是否记住用户偏好
并在后续回答中真正遵守偏好
```

重点不只是“能不能把偏好找回来”，还包括：

- 有没有意识到偏好；
- 有没有错误理解偏好；
- 有没有违反偏好；
- 回答是否真正有帮助。

---

## 7.2 三种偏好表达方式

### 1. 显式偏好

用户直接表达：

```json
{
  "preference": "我不喜欢太辣的食物。",
  "question": "给我推荐一些适合晚餐的川菜。"
}
```

理想回答应避免推荐特别辣的菜，或者明确说明如何降低辣度。

---

### 2. 通过选择隐式表达

用户没有直接说偏好，而是通过选择体现偏好。

```json
{
  "implicit_query": "你更喜欢哪种酒店？",
  "options": [
    "市中心热闹的大型酒店",
    "郊区安静的小型民宿"
  ],
  "conversation": [
    {
      "role": "user",
      "content": "我选择郊区安静的小型民宿。"
    }
  ],
  "question": "帮我推荐下周旅行的住宿。"
}
```

系统需要推断：

```text
用户偏好安静、远离闹市的住宿。
```

---

### 3. Persona 隐式偏好

偏好隐藏在多轮对话中。

```json
{
  "persona": "用户多次提到环保、公共交通和低碳生活。",
  "conversation": [
    "...多轮对话..."
  ],
  "question": "给我推荐一辆日常通勤车。"
}
```

模型应综合历史推断用户更偏向：

```text
低能耗、低排放、适合通勤的方案。
```

---

## 7.3 干扰对话设置

MemOS 脚本支持额外插入：

```text
0 轮无关对话
10 轮无关对话
300 轮无关对话
```

其目的是测试：

```text
当偏好被大量无关信息淹没后，
记忆系统还能不能正确找回来。
```

这比只测试短对话更接近长期记忆场景。

---

## 7.4 MemOS 怎么评估

完整流程：

```text
偏好相关对话
  ↓
可加入 0 / 10 / 300 轮无关对话
  ↓
写入记忆系统
  ↓
根据最终问题检索 Top-K 记忆
  ↓
回答模型生成自由文本答案
  ↓
裁判模型执行四项判断
```

---

## 7.5 四项裁判任务

### 1. Violate Preference

判断回答是否违反用户偏好。

例如：

```text
偏好：不吃辣。
回答：强烈推荐特辣火锅。
结果：违反偏好。
```

---

### 2. Acknowledge Preference

判断回答是否意识到用户偏好。

例如：

```text
“考虑到你不喜欢辛辣食物……”
```

或者即使没有直接引用原句，但回答明确体现了该偏好，也可能判为 Yes。

---

### 3. Hallucinate Preference

判断模型是否错误复述或编造偏好。

例如：

```text
真实偏好：不喜欢电动车。
模型说：你一直偏爱电动车。
结果：偏好幻觉。
```

---

### 4. Helpful Response

判断回答是否真正解决了用户问题。

以下情况可能判为无帮助：

```text
“我不知道你的偏好，请重新告诉我。”
“我没有历史记录，无法回答。”
只追问信息，不给任何实质建议。
```

---

## 7.6 最终错误类型

根据四项判断，结果会被分为五类。

### 1. Personalized Response

```text
记住偏好
+ 没有违反偏好
+ 没有编造偏好
+ 回答有帮助
```

这是最理想的结果。

### 2. Preference-Unaware Violation

```text
没有意识到用户偏好
+ 给出了违反偏好的建议
```

### 3. Preference Hallucination Violation

```text
意识到应该使用偏好
+ 但错误理解或编造了偏好
+ 最终回答违反真实偏好
```

### 4. Inconsistency Violation

```text
正确识别了偏好
+ 但最终答案仍然与偏好冲突
```

### 5. Unhelpful Response

```text
虽然没有明显违反偏好
+ 但回答没有实质帮助
```

---

## 7.7 最终指标

PrefEval 主要看各类型的占比：

- Personalized Response；
- Preference-Unaware Violation；
- Preference Hallucination Violation；
- Inconsistency Violation；
- Unhelpful Response。

同时统计：

- 添加记忆耗时；
- 搜索耗时；
- 检索上下文 token 数。

PrefEval 最重要的主指标可以理解为：

```text
Personalized Response 占比越高越好
```

---

# 8. 五个数据集的横向比较

## 8.1 数据形式

| 数据集 | 历史内容 | 问题形式 | 答案形式 |
|---|---|---|---|
| LoCoMo | 双人长期自然对话 | 开放式 QA | 自由文本 |
| LongBench v2 | 超长文档/代码/数据 | 四选一 | A/B/C/D |
| LongMemEval | 大量多 session 对话 | 开放式 QA | 自由文本 |
| PersonaMem | 用户长期历史和动态画像 | 四选一 | A/B/C/D |
| PrefEval | 偏好历史和后续请求 | 个性化生成 | 自由文本 |

---

## 8.2 核心能力

| 能力 | LoCoMo | LongBench v2 | LongMemEval | PersonaMem | PrefEval |
|---|---:|---:|---:|---:|---:|
| 长期事实记忆 | 强 | 弱 | 强 | 中 | 中 |
| 跨会话推理 | 强 | 弱 | 强 | 强 | 中 |
| 时间推理 | 强 | 弱 | 强 | 中 | 弱 |
| 信息更新 | 中 | 弱 | 强 | 强 | 中 |
| 无答案拒答 | 弱 | 弱 | 强 | 弱 | 中 |
| 用户画像 | 中 | 无 | 中 | 强 | 强 |
| 偏好遵循 | 中 | 无 | 中 | 强 | 最强 |
| 长文档检索 | 中 | 最强 | 中 | 强 | 中 |

---

## 8.3 判分方式

| 数据集 | 主要判分方式 | 是否依赖裁判模型 |
|---|---|---:|
| LoCoMo | LLM Judge + 文本相似度 | 是 |
| LongBench v2 | 选项精确匹配 | 否 |
| LongMemEval | LLM Judge + 分题型统计 | 是 |
| PersonaMem | 选项精确匹配 | 否 |
| PrefEval | 多维 LLM Judge | 是 |

---

# 9. 实际做实验时应该怎么选

## 9.1 测事实型长期记忆

优先使用：

```text
LoCoMo
```

适合观察：

- 能否记住人物信息；
- 能否处理多轮自然对话；
- 能否跨 session 组合事实。

---

## 9.2 测严格的多会话能力

优先使用：

```text
LongMemEval
```

适合观察：

- 时间推理；
- 信息更新；
- 多 session 组合；
- 无答案拒答；
- 证据召回。

---

## 9.3 测长文档检索

优先使用：

```text
LongBench v2
```

适合观察：

- 文档切分；
- 超长内容索引；
- Top-K 检索；
- 代码和结构化数据理解。

---

## 9.4 测动态用户画像

优先使用：

```text
PersonaMem
```

适合观察：

- 长期偏好；
- 临时状态；
- 冲突信息；
- 个性化选择。

---

## 9.5 测偏好遵循

优先使用：

```text
PrefEval
```

适合观察：

- 是否记住偏好；
- 是否错误复述偏好；
- 是否违反偏好；
- 是否能给出有帮助的个性化答案。

---

# 10. 评估时的注意事项

## 10.1 不要直接把五个分数求平均

原因是它们的任务和指标不同：

```text
LoCoMo：LLM Judge 分数
LongBench v2：四选一 Accuracy
LongMemEval：LLM Judge 分数
PersonaMem：四选一 Accuracy
PrefEval：个性化回答比例
```

这些分数不是同一个统计量。

更合理的方式是分别报告：

```text
事实记忆能力
多会话能力
长文档检索能力
用户画像能力
偏好遵循能力
```

---

## 10.2 区分检索性能和回答性能

建议至少拆成两层：

### 检索层

- Recall@K；
- MRR；
- nDCG；
- Evidence Hit Rate；
- 检索覆盖率；
- 检索耗时。

### 回答层

- Accuracy；
- LLM Judge；
- F1；
- ROUGE；
- 偏好遵循率；
- 回答耗时。

否则最终回答错误时，很难知道是：

```text
没找到证据
还是
找到了证据但模型答错
```

---

## 10.3 记录检索上下文大小

两个系统可能得到相似准确率，但一个系统每题使用 20K token，另一个只使用 2K token。

因此应同时报告：

```text
准确率
+ 平均检索 token 数
+ 搜索耗时
+ 生成耗时
```

---

## 10.4 保证时间信息没有泄漏

LongMemEval 等时间型数据集需要保证：

```text
检索时只能使用 question_date 之前的信息
```

否则会提前看到未来发生的事件。

---

## 10.5 LLM Judge 要保持一致

不同裁判模型、提示词和运行次数会明显影响结果。

比较不同记忆框架时，应固定：

- Judge 模型；
- Judge 提示词；
- temperature；
- 运行次数；
- 答案生成模型；
- Top-K；
- 最大上下文长度。

---

# 11. 一句话总结

```text
LoCoMo：长期自然对话事实记忆。

LongBench v2：超长文档与代码内容检索。

LongMemEval：严格测试跨会话、时间、更新和拒答。

PersonaMem：维护动态用户画像并做个性化选择。

PrefEval：判断模型是否真正记住并遵守用户偏好。
```

---

# 12. MemOS 目录与用途对照

```text
evaluation/scripts/
├── locomo/
│   └── 长期自然对话记忆评估
│
├── long_bench-v2/
│   └── 超长文档检索与四选一问答
│
├── longmemeval/
│   └── 多会话、时间、更新和拒答评估
│
├── personamem/
│   └── 动态用户画像与个性化选择
│
└── PrefEval/
    └── 用户偏好记忆与偏好遵循评估
```
