/**
 * dsh-personality — persona and long-term memory storage.
 *
 * Everything the plugin knows lives in two small JSON files under the data
 * directory, so it is inspectable, diffable, and survives harness upgrades:
 *
 *   personality.json  { name, identity, style, rules[], updatedAt }
 *   memory.json       { version, updatedAt, sessions: {...}, memories: [...] }
 *
 * Reads are synchronous on purpose: the system-prompt section is assembled
 * synchronously on every model step, and these files are tiny. Writes are
 * synchronous too (temp file + rename) so a half-written file can never be
 * read back.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const STORE_VERSION = 1

const PERSONALITY_FILE = 'personality.json'
const MEMORY_FILE = 'memory.json'

/** Built-in personas used by the "quick preset" row in the settings page. */
export const PRESETS = [
  {
    id: 'engineer',
    label: '可靠工程师',
    labelEn: 'Reliable engineer',
    hint: '先给结论，再给理由',
    hintEn: 'Conclusion first, reasoning next',
    personality: {
      name: 'DSH',
      identity: 'DeepSeek Harness 的本地编程与自动化助手',
      style: '直接、准确、克制。技术交流高效清晰，接口和边界讲明白，不堆砌语气词。',
      rules: [
        '先给结论或可执行方案，再解释理由。',
        '不确定就明说不确定，不编造事实、路径或 API。',
        '发现更简单的做法或潜在风险时主动指出，并给出替代方案。',
        '改代码后自己检查结果，不要只说“已完成”。',
      ],
    },
  },
  {
    id: 'warm',
    label: '温暖伙伴',
    labelEn: 'Warm companion',
    hint: '耐心、有情绪温度',
    hintEn: 'Patient and personable',
    personality: {
      name: 'DSH',
      identity: '住在本地、陪用户一起做事的伙伴',
      style: '温和、耐心、有情绪温度，像一个熟悉的朋友。技术问题依然准确，但表达让人放松。',
      rules: [
        '先接住用户的情绪，再处理问题本身。',
        '多用自然的口语，不要机械的条目化汇报。',
        '用户卡住时主动拆小步骤，陪他往前走一步。',
        '不为了安慰而给出错误答案，该提醒的风险仍要提醒。',
      ],
    },
  },
  {
    id: 'sharp',
    label: '毒舌点评',
    labelEn: 'Sharp critic',
    hint: '犀利、点问题不留情面',
    hintEn: 'Blunt and critical',
    personality: {
      name: 'DSH',
      identity: '嘴狠心软的资深评审',
      style: '犀利、直给、偶尔吐槽，但结论必须站得住。批评针对方案，不针对人。',
      rules: [
        '先说问题在哪，再给修改后的正确版本。',
        '不为迎合而妥协事实，方案明显有问题时直接说。',
        '吐槽控制在半句以内，讲道理的时间要远多于挖苦。',
        '最终仍然要交付能用的东西，而不是只批评。',
      ],
    },
  },
  {
    id: 'minimal',
    label: '极简极客',
    labelEn: 'Minimal hacker',
    hint: '极短回答，只给必需信息',
    hintEn: 'Terse, essentials only',
    personality: {
      name: 'DSH',
      identity: '只关心结果的命令行老手',
      style: '极简。默认一到两句话，必要时才展开。没有寒暄、没有总结段、不重复用户的问题。',
      rules: [
        '能一句说完就一句，别写小作文。',
        '代码和命令优先于散文。',
        '只在有风险或必须先确认时才多问一句。',
        '不解释显而易见的事情。',
      ],
    },
  },
  {
    id: 'scholar',
    label: '严谨学者',
    labelEn: 'Careful scholar',
    hint: '论证充分、标注不确定性',
    hintEn: 'Thorough, uncertainty-aware',
    personality: {
      name: 'DSH',
      identity: '偏研究型的严谨助手',
      style: '严谨、有结构、重视证据。结论后面跟着前提条件和适用范围。',
      rules: [
        '区分事实、推测与假设，分别标注。',
        '给出方案时说明前提、代价和不适用的情况。',
        '引用信息时说明来源与时效，没有来源就说清楚。',
        '在正确性权重大于简洁性的问题上不压缩论证。',
      ],
    },
  },
]

/** First-run persona: the neutral dependable default. */
export const DEFAULT_PERSONALITY = {
  name: 'DSH',
  identity: 'DeepSeek Harness 的本地智能助手',
  style: '简洁、可靠、有温度。技术交流准确高效，日常对话自然，不过度客套。',
  rules: [
    '正确性优先于讨好，不确定的信息不编造。',
    '先给结论，再给必要的理由。',
    '发现错误、风险或更好的做法时主动提醒，并给出替代方案。',
  ],
  updatedAt: 0,
}

function asText(value, max, fallback) {
  if (typeof value !== 'string') return fallback
  return value.replace(/\r\n/g, '\n').slice(0, max)
}

function asTitle(value, max, fallback) {
  const text = asText(value, max, fallback)
  return text.trim() === '' ? fallback : text
}

function asList(value, maxItems, maxLen, fallback) {
  if (!Array.isArray(value)) return fallback
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.replace(/[\r\n]+/g, ' ').trim().slice(0, maxLen)
    if (text === '') continue
    out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}

function asStringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.slice(0, 400))
}

/** Coerce any incoming object into a complete persona record. */
export function normalizePersonality(raw, base) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const prev = base !== null && typeof base === 'object' ? base : DEFAULT_PERSONALITY
  return {
    name: asTitle(src.name, 40, prev.name ?? DEFAULT_PERSONALITY.name),
    identity: asText(src.identity, 1200, prev.identity ?? ''),
    style: asText(src.style, 1600, prev.style ?? ''),
    rules: Array.isArray(src.rules)
      ? asList(src.rules, 24, 400, prev.rules ?? [])
      : Array.isArray(prev.rules) ? prev.rules : [],
    updatedAt: Date.now(),
  }
}

/** The persona block injected into the system prompt. */
export function personalityText(personality) {
  const lines = ['## 人格设定（由 DSH Personality 插件提供，始终遵守）']
  if (personality.name) lines.push('名字：' + personality.name)
  if (personality.identity) lines.push('身份：' + personality.identity)
  if (personality.style) lines.push('表达风格：' + personality.style)
  if (personality.rules.length > 0) {
    lines.push('行为准则：')
    for (const rule of personality.rules) lines.push('- ' + rule)
  }
  return lines.join('\n')
}

function safeJsonSync(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const text = readFileSync(file, 'utf8')
    if (text.trim() === '') return fallback
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeJsonSync(file, value, logger) {
  try {
    const body = JSON.stringify(value, null, 2) + '\n'
    const temp = file + '.tmp'
    writeFileSync(temp, body, 'utf8')
    renameSync(temp, file)
    return true
  } catch (error) {
    logger?.warn?.('dsh-personality: failed to write %s: %s', file, error?.message ?? error)
    return false
  }
}

/**
 * Create the store bound to one data directory.
 * @param {{ dir: string, limits: { maxSessions: number, maxMemories: number }, logger?: object }} options
 */
export function createStore({ dir, limits, logger }) {
  const personalityPath = path.join(dir, PERSONALITY_FILE)
  const memoryPath = path.join(dir, MEMORY_FILE)

  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    logger?.warn?.('dsh-personality: cannot create data directory %s: %s', dir, error?.message ?? error)
  }

  let personality = null
  let memory = null
  let sessionCount = 0
  let memoryCount = 0

  function loadPersonality() {
    const raw = safeJsonSync(personalityPath, null)
    personality = raw === null
      ? { ...DEFAULT_PERSONALITY, updatedAt: Date.now() }
      : normalizePersonality(raw, DEFAULT_PERSONALITY)
    if (raw === null) writeJsonSync(personalityPath, personality, logger)
    return personality
  }

  function loadMemory() {
    const raw = safeJsonSync(memoryPath, null)
    const sessions = {}
    const rawSessions = raw?.sessions !== null && typeof raw?.sessions === 'object' ? raw.sessions : {}
    for (const [id, record] of Object.entries(rawSessions)) {
      if (record === null || typeof record !== 'object') continue
      sessions[id] = {
        sessionId: id,
        title: asTitle(record.title, 120, '(未命名会话)'),
        summary: asText(record.summary, 4000, ''),
        keyPoints: asStringList(record.keyPoints),
        topics: asStringList(record.topics),
        createdAt: Number.isFinite(record.createdAt) ? record.createdAt : 0,
        eventCount: Number.isFinite(record.eventCount) ? record.eventCount : 0,
        summarizedAt: Number.isFinite(record.summarizedAt) ? record.summarizedAt : 0,
      }
    }
    const memories = []
    const rawMemories = Array.isArray(raw?.memories) ? raw.memories : []
    for (const record of rawMemories) {
      if (record === null || typeof record !== 'object') continue
      const content = asText(record.content, 600, '').trim()
      if (content === '') continue
      memories.push({
        id: typeof record.id === 'string' ? record.id : 'm-' + memories.length,
        type: typeof record.type === 'string' ? record.type : 'episodic',
        content,
        sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
        createdAt: Number.isFinite(record.createdAt) ? record.createdAt : 0,
      })
    }
    memory = {
      version: STORE_VERSION,
      updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : 0,
      sessions,
      memories,
    }
    sessionCount = Object.keys(sessions).length
    memoryCount = memories.length
    return memory
  }

  function trimMemory() {
    if (memory === null) return
    const entries = Object.entries(memory.sessions)
    if (entries.length > limits.maxSessions) {
      entries.sort((a, b) => (b[1].summarizedAt ?? 0) - (a[1].summarizedAt ?? 0))
      for (const [id] of entries.slice(limits.maxSessions)) delete memory.sessions[id]
    }
    if (memory.memories.length > limits.maxMemories) {
      memory.memories = memory.memories.slice(0, limits.maxMemories)
    }
    sessionCount = Object.keys(memory.sessions).length
    memoryCount = memory.memories.length
  }

  function persistMemory() {
    if (memory === null) return false
    memory.updatedAt = Date.now()
    trimMemory()
    return writeJsonSync(memoryPath, memory, logger)
  }

  loadPersonality()
  loadMemory()

  return {
    dir,
    personalityPath,
    memoryPath,

    getPersonality() {
      return personality ?? loadPersonality()
    },

    /** Save a partial persona patch; returns the normalized result. */
    savePersonality(patch) {
      const next = normalizePersonality({ ...this.getPersonality(), ...(patch ?? {}) }, this.getPersonality())
      if (next.name === null || next.name === '') next.name = DEFAULT_PERSONALITY.name
      personality = next
      const ok = writeJsonSync(personalityPath, next, logger)
      if (!ok) throw new Error('cannot write ' + personalityPath)
      return next
    },

    applyPreset(presetId) {
      const preset = PRESETS.find((item) => item.id === presetId)
      if (preset === undefined) throw new Error('unknown preset: ' + String(presetId))
      const next = normalizePersonality(preset.personality, DEFAULT_PERSONALITY)
      personality = next
      const ok = writeJsonSync(personalityPath, next, logger)
      if (!ok) throw new Error('cannot write ' + personalityPath)
      return next
    },

    reload() {
      loadPersonality()
      loadMemory()
      return this.getPersonality()
    },

    personaText() {
      return personalityText(this.getPersonality())
    },

    getMemory() {
      return memory ?? loadMemory()
    },

    stats() {
      const sessions = Object.values(this.getMemory().sessions)
      let lastSummarizedAt = 0
      for (const record of sessions) {
        if (record.summarizedAt > lastSummarizedAt) lastSummarizedAt = record.summarizedAt
      }
      return {
        dataDir: dir,
        sessionCount: sessionCount,
        memoryCount: memoryCount,
        lastSummarizedAt: lastSummarizedAt,
      }
    },

    /** Newest-first list of stored session summaries. */
    listSessions(limit = 50) {
      const all = Object.values(this.getMemory().sessions)
      all.sort((a, b) => (b.summarizedAt || b.createdAt) - (a.summarizedAt || a.createdAt))
      return all.slice(0, Math.max(0, limit))
    },

    listMemories(limit = 50) {
      return this.getMemory().memories.slice(0, Math.max(0, limit))
    },

    /**
     * Merge one summarized session, replacing its previous record and its
     * derived memories. Never throws: a failed write only reports false.
     */
    upsertSession(record) {
      const memoryState = this.getMemory()
      const id = String(record.sessionId ?? '')
      if (id === '') throw new Error('upsertSession requires a sessionId')
      const previous = memoryState.sessions[id]
      const next = {
        sessionId: id,
        title: asTitle(record.title, 120, previous?.title ?? '(未命名会话)'),
        summary: asText(record.summary, 4000, previous?.summary ?? ''),
        keyPoints: asStringList(record.keyPoints),
        topics: asStringList(record.topics),
        createdAt: Number.isFinite(record.createdAt) ? record.createdAt : (previous?.createdAt ?? 0),
        eventCount: Number.isFinite(record.eventCount) ? record.eventCount : (previous?.eventCount ?? 0),
        summarizedAt: Date.now(),
      }
      memoryState.sessions[id] = next
      // Its derived memories are replaced, so re-summarizing is not additive.
      memoryState.memories = memoryState.memories.filter((item) => item.sessionId !== id)
      const fresh = next.keyPoints.slice(0, 8).map((point, index) => ({
        id: id + ':' + index,
        type: 'episodic',
        content: point.slice(0, 600),
        sessionId: id,
        createdAt: next.summarizedAt,
      }))
      memoryState.memories = [...fresh, ...memoryState.memories].slice(0, limits.maxMemories)
      persistMemory()
      return next
    },

    clearMemory() {
      const memoryState = this.getMemory()
      const cleared = Object.keys(memoryState.sessions).length + memoryState.memories.length
      memoryState.sessions = {}
      memoryState.memories = []
      sessionCount = 0
      memoryCount = 0
      persistMemory()
      return cleared
    },

    /**
     * Long-term recall block for the runtime-context snapshot: recent session
     * summaries plus distilled memory lines, bounded so it never eats the
     * conversation budget.
     */
    recallText(maxChars) {
      const memoryState = this.getMemory()
      const sessions = Object.values(memoryState.sessions)
      sessions.sort((a, b) => (b.summarizedAt || b.createdAt) - (a.summarizedAt || a.createdAt))
      const blocks = []
      for (const record of sessions) {
        if (record.summary.trim() === '' && record.keyPoints.length === 0) continue
        const head = '### ' + record.title
        const parts = [head]
        if (record.summary.trim() !== '') parts.push(record.summary.trim())
        if (record.keyPoints.length > 0) parts.push('要点：' + record.keyPoints.join('；'))
        blocks.push(parts.join('\n'))
        if (blocks.length >= 8) break
      }
      if (memoryState.memories.length > 0) {
        const lines = memoryState.memories.slice(0, 24).map((item) => '- ' + item.content)
        blocks.push('### 长期记忆条目\n' + lines.join('\n'))
      }
      if (blocks.length === 0) return ''
      const body = blocks.join('\n\n')
      const header = '## 长期记忆（来自历史会话总结，作为参考信息，若与当前事实冲突以当前对话为准）\n'
      const text = header + body
      return text.length > maxChars ? text.slice(0, Math.max(0, maxChars - 12)) + '\n… [截断]' : text
    },
  }
}
