/**
 * dsh-personality — host half.
 *
 * Three contributions, all driven by two small JSON files under the data
 * directory (see lib/store.js):
 *
 *   persona  -> one stable system-prompt section, so every turn is generated
 *               with the personality the user configured in Settings.
 *   recall   -> one runtime-context snapshot built from the stored session
 *               summaries, superseded per request so it never accumulates.
 *   archive  -> a summarizer that reads stored conversation logs, asks the
 *               configured model for one strict-JSON summary per session, and
 *               merges it back into memory.json.
 *
 * The same operations are exposed twice, as the plugin conventions require:
 * model-facing tools (personality_*) and the Settings page's HTTP endpoints
 * under /dsh-personality/api. Both call the same store and summarizer.
 *
 * No Harness package is imported: every capability comes from `ctx` services,
 * so the bundle works from a linked local checkout as well as from npm.
 *
 * @module dsh-personality
 */

import os from 'node:os'
import path from 'node:path'
import { PRESETS, createStore } from './lib/store.js'
import { createSummarizer } from './lib/summarize.js'

export const name = 'dsh-personality'

/** Services this plugin builds on; all ship in every dsh-base composition. */
export const inject = ['systemPrompt', 'tools', 'llm']

const ROUTE_PATH = '/dsh-personality/api'
const MAX_BODY_BYTES = 64 * 1024

/** Persona order: the harness identity sits at -100, so -50 renders after it. */
const PERSONA_ORDER = -50
/** Runtime-context order for recall; positive values follow the conversation. */
const RECALL_ORDER = 11

function resolveLogger(ctx) {
  const base = typeof ctx?.logger === 'function' ? ctx.logger(name) : ctx?.logger
  const fallback = (level) => (message, ...args) => {
    const line = '[dsh-personality] ' + message
    if (level === 'warn') console.warn(line, ...args)
    else if (level === 'error') console.error(line, ...args)
  }
  const pick = (level) => {
    const fn = base?.[level]
    return typeof fn === 'function' ? fn.bind(base) : fallback(level)
  }
  return { debug: () => {}, info: pick('info'), warn: pick('warn'), error: pick('error') }
}

function asPositiveInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback
}

function resolveConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  const dataDir = typeof raw.dataDir === 'string' && raw.dataDir.trim() !== ''
    ? path.resolve(raw.dataDir)
    : path.join(home, 'dsh-personality')
  const model = raw.model !== null && typeof raw.model === 'object' ? raw.model : {}
  const memory = raw.memory !== null && typeof raw.memory === 'object' ? raw.memory : {}
  const personality = raw.personality !== null && typeof raw.personality === 'object' ? raw.personality : {}
  return {
    enabled: raw.enabled !== false,
    dataDir,
    model: {
      provider: typeof model.provider === 'string' ? model.provider : '',
      model: typeof model.model === 'string' ? model.model : '',
      maxTokens: asPositiveInt(model.maxTokens, 4000),
    },
    injectPersona: personality.inject !== false,
    injectRecall: memory.inject !== false,
    injectChars: asPositiveInt(memory.injectChars, 2400),
    maxSessions: asPositiveInt(memory.maxSessions, 200),
    maxMemories: asPositiveInt(memory.maxMemories, 200),
    autoSummarize: memory.autoSummarize === true,
    autoEveryTurns: asPositiveInt(memory.autoEveryTurns, 5),
    transcriptChars: asPositiveInt(memory.transcriptChars, 9000),
  }
}

function sendJson(res, status, payload) {
  if (typeof res?.writeHead === 'function') {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(body.length),
    })
    res.end(body)
    return
  }
  // Fallback for a response stub without the node API.
  if (typeof res?.setHeader === 'function') res.statusCode = status
  res?.end?.(JSON.stringify(payload))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body exceeds ' + MAX_BODY_BYTES + ' bytes'))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => reject(error))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
  })
}

/** Model route: explicit config, then the live default selection, then the shipped route. */
function currentRoute(ctx, cfg) {
  if (cfg.model.provider !== '' && cfg.model.model !== '') {
    return { provider: cfg.model.provider, model: cfg.model.model }
  }
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : ctx.agentDefaultModel
    const selection = service?.currentSelection?.()
    if (typeof selection?.provider === 'string' && selection.provider !== ''
      && typeof selection?.model === 'string' && selection.model !== '') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* fall through to the shipped default */
  }
  return { provider: 'deepseek-account', model: 'deepseek-flash' }
}

/** One-shot auxiliary model call over the harness LLM service. */
function createModelCaller(ctx, cfg, logger) {
  return async (system, user, signal) => {
    const route = currentRoute(ctx, cfg)
    const request = {
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      temperature: 0.2,
      maxTokens: cfg.model.maxTokens,
    }
    if (signal !== undefined) request.signal = signal
    let text = ''
    let finish = null
    try {
      for await (const chunk of ctx.llm.stream(request)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk?.type === 'finish') finish = chunk.reason ?? null
      }
    } catch (error) {
      throw new Error('model call to ' + route.provider + '/' + route.model + ' failed: ' + (error?.message ?? error))
    }
    if (finish !== null && finish.kind !== 'stop') {
      const detail = finish.failure?.message !== undefined ? ': ' + finish.failure.message : ''
      throw new Error('model call ended with ' + finish.kind + detail
        + (finish.kind === 'max-tokens' ? '（可提高 memory.maxTokens 或重试）' : ''))
    }
    if (text.trim() === '') throw new Error('model call produced no text')
    logger.debug('dsh-personality: summarized via %s/%s', route.provider, route.model)
    return text
  }
}

const textRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

function registerTools(ctx, { cfg, store, summarizer, logger }) {
  const statusOf = () => {
    const stats = store.stats()
    return {
      enabled: cfg.enabled,
      personality: store.getPersonality(),
      presets: PRESETS.map((preset) => ({ id: preset.id, label: preset.label, hint: preset.hint })),
      stats: {
        dataDir: stats.dataDir,
        sessionSummaries: stats.sessionCount,
        memories: stats.memoryCount,
        lastSummarizedAt: stats.lastSummarizedAt,
      },
    }
  }

  ctx.tools.register({
    name: 'personality_status',
    description: 'Report the DSH Personality plugin state: the current persona fields, the available presets, the data directory, and how many session summaries and long-term memories are stored.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: textRender },
    async execute() {
      try {
        return statusOf()
      } catch (error) {
        throw new Error('personality_status failed: ' + (error?.message ?? error))
      }
    },
  })

  ctx.tools.register({
    name: 'personality_set',
    description: 'Replace fields of the DSH Personality persona (name, identity, style, behavior rules). Omitted fields keep their current value. Takes effect on the next model step.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short display name of the persona.' },
        identity: { type: 'string', description: 'Who the assistant is, in one or two sentences.' },
        style: { type: 'string', description: 'How it expresses itself: tone, length, formatting habits.' },
        rules: {
          type: 'array',
          items: { type: 'string' },
          description: 'Behavior rules, one imperative sentence each. Replaces the whole list.',
        },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: textRender },
    async execute(args) {
      try {
        const personality = store.savePersonality(args ?? {})
        logger.info('dsh-personality: persona updated through tool')
        return { ok: true, personality }
      } catch (error) {
        throw new Error('personality_set failed: ' + (error?.message ?? error))
      }
    },
  })

  ctx.tools.register({
    name: 'personality_preset',
    description: 'Apply one built-in persona preset (quick personality switch). Use personality_status to see the available preset ids.',
    parameters: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: PRESETS.map((preset) => preset.id), description: 'Preset id to apply.' },
      },
      required: ['preset'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: textRender },
    async execute(args) {
      try {
        const personality = store.applyPreset(String(args?.preset ?? ''))
        logger.info('dsh-personality: preset %s applied', args?.preset)
        return { ok: true, personality }
      } catch (error) {
        throw new Error('personality_preset failed: ' + (error?.message ?? error))
      }
    },
  })

  ctx.tools.register({
    name: 'personality_summarize',
    description: 'Read stored conversation history (durable session logs plus live sessions), summarize the newest changed sessions into JSON memory through the configured model, and store the result in memory.json.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Maximum number of sessions to summarize this run, 1-50. Default 8.' },
        force: { type: 'boolean', description: 'Re-summarize sessions even when their event count is unchanged.' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: textRender },
    async execute(args, exec) {
      try {
        const result = await summarizer.run({
          limit: Number(args?.limit) || 8,
          force: args?.force === true,
          signal: exec?.signal,
        })
        return { ok: true, ...result, stats: store.stats() }
      } catch (error) {
        throw new Error('personality_summarize failed: ' + (error?.message ?? error))
      }
    },
  })

  ctx.tools.register({
    name: 'personality_memory',
    description: 'List or clear the long-term memory built from conversation summaries. Listing returns the newest session summaries and memory entries; clearing removes both but keeps the persona.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'clear'], description: 'list recent memory, or clear all of it.' },
        limit: { type: 'integer', description: 'Maximum entries to list, 1-50. Default 20.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: textRender },
    async execute(args) {
      try {
        const action = String(args?.action ?? 'list')
        if (action === 'clear') {
          const cleared = store.clearMemory()
          logger.info('dsh-personality: memory cleared (%d entries)', cleared)
          return { ok: true, cleared, stats: store.stats() }
        }
        const limit = Math.min(50, Math.max(1, Math.round(Number(args?.limit) || 20)))
        return {
          ok: true,
          sessions: store.listSessions(limit),
          memories: store.listMemories(limit),
          stats: store.stats(),
        }
      } catch (error) {
        throw new Error('personality_memory failed: ' + (error?.message ?? error))
      }
    },
  })
}

function createHttpHandler({ cfg, store, summarizer, logger }) {
  const statePayload = () => {
    const stats = store.stats()
    return {
      ok: true,
      enabled: cfg.enabled,
      personality: store.getPersonality(),
      presets: PRESETS.map((preset) => ({
        id: preset.id,
        label: preset.label,
        labelEn: preset.labelEn,
        hint: preset.hint,
        hintEn: preset.hintEn,
      })),
      stats: {
        dataDir: stats.dataDir,
        sessionSummaries: stats.sessionCount,
        memories: stats.memoryCount,
        lastSummarizedAt: stats.lastSummarizedAt,
      },
      sessions: store.listSessions(20),
      memories: store.listMemories(20),
    }
  }

  return async function handle(req, res) {
    const method = String(req?.method ?? 'GET').toUpperCase()
    let pathname = '/'
    try {
      pathname = new URL(String(req?.url ?? '/'), 'http://127.0.0.1').pathname.replace(/\/+$/, '')
    } catch {
      pathname = '/'
    }
    try {
      if (pathname === ROUTE_PATH + '/state') {
        if (method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        sendJson(res, 200, statePayload())
        return
      }
      if (pathname === ROUTE_PATH + '/personality') {
        if (method !== 'POST' && method !== 'PUT') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req)
        const personality = store.savePersonality(body)
        logger.info('dsh-personality: persona saved from settings page')
        sendJson(res, 200, { ok: true, personality, state: statePayload() })
        return
      }
      if (pathname === ROUTE_PATH + '/preset') {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req)
        const personality = store.applyPreset(String(body.preset ?? ''))
        sendJson(res, 200, { ok: true, personality, state: statePayload() })
        return
      }
      if (pathname === ROUTE_PATH + '/summarize') {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req)
        const result = await summarizer.run({
          limit: Number(body.limit) || 8,
          force: body.force === true,
        })
        sendJson(res, 200, { ok: true, ...result, state: statePayload() })
        return
      }
      if (pathname === ROUTE_PATH + '/memory/clear') {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const cleared = store.clearMemory()
        sendJson(res, 200, { ok: true, cleared, state: statePayload() })
        return
      }
      if (pathname === ROUTE_PATH + '/reload') {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        store.reload()
        sendJson(res, 200, { ok: true, state: statePayload() })
        return
      }
      sendJson(res, 404, { ok: false, error: 'unknown endpoint: ' + pathname })
    } catch (error) {
      const message = error?.message ?? String(error)
      logger.warn('dsh-personality: request %s %s failed: %s', method, pathname, message)
      sendJson(res, 400, { ok: false, error: message })
    }
  }
}

/**
 * Plugin activation.
 * @param ctx - cordis plugin context.
 * @param config - loader config object (optional; every key has a default).
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const logger = resolveLogger(ctx)

  if (!cfg.enabled) {
    logger.info('dsh-personality is disabled by configuration')
    return
  }

  const store = createStore({
    dir: cfg.dataDir,
    limits: { maxSessions: cfg.maxSessions, maxMemories: cfg.maxMemories },
    logger,
  })
  const summarizer = createSummarizer({
    ctx,
    store,
    callModel: createModelCaller(ctx, cfg, logger),
    logger,
    transcriptChars: cfg.transcriptChars,
  })

  if (cfg.injectPersona) {
    ctx.systemPrompt.section({
      name: 'dsh-personality:persona',
      order: PERSONA_ORDER,
      text: () => store.personaText(),
    })
  }

  if (cfg.injectRecall) {
    ctx.systemPrompt.context({
      name: 'dsh-personality:recall',
      order: RECALL_ORDER,
      text: () => store.recallText(cfg.injectChars),
    })
  }

  registerTools(ctx, { cfg, store, summarizer, logger })

  // Optional auto-archive: every N finished turns, fold the newest grown
  // sessions into memory. Off unless memory.autoSummarize is enabled.
  if (cfg.autoSummarize) {
    const pendingTurns = new Map()
    ctx.on('session/event', (session, event) => {
      try {
        if (event?.type !== 'turn/end') return
        const id = String(session?.id ?? '')
        if (id === '') return
        const turns = (pendingTurns.get(id) ?? 0) + 1
        if (turns < cfg.autoEveryTurns) {
          pendingTurns.set(id, turns)
          return
        }
        pendingTurns.set(id, 0)
        void summarizer.run({ limit: 3 }).catch((error) => {
          logger.warn('dsh-personality: auto summarize failed: %s', error?.message ?? error)
        })
      } catch (error) {
        logger.warn('dsh-personality: turn hook failed: %s', error?.message ?? error)
      }
    })
  }

  const handler = createHttpHandler({ cfg, store, summarizer, logger })
  const route = { kind: 'prefix', path: ROUTE_PATH, handler }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scoped) => scoped.webServer.register(route))
    } else if (ctx.webServer !== undefined && typeof ctx.webServer.register === 'function') {
      ctx.webServer.register(route)
    } else {
      logger.info('dsh-personality: no web server in this profile; settings endpoints are unavailable')
    }
  } catch (error) {
    logger.warn('dsh-personality: cannot register settings endpoints: %s', error?.message ?? error)
  }

  const stats = store.stats()
  logger.info(
    'dsh-personality ready (data: %s, summaries: %d, memories: %d, auto: %s)',
    stats.dataDir,
    stats.sessionCount,
    stats.memoryCount,
    cfg.autoSummarize ? 'on' : 'off',
  )
}
