/**
 * Offline render probe for client.js: fakes the browser module loader and the
 * React hooks, then renders the settings section with empty and loaded state.
 * Any render-time exception shows up here with a stack instead of a blank page.
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let moduleRecord = null
globalThis.window = {
  __ModuleLoader__: {
    load(record) {
      moduleRecord = record
    },
  },
}
const probeNavigator = { language: 'zh-CN' }

let stateQueue = []
let stateIndex = 0
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
  },
  useState(initial) {
    const index = stateIndex++
    const value = stateQueue[index] !== undefined ? stateQueue[index] : (typeof initial === 'function' ? initial() : initial)
    return [value, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
  useRef(value) {
    return { current: value }
  },
  Component: class Component {
    constructor(props) {
      this.props = props
    }
    setState() {}
  },
}

const fakeRequire = (name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected module: ' + name)
}

// Evaluate client.js with the fake globals in scope.
const evaluate = new Function('window', 'require', 'navigator', source)
evaluate(globalThis.window, fakeRequire, probeNavigator)

if (moduleRecord === null) throw new Error('client.js never called __ModuleLoader__.load')
console.log('module id: ' + moduleRecord.id)

const component = moduleRecord.factory(fakeRequire)

let registered = null
const fakeCtx = {
  slots: {
    inject(key, callback) {
      console.log('slot inject: ' + key)
      return callback()
    },
    register(options, Comp) {
      registered = { options, Comp }
      console.log('register: ' + JSON.stringify({ id: options.id, order: options.order, name: options.name }))
      return () => {}
    },
  },
  locale: {
    register() {},
    getLocale: () => ({ id: 'zh' }),
    subscribe: () => () => {},
  },
}

component.apply(fakeCtx)
if (registered === null) throw new Error('no slot registration happened')
console.log('label(): ' + registered.options.label())

const loadedState = {
  ok: true,
  enabled: true,
  personality: { name: 'DSH', identity: '身份文本', style: '风格文本', rules: ['规则一', '规则二'], updatedAt: 1 },
  presets: [
    { id: 'engineer', label: '可靠工程师', labelEn: 'Reliable engineer', hint: '先给结论', hintEn: 'Conclusion first' },
    { id: 'warm', label: '温暖伙伴', labelEn: 'Warm', hint: '有温度', hintEn: 'Warm' },
  ],
  stats: { dataDir: 'C:/x', sessionSummaries: 2, memories: 5, lastSummarizedAt: 1793513015133 },
  sessions: [
    { sessionId: 's1', title: '标题', summary: '摘要内容', keyPoints: ['要点A', '要点B'], topics: ['t'], summarizedAt: 1793513015133, eventCount: 12 },
  ],
  memories: [],
}

function walk(node, depth, path, findings) {
  if (node === null || node === undefined) {
    findings.push({ depth, path, problem: 'null/undefined child' })
    return
  }
  if (typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) {
    node.forEach((child, index) => walk(child, depth + 1, path + '[' + index + ']', findings))
    return
  }
  if (typeof node === 'object' && node.type !== undefined) {
    const children = node.props ? node.props.children : undefined
    if (children === undefined) findings.push({ depth, path, problem: 'element <' + String(node.type) + '> has no children' })
    walk(children, depth + 1, path + '/' + String(node.type), findings)
    return
  }
  findings.push({ depth, path, problem: 'unexpected node shape: ' + Object.prototype.toString.call(node) })
}

function renderCase(label, states) {
  stateQueue = states
  stateIndex = 0
  let tree
  try {
    tree = registered.Comp({ close: () => {} })
  } catch (error) {
    console.log('\n[' + label + '] RENDER THREW: ' + (error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : error))
    return false
  }
  const findings = []
  walk(tree, 0, 'root', findings)
  const text = JSON.stringify(tree)
  console.log('\n[' + label + '] rendered ok, tree bytes=' + text.length + ', findings=' + findings.length)
  findings.slice(0, 8).forEach((f) => console.log('   - ' + f.path + ': ' + f.problem))
  console.log('   contains editor label: ' + text.includes('人格设定') + ', contains memory card: ' + text.includes('长期记忆'))
  return findings.length === 0
}

// useState order inside the component: lang, data, draft, busy, error, notice, force
const emptyCase = ['zh', null, { name: '', identity: '', style: '', rules: '' }, 'load', '', '', false]
const loadedCase = [
  'zh',
  loadedState,
  { name: 'DSH', identity: '身份文本', style: '风格文本', rules: '规则一\n规则二' },
  '',
  '',
  '人格已保存，下一轮对话生效。',
  true,
]
const errorCase = ['en', loadedState, { name: 'x', identity: '', style: '', rules: '' }, '', 'boom', '', false]

const results = [renderCase('empty/loading', emptyCase), renderCase('loaded zh', loadedCase), renderCase('loaded en + error', errorCase)]
console.log('\n' + (results.every(Boolean) ? 'PROBE PASS' : 'PROBE FAIL'))
process.exitCode = results.every(Boolean) ? 0 : 1
