/**
 * dsh-turn-notify — DeepSeek Harness 插件
 *
 * 目标: agent 完成一轮操作(turn/end)后,通过 Windows 自带的通知中心
 * (WinRT Toast)发送通知,内容形如「会话标题 · 第 N 轮操作已完成」。
 *
 * 设计要点:
 *  - 零运行时依赖: 不 import 任何 @deepseek-ai/* 包,插件文件可以放在
 *    任意目录,以绝对路径挂载到 cordis.yml / cordis.patch.yml。
 *  - 监听 Cordis 事件 session/event({ global: true } 收到所有会话的事件),
 *    过滤持久事件类型 turn/end。
 *  - 只通知根会话: 子 agent / fork 出的会话带有 header.parentSession,
 *    它们结束时不打扰用户(可通过 notifyKinds 之外另行扩展)。
 *  - 通过跟踪 session/title 事件维护「会话标题 -> 会话」映射,取不到时
 *    回退到配置项 fallbackAgent。
 *  - 通知方式: powershell.exe -EncodedCommand(UTF-16LE Base64)调用 WinRT
 *    ToastNotification,避免一切编码 / 引号转义问题,Windows 10/11 均可用,
 *    无需安装任何 PowerShell 模块。
 */

import { execFile } from 'node:child_process'

export const name = 'turn-notify'

// ---------------------------------------------------------------------------
// 极简 Standard Schema(免去对 @deepseek-ai/schemastery 的依赖)
// Cordis 契约: Config['~standard'].validate(value) 返回 { issues } 或 { value }。
// ---------------------------------------------------------------------------

function miniSchema(fields) {
  return {
    '~standard': {
      version: 1,
      vendor: 'turn-notify',
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
 *  - enabled:       总开关,默认 true
 *  - appName:       通知标题,默认 'DeepSeek Harness'
 *  - fallbackAgent: 取不到会话标题时正文里显示的名字,默认 'Agent'
 *  - notifyKinds:   只通知这些结束原因;空数组 = 全部通知
 *                   可选值: completed / error / blocked / max-tokens / aborted / interrupted
 *  - cooldownMs:    同一会话两次通知的最小间隔,防刷屏,默认 2000
 *  - silent:        true 时不播放通知声音,默认 false
 */
export const Config = miniSchema({
  enabled: { type: 'boolean', default: true },
  appName: { type: 'string', default: 'DeepSeek Harness' },
  fallbackAgent: { type: 'string', default: 'Agent' },
  notifyKinds: { type: 'stringArray', default: [] },
  cooldownMs: { type: 'number', default: 2000 },
  silent: { type: 'boolean', default: false },
})

// ---------------------------------------------------------------------------
// 结束原因 -> 中文文案
// ---------------------------------------------------------------------------

const REASON_TEXT = {
  completed: '操作已完成',
  error: '操作出错',
  blocked: '操作被阻止,等待你的处理',
  'max-tokens': '输出达到 Token 上限,已被截断',
  aborted: '操作已中止',
  interrupted: '操作被中断',
}

// ---------------------------------------------------------------------------
// WinRT Toast(经 Windows PowerShell 5.1)
// ---------------------------------------------------------------------------

const POWERSHELL = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : 'powershell.exe'

/** 生成 toast 脚本;title/body 先做 PS 单引号转义,再由 SecurityElement 做 XML 转义。 */
function buildToastScript(title, body, silent) {
  const psEsc = (s) => String(s).replace(/'/g, "''")
  const audio = silent ? '<audio silent="true"/>' : ''
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$title = [System.Security.SecurityElement]::Escape('${psEsc(title)}')`,
    `$body = [System.Security.SecurityElement]::Escape('${psEsc(body)}')`,
    `$xmlText = '<toast>${audio}<visual><binding template="ToastText02"><text id="1">' + $title + '</text><text id="2">' + $body + '</text></binding></visual></toast>'`,
    '$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()',
    '$xml.LoadXml($xmlText)',
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.WindowsPowerShell').Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
  ].join('\n')
}

function showToast(logger, title, body, silent) {
  const script = buildToastScript(title, body, silent)
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  execFile(
    POWERSHELL,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 15000, stdio: 'ignore' },
    (err) => {
      if (err) (logger ?? console).warn?.('[turn-notify] toast failed:', err.message)
    },
  )
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  if (process.platform !== 'win32') {
    ctx.logger?.info?.(`[turn-notify] 仅在 Windows 上生效,当前平台 ${process.platform},已跳过`)
    return
  }
  if (config.enabled === false) {
    ctx.logger?.info?.('[turn-notify] 已在配置中禁用 (enabled: false)')
    return
  }

  const logger = ctx.logger ?? console
  const titles = new Map()    // sessionId -> 最近一次会话标题
  const lastToast = new Map() // sessionId -> 上次通知时间戳

  ctx.on('session/event', (session, event) => {
    if (!session || !event) return

    // 跟踪会话标题(持久事件 session/title)
    if (event.type === 'session/title') {
      const title = event.data?.title
      if (typeof title === 'string' && title.trim()) titles.set(session.id, title.trim())
      return
    }

    if (event.type !== 'turn/end') return

    // 只通知根会话: 子 agent / fork 出的会话带 parentSession,不打扰
    if (session.header?.parentSession != null) return

    const reason = event.data?.reason
    const kind = typeof reason?.kind === 'string' ? reason.kind : 'unknown'
    if (config.notifyKinds.length > 0 && !config.notifyKinds.includes(kind)) return

    // 冷却,防同一会话快速连续结束刷屏
    const now = Date.now()
    const last = lastToast.get(session.id) ?? 0
    if (now - last < config.cooldownMs) return
    lastToast.set(session.id, now)

    const turn = event.data?.turn
    const label = titles.get(session.id) || config.fallbackAgent
    const text = REASON_TEXT[kind] || '操作结束'
    const body = `「${label}」第 ${turn ?? '?'} 轮${text}`

    logger.info?.(`[turn-notify] ${body} (session=${session.id})`)
    showToast(logger, config.appName, body, config.silent)
  }, { global: true })

  logger.info?.(`[turn-notify] 已加载,appName=${config.appName},fallbackAgent=${config.fallbackAgent},cooldownMs=${config.cooldownMs}`)
}
