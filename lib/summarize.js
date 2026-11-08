/**
 * dsh-personality — conversation-history summarization.
 *
 * Reads stored sessions (durable session logs plus live sessions), keeps only
 * plain user/assistant text, asks the configured model for one strict-JSON
 * summary per session, and merges the result into memory.json through the
 * store. Runs are single-flight and sequential: one slow model call at a time,
 * never concurrent store writes.
 */

const MAX_MESSAGE_CHARS = 2000
const DEFAULT_TRANSCRIPT_CHARS = 9000

const SUMMARY_SYSTEM = [
  '你是一个对话归档器：把一段用户与 AI 助手的历史对话压缩成结构化 JSON 记忆，供以后检索和回忆。',
  '只输出 JSON 本体，不要 markdown 代码块，不要任何解释文字。',
  'JSON 结构：',
  '{"title": "不超过 20 字的会话标题", "summary": "3-6 句中文摘要：用户想做什么、过程如何、结论或产出是什么", "keyPoints": ["不超过 5 条要点，每条不超过 60 字"], "topics": ["不超过 6 个关键词"]}',
  '如果对话几乎没有实质信息（只有问候、报错重试或空内容），输出：{"title":"","summary":"","keyPoints":[],"topics":[]}',
].join('\n')

function blocksText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function extractTurns(events) {
  const turns = []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'user/message') {
      const message = event.data
      if (message?.source?.kind !== 'user') continue
      const text = blocksText(message.content)
      if (text !== '') turns.push({ role: 'user', text: text.slice(0, MAX_MESSAGE_CHARS) })
    } else if (event.type === 'assistant/message') {
      const text = blocksText(event.data?.message?.content)
      if (text !== '') turns.push({ role: 'assistant', text: text.slice(0, MAX_MESSAGE_CHARS) })
    }
  }
  return turns
}

/** Head + tail transcript so the opening intent and the final result both survive. */
function buildTranscript(turns, budget) {
  if (turns.length === 0) return ''
  const label = (turn) => (turn.role === 'user' ? '用户' : '助手') + '：' + turn.text
  const head = []
  let used = 0
  let start = 0
  for (; start < turns.length && start < 2; start++) {
    const line = label(turns[start])
    head.push(line)
    used += line.length
  }
  const tail = []
  for (let index = turns.length - 1; index >= start; index--) {
    const line = label(turns[index])
    if (used + line.length > budget) break
    tail.unshift(line)
    used += line.length
  }
  const omitted = turns.length - start - tail.length
  const middle = omitted > 0 ? ['…（省略 ' + omitted + ' 条消息）'] : []
  return [...head, ...middle, ...tail].join('\n')
}

function parseSummaryJson(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') throw new Error('model returned no text')
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const attempts = [unfenced]
  const first = unfenced.indexOf('{')
  const last = unfenced.lastIndexOf('}')
  if (first >= 0 && last > first) attempts.push(unfenced.slice(first, last + 1))
  let lastError = null
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt)
      if (parsed !== null && typeof parsed === 'object') return parsed
    } catch (error) {
      lastError = error
    }
  }
  throw new Error('model output was not valid JSON' + (lastError === null ? '' : ': ' + lastError.message))
}

function asString(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function asStringList(value, maxItems, maxLen) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const text = asString(item, maxLen)
    if (text === '') continue
    out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}

/**
 * @param {{
 *   ctx: object,
 *   store: object,
 *   callModel: (system: string, user: string, signal?: AbortSignal) => Promise<string>,
 *   logger?: object,
 *   transcriptChars?: number,
 * }} options
 */
export function createSummarizer({ ctx, store, callModel, logger, transcriptChars }) {
  const budget = Number.isFinite(transcriptChars) && transcriptChars > 500 ? transcriptChars : DEFAULT_TRANSCRIPT_CHARS
  let running = null

  function getService(name) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
    } catch {
      return undefined
    }
  }

  /** Live sessions first (freshest events), then durable logs. */
  async function collectSessions(signal) {
    const found = new Map()
    const sessions = getService('sessions')
    if (sessions !== undefined && typeof sessions.list === 'function') {
      for (const session of sessions.list()) {
        if (session === null || typeof session !== 'object') continue
        let events = []
        try {
          events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
        } catch {
          events = []
        }
        found.set(String(session.id), {
          sessionId: String(session.id),
          createdAt: Number(session.header?.createdAt) || 0,
          eventCount: Array.isArray(events) ? events.length : 0,
          events: Array.isArray(events) ? events : [],
        })
      }
    }
    const persistence = getService('sessionPersistence')
    if (persistence !== undefined && typeof persistence.list === 'function') {
      let snapshots = []
      try {
        snapshots = await persistence.list(signal === undefined ? {} : { signal })
      } catch (error) {
        logger?.warn?.('dsh-personality: cannot list stored sessions: %s', error?.message ?? error)
      }
      for (const snapshot of snapshots) {
        const id = String(snapshot?.header?.id ?? '')
        if (id === '' || found.has(id)) continue
        if (snapshot.formatStatus !== undefined && snapshot.formatStatus !== 'current') continue
        let handle
        try {
          handle = await persistence.open(id, 'read', signal === undefined ? {} : { signal })
          const length = Number.isFinite(snapshot.eventCount) ? snapshot.eventCount : undefined
          const result = length === undefined ? await handle.read(0) : await handle.read(0, length)
          found.set(id, {
            sessionId: id,
            createdAt: Number(snapshot.header?.createdAt) || 0,
            eventCount: Array.isArray(result?.events) ? result.events.length : 0,
            events: Array.isArray(result?.events) ? result.events : [],
          })
        } catch (error) {
          logger?.warn?.('dsh-personality: cannot read session %s: %s', id, error?.message ?? error)
        } finally {
          if (handle !== undefined) {
            try {
              await handle.close()
            } catch {
              /* closing a read handle cannot fail meaningfully */
            }
          }
        }
      }
    }
    return [...found.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  async function summarizeOne(candidate, signal) {
    const turns = extractTurns(candidate.events)
    if (turns.length === 0) return { skipped: true, reason: 'empty' }
    const transcript = buildTranscript(turns, budget)
    if (transcript.trim() === '') return { skipped: true, reason: 'empty' }
    const when = candidate.createdAt > 0 ? new Date(candidate.createdAt).toISOString() : 'unknown'
    const user = '会话创建时间：' + when + '\n消息数：' + turns.length + '\n\n<对话>\n' + transcript + '\n</对话>'
    const raw = await callModel(SUMMARY_SYSTEM, user, signal)
    const parsed = parseSummaryJson(raw)
    const summary = asString(parsed.summary, 4000)
    const title = asString(parsed.title, 120)
    const keyPoints = asStringList(parsed.keyPoints, 5, 200)
    const topics = asStringList(parsed.topics, 6, 40)
    if (summary === '' && keyPoints.length === 0) return { skipped: true, reason: 'empty-summary' }
    const record = store.upsertSession({
      sessionId: candidate.sessionId,
      title: title === '' ? '(未命名会话)' : title,
      summary,
      keyPoints,
      topics,
      createdAt: candidate.createdAt,
      eventCount: candidate.eventCount,
    })
    return { skipped: false, record }
  }

  async function run({ limit = 8, force = false, signal } = {}) {
    if (running !== null) return running
    running = (async () => {
      const capped = Math.min(50, Math.max(1, Math.round(Number(limit) || 8)))
      const candidates = await collectSessions(signal)
      const known = new Map(Object.entries(store.getMemory().sessions))
      const pending = []
      for (const candidate of candidates) {
        const previous = known.get(candidate.sessionId)
        if (previous !== undefined && force !== true && previous.eventCount === candidate.eventCount) continue
        pending.push(candidate)
        if (pending.length >= capped) break
      }
      const result = { scanned: candidates.length, targeted: pending.length, summarized: 0, skipped: 0, failed: 0, errors: [] }
      for (const candidate of pending) {
        if (signal?.aborted === true) break
        try {
          const outcome = await summarizeOne(candidate, signal)
          if (outcome.skipped === true) result.skipped += 1
          else result.summarized += 1
        } catch (error) {
          result.failed += 1
          const message = error?.message ?? String(error)
          result.errors.push({ sessionId: candidate.sessionId, message })
          logger?.warn?.('dsh-personality: summarize %s failed: %s', candidate.sessionId, message)
        }
      }
      return result
    })()
    try {
      return await running
    } finally {
      running = null
    }
  }

  return { run }
}
