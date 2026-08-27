// dsh-turn-notify 逻辑自测(不依赖 Cordis 运行时)
// 用法: node test-plugin.mjs
import { apply, Config } from './dsh-turn-notify/index.mjs'

const listeners = []
const seen = []
const ctx = {
  logger: {
    info: (...a) => { seen.push(['info', a.join(' ')]); console.log('[INFO]', ...a) },
    warn: (...a) => { seen.push(['warn', a.join(' ')]); console.warn('[WARN]', ...a) },
  },
  on: (name, fn, opts) => listeners.push({ name, fn, opts }),
  get: () => undefined,
}

// 1) 配置校验: 默认值
const cfg = Config['~standard'].validate({}).value
console.log('config defaults:', JSON.stringify(cfg))
if (cfg.appName !== 'DeepSeek Harness' || cfg.cooldownMs !== 2000 || cfg.enabled !== true) {
  throw new Error('defaults mismatch')
}
// 2) 配置校验: 非法输入应报 issues
const bad = Config['~standard'].validate({ cooldownMs: 'abc', notifyKinds: 'x' })
if (!bad.issues || bad.issues.length === 0) throw new Error('invalid config should produce issues')
console.log('invalid config rejected with', bad.issues.length, 'issue(s)')

// 3) apply
apply(ctx, cfg)
const listener = listeners.find((l) => l.name === 'session/event')
if (!listener) throw new Error('session/event listener not registered')
if (listener.opts?.global !== true) throw new Error('expected { global: true }')
console.log('listener registered with global=true')

const rootA = { id: 'session-rootA', header: {} }
const rootB = { id: 'session-rootB', header: {} }
const rootC = { id: 'session-rootC', header: {} }
const child = { id: 'session-child', header: { parentSession: 'session-rootA' } }

const ev = (type, data) => ({ type, seq: 1, time: Date.now(), data })

// 4) 跟踪标题 + 完成通知
listener.fn(rootA, ev('session/title', { title: '  测试会话A  ', messageSeqs: [], source: 'user' }))
listener.fn(rootA, ev('turn/end', { turn: 3, reason: { kind: 'completed' } }))
// 5) 出错通知(另一个根会话,避开冷却)
listener.fn(rootB, ev('turn/end', { turn: 1, reason: { kind: 'error' } }))
// 6) 子会话结束 -> 不应通知
listener.fn(child, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))
// 7) 冷却内同会话再结束 -> 不应通知
listener.fn(rootA, ev('turn/end', { turn: 4, reason: { kind: 'completed' } }))
// 8) 会话标题取不到 -> 用 fallbackAgent(第三个根会话,避开冷却)
listener.fn(rootC, ev('turn/end', { turn: 2, reason: { kind: 'blocked' } }))

setTimeout(() => {
  const toasts = seen.filter(([k]) => k === 'info').map(([, m]) => m).filter((m) => m.includes('[turn-notify]') && m.includes('轮'))
  console.log('\n--- 插件日志 ---')
  toasts.forEach((t) => console.log(t))
  const completed = toasts.some((t) => t.includes('「测试会话A」第 3 轮操作已完成'))
  const errored = toasts.some((t) => t.includes('「Agent」第 1 轮操作出错'))
  const blocked = toasts.some((t) => t.includes('「Agent」第 2 轮操作被阻止'))
  const childLogged = toasts.some((t) => t.includes('session-child'))
  const cooldownExtra = toasts.some((t) => t.includes('第 4 轮'))
  console.log('\n--- 断言 ---')
  console.log('completed toast  :', completed ? 'PASS' : 'FAIL')
  console.log('error toast      :', errored ? 'PASS' : 'FAIL')
  console.log('blocked toast    :', blocked ? 'PASS' : 'FAIL')
  console.log('child suppressed :', !childLogged ? 'PASS' : 'FAIL')
  console.log('cooldown works   :', !cooldownExtra ? 'PASS' : 'FAIL')
  const allOk = completed && errored && blocked && !childLogged && !cooldownExtra
  console.log(allOk ? '\nALL PASS (请检查屏幕上的通知中心是否弹出 3 条通知)' : '\nSOME FAILED')
  process.exit(allOk ? 0 : 1)
}, 4000)
