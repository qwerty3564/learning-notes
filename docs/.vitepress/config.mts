import { defineConfig } from 'vitepress'

export default defineConfig({
  title: "My Learning Notes",
  description: 'LLM、Agent、模型训练与工程实践学习笔记',

  // 仓库名为 learning-notes，所以要配置这个路径
  base: '/learning-notes/',

  lang: 'zh-CN',
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: '首页', link: '/' },
      { text: 'LLM', link: '/llm/' },
      { text: 'Agent', link: '/agent/' },
      { text: '工程实践', link: '/engineering/' },
      {
        text: 'GitHub',
        link: 'https://github.com/你的用户名/learning-notes'
      }
    ],

    sidebar: {
      '/llm/': [
        {
          text: 'LLM 基础与架构',
          collapsed: false,
          items: [
            { text: '学习路线', link: '/llm/' },
            { text: 'Mamba 原理', link: '/llm/mamba' },
            { text: 'Nemotron 架构', link: '/llm/nemotron' }
          ]
        },
        {
          text: '训练与推理',
          collapsed: false,
          items: [
            { text: 'LoRA 与 QLoRA', link: '/llm/qlora' },
            { text: '大模型加载', link: '/llm/model-loading' },
            {
              text: '结构化剪枝',
              link: '/llm/structured-pruning'
            }
          ]
        }
      ],

      '/agent/': [
        {
          text: 'Agent 原理',
          collapsed: false,
          items: [
            { text: '学习路线', link: '/agent/' },
            { text: 'Agent 整体架构', link: '/agent/architecture' },
            { text: '记忆系统', link: '/agent/memory-system' },
            { text: 'MCP', link: '/agent/mcp' }
          ]
        },
        {
          text: 'Agent 评估',
          collapsed: false,
          items: [
            {
              text: '评估概览',
              link: '/agent/evaluation/'
            },
            {
              text: '长期记忆评估数据集',
              link: '/agent/evaluation/memory-benchmarks'
            }
          ]
        }
      ],

      '/engineering/': [
        {
          text: '工程实践',
          items: [
            { text: 'Docker', link: '/engineering/docker' },
            { text: 'Git', link: '/engineering/git' },
            { text: 'Linux', link: '/engineering/linux' }
          ]
        }
      ]
    },

    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/qwerty3564/learning-notes'
      }
    ],

    search: {
      provider: 'local'
    },

    outline: {
      level: [2, 3],
      label: '本页目录'
    },

    docFooter: {
      prev: '上一篇',
      next: '下一篇'
    },

    lastUpdated: {
      text: '最后更新时间'
    },

    footer: {
      message: '基于 VitePress 构建',
      copyright: 'Copyright © 2026 Changjin'
    }
  }
})