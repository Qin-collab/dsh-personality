import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore, PRESETS, DEFAULT_PERSONALITY, normalizePersonality } from '../lib/store.js'
import { createSummarizer } from '../lib/summarize.js'

const failures = []
function check(label, condition, detail) {
  if (condition) console.log('  ok   ' + label)
  else {
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail)))
    failures.push(label)
  }
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'dshp-test-'))
console.log('data dir: ' + dir)

// ── store ────────────────────────────────────────────────────────────────
const store = createStore({ dir, limits: { maxSessions: 3, maxMemories: 5 }, logger: {} })
check('defaults load', store.getPersonality().name === DEFAULT_PERSONALITY.name)
const written = JSON.parse(readFileSync(path.join(dir, 'personality.json'), 'utf8'))
check('personality.json written on first run', typeof written.rules === 'object')

const saved = store.savePersonality({ name: '小D', rules: ['  先给结论  ', '', 42] })
check('patch keeps other fields', saved.identity === DEFAULT_PERSONALITY.identity, saved.identity)
check('rules normalized', saved.rules.length === 1 && saved.rules[0] === '先给结论', saved.rules)
check('empty name keeps previous', store.savePersonality({ name: '' }).name === '小D')

const preset = store.applyPreset('sharp')
check('preset applied', preset.style.includes('犀利'), preset.style)
check('preset persisted', JSON.parse(readFileSync(path.join(dir, 'personality.json'), 'utf8')).name === preset.name)

check('personaText carries rules', store.personaText().includes('行为准则'))
check('recall empty at first', store.recallText(2000) === '')

store.upsertSession({ sessionId: 's1', title: '插件开发', summary: '用户想要一个插件。', keyPoints: ['要点一', '要点二'], topics: ['dsh'], createdAt: 1, eventCount: 10 })
store.upsertSession({ sessionId: 's1', title: '插件开发', summary: '用户想要一个插件（修订）。', keyPoints: ['要点一'], topics: ['dsh'], createdAt: 1, eventCount: 12 })
let memory = store.getMemory()
check('upsert replaces, not appends', Object.keys(memory.sessions).length === 1)
check('derived memories replaced', memory.memories.length === 1, memory.memories)
const recall = store.recallText(2000)
check('recall has summary', recall.includes('修订'), recall)
check('recall has header', recall.startsWith('## 长期记忆'))

for (let i = 0; i < 6; i++) store.upsertSession({ sessionId: 's' + i + 10, title: 't' + i, summary: 'x', keyPoints: [], topics: [], createdAt: i, eventCount: 1 })
memory = store.getMemory()
check('maxSessions trims', Object.keys(memory.sessions).length <= 3, Object.keys(memory.sessions).length)

const cleared = store.clearMemory()
check('clear reports count', cleared > 0, cleared)
check('clear empties', store.getMemory().memories.length === 0 && Object.keys(store.getMemory().sessions).length === 0)

check('unknown preset throws', (() => { try { store.applyPreset('nope'); return false } catch { return true } })())
check('all presets valid', PRESETS.every((p) => normalizePersonality(p.personality, DEFAULT_PERSONALITY).rules.length > 0))

// ── summarizer ───────────────────────────────────────────────────────────
const events = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我做个 DSH 插件，能改人格' }] } },
  { type: 'user/message', data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: '注入的上下文不应被总结' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的，计划是：1 写 Host 2 写 UI' }] } } },
  { type: 'tool/call', data: { name: 'write' } },
  { type: 'turn/end', data: { turn: 1 } },
]
const fakeCtx = {
  get(service) {
    if (service === 'sessions') {
      return { list: () => [{ id: 'session-live', header: { createdAt: 1700000000000 }, snapshotEvents: () => events }] }
    }
    if (service === 'sessionPersistence') {
      return {
        list: async () => [
          { header: { id: 'session-old', createdAt: 1600000000000 }, revision: 1, eventCount: 2, formatStatus: 'current' },
        ],
        open: async (id) => ({
          id,
          read: async () => ({ events: [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '旧会话' }] } }] }),
          close: async () => {},
        }),
      }
    }
    return undefined
  },
}

let calls = 0
const transcripts = []
const summarizer = createSummarizer({
  ctx: fakeCtx,
  store,
  logger: console,
  callModel: async (system, user) => {
    calls += 1
    transcripts.push(user)
    if (calls === 1) return '```json\n{"title":"插件开发","summary":"用户要一个可改人格的 DSH 插件。","keyPoints":["Host 与 UI 分开"],"topics":["dsh","插件"]}\n```'
    return '模型抽风了，不是 JSON'
  },
})
const lastUser = () => transcripts[transcripts.length - 1]

const result = await summarizer.run({ limit: 5 })
check('two candidates read', result.scanned === 2, result.scanned)
check('one summarized', result.summarized === 1, result)
check('one failed on bad JSON', result.failed === 1, result.errors)
check('plugin-sourced user text skipped', !transcripts[0].includes('注入的上下文'), transcripts[0].slice(0, 120))
check('transcript has both sides', transcripts[0].includes('用户：') && transcripts[0].includes('助手：'), transcripts[0])
const stored = store.listSessions(5)
check('stored summary', stored.length === 1 && stored[0].summary.includes('可改人格'), stored)
check('stored eventCount', stored[0].eventCount === 6, stored[0].eventCount)
check('recall now populated', store.recallText(2000).includes('可改人格'))

const second = await summarizer.run({ limit: 5 })
check('unchanged session skipped on rerun', second.summarized === 0 && second.targeted === 1, second)
const forced = await summarizer.run({ limit: 5, force: true })
check('force re-runs', forced.targeted === 2, forced.targeted)

rmSync(dir, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures.join(', '))
process.exitCode = failures.length === 0 ? 0 : 1
