/**
 * dsh-submodel-change — DeepSeek Harness 插件
 *
 * 目标: AI 调用 subagent(子代理)时,由你在 UI 里选择「这个子代理由哪个模型驱动」,
 * 选好后该子代理及其嵌套子代理都用你选的模型跑;同一父会话的后续子代理复用同一选择,
 * 不再重复弹窗。
 *
 * 设计要点(全部基于 DeepSeek Harness 的官方扩展点,无任何对内部实现的依赖):
 *  - 监听 `agent/request` waterfall({ global: true } 收所有 agent 的事件,
 *    包括 in-process subagent child)。每个 agent 每次向模型发请求前都会触发该事件,
 *    监听器可以「替换整个 LlmCallConfig(provider/model)」——这是官方允许的注入点。
 *  - 用 `userQuestions.ask({ agent: <root>, ... })` 向用户弹模型选择。
 *    ask 严格校验 agent 必须是「实时根 agent」(否则 DELEGATED_CALLER 拒绝),所以
 *    提问永远发生在 root 上下文,UI 问题卡片渲染在根会话。
 *  - 子代理的 session header 带有 `origin: 'subagent'` 与 `parentSession`,
 *    用它们识别「这是子代理」并找到其父 agent(决定向谁提问、是否复用选择)。
 *  - 同一 parent 的后续子代理复用 routeByParent 中记住的选择,不重复弹窗。
 *  - 嵌套子代理: harness 用父路由合成子路由(resolveChildAgentOptions),天然继承。
 *  - 只处理 in-process provider(spawn)创建的子代理;其它 provider 的 child 事件
 *    带不到本进程的 agent/request,自然跳过,不影响任何其它功能。
 *
 * 零运行时依赖: 不 import 任何 @deepseek-ai/* 包,可直接用绝对路径挂载。
 */

// ---------------------------------------------------------------------------
// 极简 Standard Schema(免去对 @deepseek-ai/schemastery 的依赖)
// Cordis 契约: Config['~standard'].validate(value) 返回 { issues } 或 { value }。
// ---------------------------------------------------------------------------

function miniSchema(fields) {
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-submodel-change',
      validate(value) {
        const input = value && typeof value === 'object' ? value : {}
        const out = {}
        const issues = []
        for (const [key, spec] of Object.entries(fields)) {
          const raw = key in input ? input[key] : spec.default
          if (raw === undefined) continue
          const bad = (msg) => issues.push({
            keyword: 'type',
            message: `${key}: ${msg}`,
            path: [{ type: 'property', key }],
          })
          if (spec.type === 'boolean' && typeof raw !== 'boolean') bad(`expected boolean, got ${typeof raw}`)
          else if (spec.type === 'string' && typeof raw !== 'string') bad(`expected string, got ${typeof raw}`)
          else if (spec.type === 'number' && (typeof raw !== 'number' || !Number.isFinite(raw))) bad(`expected finite number, got ${typeof raw}`)
          else if (spec.type === 'stringArray' && (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string'))) bad('expected array of strings')
          else out[key] = raw
        }
        return issues.length > 0 ? { issues } : { value: out }
      },
    },
  }
}

/**
 * 插件配置(均可通过 cordis.yml / cordis.patch.yml 的 config 覆盖):
 *  - enabled:            总开关,默认 true
 *  - askOncePerParent:   true(默认)时同一父会话的后续子代理复用第一次的选择,
 *                        false 时每个子代理都重新弹窗
 *  - allowDefault:       true(默认)时选项里包含「使用默认模型(跟随父级)」,
 *                        选它则不修改该子代理的路由
 *  - extraModels:        额外的手动模型路由,格式 ["provider/model", ...],
 *                        用于适配器目录没列出但你确实想用的模型(如未登记的网关模型)
 */
export const Config = miniSchema({
  enabled: { type: 'boolean', default: true },
  askOncePerParent: { type: 'boolean', default: true },
  allowDefault: { type: 'boolean', default: true },
  extraModels: { type: 'stringArray', default: [] },
})

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  if (config.enabled === false) {
    console.log('[submodel-change] 已在配置中禁用 (enabled: false)')
    return
  }

  const has = (name) => ctx.get(name) !== undefined
  if (!has('userQuestions') || !has('llm') || !has('agents')) {
    console.log('[submodel-change] 缺少 userQuestions/llm/agents 服务,已跳过(不影响其它功能)')
    return
  }

  const chosen = new Map()        // childAgentId -> { provider, model }
  const asked = new Map()         // childAgentId -> true(每个 child 只尝试一次,含失败)
  const routeByParent = new Map() // parentSessionId -> 最近一次选择(askOncePerParent 复用)

  /** 从适配器目录收集 provider/model 选项;extraModels 追加手动路由。 */
  async function buildModelOptions() {
    const llm = ctx.get('llm')
    const options = []
    const byLabel = new Map()
    const seen = new Set()
    const pushRoute = (provider, model, label, description) => {
      const key = `${provider}\u0000${model}`
      if (seen.has(key)) return
      seen.add(key)
      if (byLabel.has(label)) return
      byLabel.set(label, { provider, model })
      options.push(description ? { label, description } : { label })
    }
    if (llm) {
      let providers = []
      try { providers = llm.listProviders() ?? [] } catch { providers = [] }
      for (const p of providers) {
        let models = []
        try { models = await llm.listModels(p.id) ?? [] } catch { models = [] }
        for (const m of models) {
          pushRoute(
            p.id,
            m.id,
            `${p.name ?? p.id} / ${m.name ?? m.id}`,
            m.description,
          )
        }
      }
    }
    for (const entry of config.extraModels ?? []) {
      if (typeof entry !== 'string') continue
      const slash = entry.indexOf('/')
      if (slash <= 0 || slash === entry.length - 1) continue
      pushRoute(entry.slice(0, slash), entry.slice(slash + 1), `${entry} (手动)`, undefined)
    }
    return { options, byLabel }
  }

  /** 向实时根 agent 弹模型选择;失败或取消返回 undefined(不修改路由)。 */
  async function askForRoute(rootAgent, signal) {
    const userQuestions = ctx.get('userQuestions')
    if (!userQuestions) return undefined
    const { options, byLabel } = await buildModelOptions()
    if (config.allowDefault !== false) {
      options.push({ label: '使用默认模型(跟随父级,不修改)' })
    }
    if (options.length === 0) return undefined
    try {
      const answer = await userQuestions.ask({
        agent: rootAgent,
        signal,
        questions: [{
          id: 'submodel-change',
          question: '这个子代理用哪个模型运行?',
          header: '子代理模型选择',
          options,
        }],
      })
      const selected = answer?.answers?.[0]?.selected?.[0]
      if (!selected) return undefined
      return byLabel.get(selected)
    } catch (error) {
      console.log('[submodel-change] 提问失败,按默认路由继续:', error?.message ?? error)
      return undefined
    }
  }

  ctx.on('agent/request', async ({ agent, signal }, next) => {
    // 先取默认配置(waterfall 语义: 不调用 next 会短路后续监听器)
    const base = await next()
    // 只处理 in-process subagent child;根会话自身的请求原样放行
    if (!agent || agent.session?.header?.origin !== 'subagent') return base
    if (!asked.has(agent.id)) {
      asked.set(agent.id, true)
      const agents = ctx.get('agents')
      const parentId = agent.session.header.parentSession
      const parent = parentId && agents ? agents.get(parentId) : undefined
      // 人类交互只对实时根 agent 有效(DELEGATED_CALLER 边界)
      if (parent && agents.roots().includes(parent)) {
        const reused = config.askOncePerParent !== false
          ? routeByParent.get(parentId)
          : undefined
        let route = reused
        if (route === undefined) {
          route = await askForRoute(parent, signal)
          if (route && config.askOncePerParent !== false) routeByParent.set(parentId, route)
        }
        if (route) chosen.set(agent.id, route)
      }
    }
    const route = chosen.get(agent.id)
    if (!route) return base
    if (base.provider === route.provider && base.model === route.model) return base
    console.log(`[submodel-change] child ${agent.id} 使用 ${route.provider}/${route.model}`)
    return { ...base, provider: route.provider, model: route.model }
  }, { global: true })

  const forget = (id) => { if (id) { chosen.delete(id); asked.delete(id) } }
  ctx.on('subagent/end', (info) => { if (info?.id) forget(info.id) })
  ctx.on('agent/disposed', ({ agent }) => { if (agent) forget(agent.id) })

  console.log('[submodel-change] 已加载: 子代理发起模型请求时弹窗选择模型')
}
