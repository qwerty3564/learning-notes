# Learning Notes

> 纸上得来终觉浅，绝知此事要躬行。
>
> 这不是纯概念学习的笔记：这里的知识大多从具体项目源码和论文中总结归纳而来，围绕 LLM、Agent、模型训练与工程实践，从实践中挖掘理论。

## 🎯 关于本站

这里记录我在大语言模型、Agent、模型训练与工程实践方面的学习过程。每篇笔记都尽量以具体项目源码或论文为起点，先实践、再归纳，把真实的实现细节沉淀为可复用的行业知识。


## 📖 内容导航

| 分类 | 内容 | 入口 |
|---|---|---|
| LLM | Transformer、Mamba、Nemotron、MoE 架构；SFT、QLoRA、模型加载、量化与推理优化 | [开始阅读](./llm/) |
| Agent | Agent 架构、工具调用、MCP、长期记忆与评估 | [Agent 笔记](./agent/) |
| 工程实践 | Python、Docker、Git、Linux、DGX Spark 故障修复与模型部署 | [工程实践](./engineering/) |
| 项目学习 | MemOS 源码拆解系列：从使用入口、组件装配到记忆检索与调度 | [MemOS 系列](./project/memos/chapter1-usage) |

## ✨ 笔记分类

### LLM 原理

- Transformer、Mamba、Nemotron 与 MoE 模型架构
- SFT、QLoRA、模型加载、量化与推理优化
- 结构化剪枝、硬件友好稀疏与推测解码

### Agent 系统

- Agent 架构、工具调用、MCP、长期记忆与评估
- 评估基准：SWE-bench、LoCoMo、LongMemEval、PersonaMem

### 工程实践

- Python、Docker、Git、Linux 与模型部署
- DGX Spark 更新后 Kernel Panic 无损修复

### 项目学习

- **MemOS 长期记忆系统**：从 MemOS 使用方式、MOS 初始化与组件装配，到 MemCube、GeneralTextMemory、TreeTextMemory、MemReader、记忆检索、特殊记忆类型、MOS 调用链与 MemScheduler，逐章拆解一个真实项目的源码实现

## 📚 快速开始

- [LLM 学习路线](./llm/)
- [Agent 学习路线](./agent/)
- [工程实践](./engineering/)
- [项目学习：MemOS 第一章](./project/memos/chapter1-usage)
- [长期记忆评估数据集笔记](./agent/evaluation/memory-benchmarks)

## 💡 如何学习

> 📝 待补充：学习方法与进度安排。
