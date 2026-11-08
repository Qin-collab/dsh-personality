# DSH Personality

给 DeepSeek Harness 装上「人格 + 长期记忆」的插件：

- **改人格**：名字、身份、表达风格、行为准则，五套一键预设，改完下一轮对话立刻生效。
- **历史会话 → JSON**：读取已存储的会话日志（含当前活动会话），让模型把每段对话压成
  `{title, summary, keyPoints, topics}`，写到 `memory.json`。
- **每轮带上人格与记忆**：人格进系统提示的稳定前缀，历史总结进每轮刷新一次的运行时上下文。
- **设置界面**：设置面板里的「DSH 人格」页 —— 快速预设、字段编辑、立即总结、查看/清空记忆。

## 安装后在哪里

| 位置 | 内容 |
| --- | --- |
| 设置面板 → 左侧导航 → **DSH 人格** | 全部设置界面（快速人格 / 人格设定 / 长期记忆） |
| `<DSH_HOME>/dsh-personality/personality.json` | 当前人格（可直接手改，改完点「重新读取文件」） |
| `<DSH_HOME>/dsh-personality/memory.json` | 会话总结 `sessions` + 记忆条目 `memories` |

`DSH_HOME` 在 Windows 上通常是 `C:\Users\<你>\.dsh`。

## 用法

1. 打开设置 → DSH 人格。
2. 在上方「快速人格」里点一个预设（可靠工程师 / 温暖伙伴 / 毒舌点评 / 极简极客 / 严谨学者）。
3. 想微调就在「人格设定」里改名字、身份、风格、行为准则，点「保存人格」。
4. 点「总结历史会话」：读取最近 8 个有内容的会话，每个一次模型调用生成 JSON 总结并落盘。
   只总结「事件数变了」的会话，重复点击不会重复花钱；勾选「强制重新总结」才会重算。
5. 想确认效果，可以让模型调用 `personality_status` 或 `personality_memory`。

## 给模型用的工具

| 工具 | 作用 |
| --- | --- |
| `personality_status` | 当前人格、预设列表、数据目录、总结/记忆条数 |
| `personality_set` | 改人格字段（`name` / `identity` / `style` / `rules`），下一轮生效 |
| `personality_preset` | 套用内置预设 |
| `personality_summarize` | 把历史会话总结进 `memory.json` |
| `personality_memory` | `list` 查看最近的总结与记忆，`clear` 清空（人格不受影响） |

设置页与这些工具走同一套 Host 实现，行为一致。

## 可选配置（`cordis.patch.yml`，一般不需要）

```yaml
- id: dsh-personality
  config:
    enabled: true
    dataDir: 'D:/my-personality-data'   # 默认 <DSH_HOME>/dsh-personality
    model:                               # 总结用的模型；默认跟随当前默认模型
      provider: deepseek-account
      model: deepseek-flash
      maxTokens: 4000
    personality:
      inject: true                       # 是否把人格注入系统提示
    memory:
      inject: true                       # 是否注入历史记忆
      injectChars: 2400                  # 记忆注入的字符上限
      maxSessions: 200                   # memory.json 里保留的会话总结数
      maxMemories: 200                   # 记忆条目上限
      autoSummarize: false               # 每 N 个 turn 结束后自动归档
      autoEveryTurns: 5
      transcriptChars: 9000              # 单次总结喂给模型的对话字符上限
```

## 实现要点

- 只依赖 `ctx` 服务（`systemPrompt`、`tools`、`llm`、`webServer`、`sessions`、
  `sessionPersistence`、`agentDefaultModel`），**不 import 任何 Harness 包**，
  因此从工作区目录链接安装也能正常解析。
- 人格走 `systemPrompt.section`（稳定前缀，不随每轮变化），历史记忆走
  `systemPrompt.context`（每轮刷新、不累积），两者都不会污染会话日志。
- 会话读取优先活动会话（`sessions.list()` + `snapshotEvents()`），其次持久化日志
  （`sessionPersistence.list()` / `open(id,'read')`），只取 `user/message`（`source.kind === 'user'`）
  与 `assistant/message` 的纯文本，工具调用与插件注入的上下文不参与总结。
- 写入用「临时文件 + rename」，读回永远拿到完整 JSON；读取是同步的，因为系统提示是同步组装的。

## 注意

- 如果同时装了其它人格类插件（例如 `@agentsoul/dsh-agentsoul`），两套人格会被同时注入。
  只想用其中一套时，把另一套禁用（`cordis.patch.yml` 里给对应的 row 加 `disabled: true`）。
- 「总结历史会话」会产生真实的模型调用费用，一次点击最多 8 次调用。
