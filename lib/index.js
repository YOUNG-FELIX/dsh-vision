// dsh-vision — host half.
//
// Why this plugin exists: the host registers image-capable LLM routes through
// its providers, but the built-in read_image tool refuses to run unless the
// *current session model* declares image input, and subagent model selection is
// gated by a per-session allowlist policy. This plugin sidesteps both: it asks a
// vision-capable route directly through ctx.llm.stream, the way any other
// in-process caller would, and hands the evidence back as text.
//
// Everything is local: no network calls of its own, no credentials of its own,
// no dependency outside node builtins. The only outbound traffic is the host's
// own provider adapter doing what it already does for chat.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import zlib from 'node:zlib'

export const name = 'dsh-vision'
export const inject = []

const HOME = path.join(os.homedir(), '.dsh', 'dsh-vision')
const CONFIG_FILE = path.join(HOME, 'config.json')
const STATS_FILE = path.join(HOME, 'stats.json')
const DETECTIONS_FILE = path.join(HOME, 'detections.json')

const ROUTE_SEPARATOR = '/'
const CUSTOM_PROVIDER = 'custom'
// "direct/<provider>/<model>" bypasses the host provider layer and posts straight
// to the provider's own OpenAI-compatible endpoint, using the key the host
// already has for it. Lets models the host marks as text-only be tested for real.
const DIRECT_PROVIDER = 'direct'
const PROFILE_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const TASK_KEYS = ['describe', 'text', 'ui', 'chart', 'diff', 'question', 'auto']

const DEFAULTS = {
  // master switch: when false the tool answers with a clear refusal
  enabled: true,
  // Primary route, "provider/model". Empty means auto: the first route the
  // host reports as image-capable is used. Nothing here is tied to a specific
  // vendor, so a fresh install works with whatever the host already has.
  route: '',
  // try the next route when the primary fails (cooldown-less, ordered)
  fallbackEnabled: true,
  fallbacks: [],
  // how images travel to the LLM layer: auto | attachment | inline
  transport: 'attachment',
  // OpenAI-compatible endpoints supplied by the operator, referenced as
  // "custom/<name>". They exist so a provider the host does not know about can
  // still be used: any vision API that speaks /chat/completions works.
  customRoutes: [],
  timeoutMs: 120000,
  maxImageBytes: 12000000,
  maxImages: 4,
  // extra instruction prepended to every read
  promptPrefix: '',
  // Built-in task prompts. The calling model only has to pick a task; it does
  // not have to write a good prompt itself, which keeps results stable across
  // sessions and across models that phrase instructions very differently.
  defaultTask: 'describe',
  taskTemplates: {
    describe:
      '把这张图片变成可以直接引用的事实清单：\n' +
      '1. 一句话说明这是什么；\n' +
      '2. 主体、位置（左/中/右、上/下）与相对大小；\n' +
      '3. 图中文字逐字转写，保留分行，看不清的字写 ⍰；\n' +
      '4. 颜色、光线、材质、画风等能直接看到的细节。\n' +
      '只输出这四项，不要加别的章节。禁止瞎猜和编造，看不清就别写。',
    text:
      '只做文字转写，不要描述画面。按阅读顺序逐行输出图中所有文字，包括界面标签、按钮、表格单元、代码与文件名，' +
      '保留原有换行与缩进层级。无法辨认的字符用 ⍰ 占位。不要翻译、不要总结、不要补字、不要猜。',
    ui:
      '这是一张软件界面截图。只写看得见的东西，按下面五项输出：\n' +
      '1. 页面/窗口标题，以及当前处在哪个视图或标签页；\n' +
      '2. 顶部栏与侧边栏的导航项，逐字转写；\n' +
      '3. 主区域的控件，按从上到下、从左到右列出：控件类型、标签文字、当前状态（选中/未选/禁用/已开启）；\n' +
      '4. 界面上的提示、警告、报错原文，一字不改；\n' +
      '5. 出现的数值、时间、路径、版本号，逐字转写。\n' +
      '禁止瞎猜和编造，看不清的标签写 ⍰。',
    chart:
      '这是一张图表。按下面五项输出：\n' +
      '1. 图表类型与标题；\n' +
      '2. 坐标轴名称、单位与刻度范围；\n' +
      '3. 图例与系列名称；\n' +
      '4. 逐点读出取值，近似值前面加「约」；\n' +
      '5. 明显的趋势、拐点或异常。\n' +
      '禁止瞎猜和编造，不要给出图上没有的数据。',
    diff:
      '这些图片是同一标的物的不同状态或前后对比。按下面四项输出：\n' +
      '1. 每张图分别是什么状态；\n' +
      '2. 逐项列出差异，写成「位置：旧值 → 新值」；\n' +
      '3. 哪些区域整体发生了变化；\n' +
      '4. 新增或删除了什么元素。\n' +
      '只写实际看到的差异，禁止瞎猜和编造。',
    question:
      '只依据图片里可见的内容回答问题。看不出来就直接回答「图中看不出来」，禁止瞎猜和编造。',
    // "auto" has no built-in text: the calling model writes the whole prompt
    // itself and it is sent verbatim (see composePrompt). It exists for cases
    // a fixed template cannot cover — the templates stay the default because
    // a model-authored prompt drifts between sessions.
    auto: ''
  },
  // 'quiet' returns plain text; 'rich' also returns model/latency/usage lines
  verbosity: 'rich',
  recordLog: true,
  logLimit: 40,
  // show the tool result as one text block (true) or keep it verbatim
  toolName: 'vision_read'
}

const LIMITS = {
  maxImages: 8,
  maxImageBytes: 64000000,
  timeoutMs: 600000,
  logLimit: 500,
  textLength: 20000
}

let statsCache = null

// ---------------------------------------------------------------- filesystem

function ensureHome() {
  try {
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 })
  } catch {
    /* the write below reports the real problem */
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clampInt(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.round(value)))
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const value = JSON.parse(text)
    return isPlainObject(value) ? value : fallback
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(file, value) {
  ensureHome()
  const temp = file + '.tmp-' + process.pid + '-' + Date.now()
  await fsp.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await fsp.rename(temp, file)
}

/**
 * Register the custom endpoints as a real LLM provider. The adapter base class
 * lives inside the host bundle, so it is imported dynamically: outside the host
 * (smoke tests) the import fails and `buildAdapter` falls back to a stub base.
 */
async function mountProvider(call) {
  if (call.llm === null) throw new Error('the llm service is not mounted')
  let Base
  let attributionHeaders
  try {
    const host = await import('@deepseek-ai/dsh-llm')
    Base = host.LlmAdapter
    attributionHeaders = host.attributionHeaders
  } catch {
    Base = undefined
    attributionHeaders = undefined
  }
  const { buildAdapter, PROVIDER_ID } = await import('./provider.js')
  const adapter = buildAdapter({
    Base,
    attributionHeaders,
    getRoutes: () => readConfig().customRoutes,
    resolveKey: async (route) => {
      if (typeof route.apiKey === 'string' && route.apiKey !== '') return route.apiKey
      return readCredentialRef(route.apiKeyRef)
    },
    readImage: async (block) => readImageBlock(call, block),
    onEvent: (name, detail) => {
      if (process.env.DSH_VISION_DEBUG === '1') console.error('[dsh-vision] ' + name + ' ' + JSON.stringify(detail))
    }
  })
  call.providerHandle = call.llm.registerAdapter([PROVIDER_ID], adapter)
  call.provider.mounted = true
  call.provider.error = null
}

/** Read one harness image block into raw bytes, for the adapter's data URLs. */
async function readImageBlock(call, block) {
  if (block === null || typeof block !== 'object') return null
  if (typeof block.data === 'string' && block.data !== '') {
    return { bytes: Buffer.from(block.data, 'base64'), mediaType: block.mediaType || block.mimeType || 'image/png' }
  }
  const ref = block.attachment
  if (ref === undefined || call.attachments === null) return null
  try {
    const result = await call.attachments.readImage(ref)
    const bytes = Buffer.isBuffer(result) ? result : Buffer.from(result?.bytes ?? result?.data ?? [])
    const mediaType = result?.mediaType ?? result?.mimeType ?? block.mediaType ?? 'image/png'
    return bytes.length === 0 ? null : { bytes, mediaType }
  } catch {
    return null
  }
}

function readConfig() {
  const stored = readJson(CONFIG_FILE, {})
  const merged = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (stored[key] !== undefined) merged[key] = stored[key]
  }
  return normalizeConfig(merged)
}

function normalizeRoute(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  const index = text.indexOf(ROUTE_SEPARATOR)
  if (index <= 0 || index === text.length - 1) return undefined
  return { provider: text.slice(0, index), model: text.slice(index + 1) }
}

function routeText(route) {
  return route === undefined ? '' : route.provider + ROUTE_SEPARATOR + route.model
}

function normalizeFallbacks(value) {
  if (!Array.isArray(value)) return [...DEFAULTS.fallbacks]
  const out = []
  for (const entry of value) {
    const route = normalizeRoute(typeof entry === 'string' ? entry : '')
    if (route === undefined) continue
    const text = routeText(route)
    if (!out.includes(text)) out.push(text)
  }
  return out
}

function normalizeCustomRoutes(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const entry of value) {
    if (!isPlainObject(entry)) continue
    const name = typeof entry.name === 'string' ? entry.name.trim().toLowerCase() : ''
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name) || seen.has(name)) continue
    const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim().replace(/\/+$/, '') : ''
    if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) continue
    const model = typeof entry.model === 'string' ? entry.model.trim() : ''
    if (model === '') continue
    seen.add(name)
    out.push({
      name,
      label: typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label.trim().slice(0, 80) : name,
      baseUrl,
      model,
      apiKey: typeof entry.apiKey === 'string' ? entry.apiKey.slice(0, 4000) : '',
      apiKeyRef: typeof entry.apiKeyRef === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(entry.apiKeyRef.trim())
        ? entry.apiKeyRef.trim()
        : '',
      headers: isPlainObject(entry.headers) ? entry.headers : {}
    })
  }
  return out.slice(0, 12)
}

function findCustomRoute(name) {
  return readConfig().customRoutes.find((entry) => entry.name === name)
}

// ------------------------------------------- 宿主 provider 直连（探测 & 免手工配置）
// 宿主把没声明图片输入的模型统一换成占位符，所以"能不能看图"只能绕开宿主、直接
// 用 Host 已经配好的 baseURL + 密钥打一次真请求。密钥只在本进程内存里用。
const hostCatalog = { at: 0, providers: [] }

function readHostProviders(force) {
  if (!force && Date.now() - hostCatalog.at < 300000) return hostCatalog.providers
  const out = []
  try {
    const require = createRequire(path.join(PROFILE_DIR, 'package.json'))
    const yaml = require('yaml')
    const doc = yaml.parse(fs.readFileSync(path.join(PROFILE_DIR, 'cordis.patch.yml'), 'utf8'))
    for (const row of Array.isArray(doc) ? doc : []) {
      const providers = row && row.config && row.config.providers
      if (!providers || typeof providers !== 'object') continue
      for (const [id, provider] of Object.entries(providers)) {
        if (!provider || typeof provider !== 'object') continue
        if (provider.api !== undefined && String(provider.api).indexOf('openai') !== 0) continue
        const baseUrl = typeof provider.baseURL === 'string' ? provider.baseURL.replace(/\/+$/, '') : ''
        if (baseUrl === '') continue
        for (const model of Array.isArray(provider.models) ? provider.models : []) {
          const modelId = typeof model === 'string' ? model : model && model.id
          if (typeof modelId !== 'string' || modelId === '') continue
          out.push({
            provider: id,
            model: modelId,
            baseUrl,
            apiKeyRef: typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv : '',
            label: (model && model.name) || modelId
          })
        }
      }
    }
  } catch (error) {
    console.error('[dsh-vision] host provider catalog unavailable: ' + errorText(error))
  }
  hostCatalog.providers = out
  hostCatalog.at = Date.now()
  return out
}

function directRouteText(provider, model) {
  return DIRECT_PROVIDER + ROUTE_SEPARATOR + provider + ROUTE_SEPARATOR + model
}

function resolveDirectRoute(route) {
  if (route === undefined || route.provider !== DIRECT_PROVIDER) return undefined
  const text = String(route.model)
  const index = text.indexOf(ROUTE_SEPARATOR)
  if (index <= 0 || index === text.length - 1) return undefined
  const providerId = text.slice(0, index)
  const modelId = text.slice(index + 1)
  const found = readHostProviders(false).find((item) => item.provider === providerId && item.model === modelId)
  if (found === undefined) return undefined
  return {
    name: directRouteText(providerId, modelId),
    baseUrl: found.baseUrl,
    model: modelId,
    apiKey: '',
    apiKeyRef: found.apiKeyRef
  }
}

function readDetections() {
  const map = readJson(DETECTIONS_FILE, {})
  return map && typeof map === 'object' ? map : {}
}

function directModelList() {
  const detections = readDetections()
  return readHostProviders(false).map((item) => {
    const route = directRouteText(item.provider, item.model)
    const detection = detections[route]
    return {
      route,
      provider: item.provider,
      model: item.model,
      label: item.label,
      baseUrl: item.baseUrl,
      keyRef: item.apiKeyRef,
      tested: detection === undefined ? null : detection.ok === true,
      testedAt: detection === undefined ? null : detection.at,
      answer: detection === undefined ? '' : String(detection.answer || '')
    }
  })
}

// 凭据引用：从 ~/.dsh/.credentials.yaml 的 refs 段取密钥，避免把明文写进插件配置。
function readCredentialRef(ref) {
  if (typeof ref !== 'string' || ref === '') return ''
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const block = text.split(/^refs:\s*$/m)[1] || ''
    const pattern = new RegExp('^\\s+' + ref + ':\\s*(.+?)\\s*$', 'm')
    const match = pattern.exec(block)
    if (match === null) return ''
    return match[1].replace(/^['"]|['"]$/g, '')
  } catch {
    return ''
  }
}

function normalizeTaskTemplates(value) {
  const out = { ...DEFAULTS.taskTemplates }
  if (isPlainObject(value)) {
    for (const key of TASK_KEYS) {
      if (typeof value[key] === 'string' && value[key].trim() !== '') out[key] = value[key].slice(0, 4000)
    }
  }
  return out
}

function normalizeConfig(raw) {
  const config = { ...DEFAULTS }
  config.enabled = raw.enabled !== false
  const primary = normalizeRoute(raw.route)
  config.route = primary === undefined ? DEFAULTS.route : routeText(primary)
  config.fallbackEnabled = raw.fallbackEnabled !== false
  config.fallbacks = normalizeFallbacks(raw.fallbacks)
  config.customRoutes = normalizeCustomRoutes(raw.customRoutes)
  if (['auto', 'attachment', 'inline'].includes(raw.transport)) config.transport = raw.transport
  config.timeoutMs = clampInt(raw.timeoutMs, 5000, LIMITS.timeoutMs) ?? DEFAULTS.timeoutMs
  config.maxImageBytes = clampInt(raw.maxImageBytes, 65536, LIMITS.maxImageBytes) ?? DEFAULTS.maxImageBytes
  config.maxImages = clampInt(raw.maxImages, 1, LIMITS.maxImages) ?? DEFAULTS.maxImages
  config.promptPrefix = typeof raw.promptPrefix === 'string' ? raw.promptPrefix.slice(0, 4000) : ''
  config.taskTemplates = normalizeTaskTemplates(raw.taskTemplates)
  config.defaultTask = typeof raw.defaultTask === 'string' && TASK_KEYS.includes(raw.defaultTask)
    ? raw.defaultTask
    : DEFAULTS.defaultTask
  config.verbosity = raw.verbosity === 'quiet' ? 'quiet' : 'rich'
  config.recordLog = raw.recordLog !== false
  config.logLimit = clampInt(raw.logLimit, 5, LIMITS.logLimit) ?? DEFAULTS.logLimit
  config.toolName = typeof raw.toolName === 'string' && /^[a-z][a-z0-9_]{2,40}$/.test(raw.toolName)
    ? raw.toolName
    : DEFAULTS.toolName
  return config
}

// -------------------------------------------------------------------- stats

function emptyStats() {
  return {
    since: Date.now(),
    calls: 0,
    ok: 0,
    fail: 0,
    lastAt: 0,
    lastOkAt: 0,
    lastError: '',
    totalMs: 0,
    totalBytes: 0,
    totalChars: 0,
    tokensIn: 0,
    tokensOut: 0,
    byRoute: {},
    log: []
  }
}

function readStats() {
  if (statsCache !== null) return statsCache
  const stored = readJson(STATS_FILE, {})
  const base = emptyStats()
  const merged = { ...base }
  for (const key of Object.keys(base)) {
    if (stored[key] !== undefined) merged[key] = stored[key]
  }
  if (!isPlainObject(merged.byRoute)) merged.byRoute = {}
  if (!Array.isArray(merged.log)) merged.log = []
  statsCache = merged
  return merged
}

let statsTimer = null

function persistStatsSoon() {
  if (statsTimer !== null) return
  statsTimer = setTimeout(() => {
    statsTimer = null
    const snapshot = readStats()
    writeJsonAtomic(STATS_FILE, snapshot).catch(() => {
      /* statistics are best-effort; never break a read because of them */
    })
  }, 400)
  if (typeof statsTimer.unref === 'function') statsTimer.unref()
}

function recordCall(entry) {
  const stats = readStats()
  const config = readConfig()
  stats.calls += 1
  stats.lastAt = entry.at
  stats.totalMs += entry.ms
  stats.totalBytes += entry.bytes
  stats.totalChars += entry.chars
  stats.tokensIn += entry.tokensIn
  stats.tokensOut += entry.tokensOut
  const bucket = stats.byRoute[entry.route] ?? { calls: 0, ok: 0, fail: 0, totalMs: 0 }
  bucket.calls += 1
  bucket.totalMs += entry.ms
  if (entry.ok) {
    stats.ok += 1
    stats.lastOkAt = entry.at
    bucket.ok += 1
  } else {
    stats.fail += 1
    stats.lastError = entry.error || 'unknown error'
    bucket.fail += 1
  }
  stats.byRoute[entry.route] = bucket
  if (config.recordLog) {
    stats.log.unshift({
      at: entry.at,
      route: entry.route,
      ok: entry.ok,
      ms: entry.ms,
      bytes: entry.bytes,
      chars: entry.chars,
      images: entry.images,
      transport: entry.transport,
      prompt: redactSecrets(entry.prompt).slice(0, 160),
      error: entry.error ? redactSecrets(String(entry.error)).slice(0, 400) : ''
    })
    if (stats.log.length > LIMITS.logLimit) stats.log.length = LIMITS.logLimit
  }
  persistStatsSoon()
}

// ------------------------------------------------------------- image helpers

const SNIFFS = [
  { mediaType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mediaType: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mediaType: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], tail: [0x57, 0x45, 0x42, 0x50] }
]

function sniffMediaType(buffer) {
  for (const sniff of SNIFFS) {
    if (buffer.length < sniff.bytes.length) continue
    let hit = true
    for (let i = 0; i < sniff.bytes.length; i += 1) {
      if (buffer[i] !== sniff.bytes[i]) {
        hit = false
        break
      }
    }
    if (!hit) continue
    if (sniff.tail !== undefined) {
      if (buffer.length < 12) continue
      const tail = buffer.subarray(8, 12)
      let tailHit = true
      for (let i = 0; i < sniff.tail.length; i += 1) {
        if (tail[i] !== sniff.tail[i]) {
          tailHit = false
          break
        }
      }
      if (!tailHit) continue
    }
    return sniff.mediaType
  }
  return undefined
}

async function loadImage(file, maxBytes) {
  const resolved = path.resolve(file)
  const stat = await fsp.stat(resolved)
  if (!stat.isFile()) throw new Error('not a file: ' + resolved)
  if (stat.size > maxBytes) {
    throw new Error('image is ' + stat.size + ' bytes, over the ' + maxBytes + '-byte limit')
  }
  const data = await fsp.readFile(resolved)
  const mediaType = sniffMediaType(data)
  if (mediaType === undefined) {
    throw new Error('not a PNG/JPEG/GIF/WEBP image (magic bytes do not match): ' + resolved)
  }
  return { path: resolved, data, mediaType, bytes: data.length, name: path.basename(resolved) }
}

// ------------------------------------------------------- PNG for self test

let crcTable = null

function crc32(buffer) {
  if (crcTable === null) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function pngChunk(type, payload) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** Build one solid-colour PNG without any image library. */
function solidPng(width, height, rgb) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: truecolour
  header[10] = 0
  header[11] = 0
  header[12] = 0
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0]
    row[2 + x * 3] = rgb[1]
    row[3 + x * 3] = rgb[2]
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const TEST_COLORS = [
  { rgb: [220, 32, 32], zh: '红', en: 'red' },
  { rgb: [32, 96, 220], zh: '蓝', en: 'blue' },
  { rgb: [32, 176, 64], zh: '绿', en: 'green' }
]

// -------------------------------------------------------------- model routes

const discovery = { at: 0, routes: [], other: [] }

async function discoverRoutes(llm, force) {
  if (!force && Date.now() - discovery.at < 300000 && discovery.routes.length > 0) return discovery.routes
  const routes = []
  const other = []
  let providers = []
  try {
    providers = llm.listProviders() || []
  } catch {
    providers = []
  }
  for (const raw of providers) {
    const providerId = typeof raw === 'string' ? raw : raw && raw.id
    if (typeof providerId !== 'string' || providerId === '') continue
    let models = []
    try {
      models = (await llm.listModels(providerId)) || []
    } catch {
      continue
    }
    for (const model of models) {
      const modelId = typeof model === 'string' ? model : model && model.id
      if (typeof modelId !== 'string' || modelId === '') continue
      let info
      try {
        info = await llm.resolveModelInfo(providerId, modelId)
      } catch {
        continue
      }
      const modalities = info && Array.isArray(info.inputModalities) ? info.inputModalities : []
      const entry = {
        provider: providerId,
        model: modelId,
        route: providerId + ROUTE_SEPARATOR + modelId,
        name: (model && model.name) || modelId,
        description: (model && model.description) || '',
        contextWindow: info && info.contextWindow ? info.contextWindow : undefined
      }
      if (modalities.includes('image')) {
        entry.vision = true
        routes.push(entry)
      } else {
        entry.vision = false
        other.push(entry)
      }
    }
  }
  discovery.routes = routes
  discovery.other = other
  discovery.at = Date.now()
  return routes
}

// ------------------------------------------------------------------ the call

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorText(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return redactSecrets(error)
  const message = typeof error.message === 'string' ? error.message : String(error)
  return redactSecrets(message)
}

function finishText(reason) {
  if (reason === undefined || reason === null) return 'none'
  if (typeof reason === 'string') return reason
  try {
    const text = JSON.stringify(reason)
    return text.length > 300 ? text.slice(0, 300) + '...' : text
  } catch {
    return String(reason)
  }
}

// Some providers accept the request but drop the image, answering as if no
// picture had been attached. Treat that as a transport failure so the caller
// retries with the other transport before giving up on the route.
const MISSING_IMAGE_PATTERNS = [
  /image omitted/i,
  /accepts text only/i,
  /\[image\]/i,
  /无法(查看|看到|解析|识别)(该|这)?(张)?(图|图像|图片)/,
  /没有(收到|看到|拿到)(任何)?(图|图像|图片)/,
  /cannot (see|view|access|read) (the )?(image|picture)/i,
  /unable to (see|view|access) (the )?(image|picture)/i,
  /no image (was )?(provided|attached|supplied)/i
]

function looksLikeMissingImage(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value === '') return false
  return MISSING_IMAGE_PATTERNS.some((pattern) => pattern.test(value))
}

// 任何要写进日志、回给面板或抛给模型的文本，都先过一遍脱敏：
// Bearer 令牌、sk- 前缀密钥、常见云厂商的 AK、超长无空格串（多半是密钥/签名）。
const SECRET_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***'],
  [/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***'],
  [/\b(?:AKIA|LTAI|AKID)[A-Za-z0-9]{8,}/g, '***'],
  [/\b[A-Za-z0-9_-]{32,}\b/g, '***']
]

function redactSecrets(text) {
  let value = typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text)
  for (const [pattern, replacement] of SECRET_PATTERNS) value = value.replace(pattern, replacement)
  return value
}

async function imageBlockFor(transport, attachments, image) {
  if (transport === 'attachment') {
    if (attachments === null) throw new Error('no attachments service mounted for the attachment transport')
    const ref = await attachments.saveImage({ data: image.data, mediaType: image.mediaType, name: image.name })
    return { type: 'image', attachment: ref }
  }
  return { type: 'image', data: image.data.toString('base64'), mimeType: image.mediaType }
}

async function streamOnce(call, route, content) {
  const started = Date.now()
  let text = ''
  let usage = null
  let finish = undefined
  const iterable = call.llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content }]
  })
  for await (const chunk of iterable) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'reasoning-delta') continue
    else if (chunk.type === 'usage') usage = chunk.usage ?? null
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  return { text, usage, finish, ms: Date.now() - started }
}

async function callOpenAiCompatible(route, config, prompt, images, resolved) {
  const entry = resolved !== undefined
    ? resolved
    : (config.customRoutes || []).find((item) => item.name === route.model)
  if (entry === undefined) throw new Error('custom route "' + route.model + '" is not configured')
  const url = entry.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const content = [{ type: 'text', text: prompt }]
  for (const image of images) {
    content.push({
      type: 'image_url',
      image_url: { url: 'data:' + image.mediaType + ';base64,' + image.data.toString('base64') }
    })
  }
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream' }
  const bearer = entry.apiKey !== '' ? entry.apiKey : readCredentialRef(entry.apiKeyRef)
  if (bearer !== '') headers.authorization = 'Bearer ' + bearer
  if (isPlainObject(entry.headers)) {
    for (const [key, value] of Object.entries(entry.headers)) {
      if (typeof value === 'string') headers[key] = value
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({ model: entry.model, messages: [{ role: 'user', content }], stream: true })
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error('HTTP ' + response.status + ' from ' + entry.baseUrl + (detail === '' ? '' : ': ' + redactSecrets(detail).slice(0, 300)))
    }
    const contentType = String(response.headers.get('content-type') || '')
    if (!contentType.includes('event-stream')) {
      const data = await response.json()
      const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined
      const text = choice?.message?.content
      return {
        text: typeof text === 'string' ? text : '',
        usage: data?.usage ?? null,
        finish: choice?.finish_reason,
        ms: Date.now() - started
      }
    }
    let text = ''
    let usage = null
    let finish
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '' || payload === '[DONE]') continue
        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }
        const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined
        const delta = choice?.delta?.content
        if (typeof delta === 'string') text += delta
        if (chunk?.usage !== undefined && chunk.usage !== null) usage = chunk.usage
        if (typeof choice?.finish_reason === 'string') finish = choice.finish_reason
      }
    }
    return { text, usage, finish, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

function tokensOf(usage) {
  if (usage === null || typeof usage !== 'object') return { in: 0, out: 0 }
  const pick = (...keys) => {
    for (const key of keys) {
      const value = usage[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
    return 0
  }
  return {
    in: pick('inputTokens', 'input', 'promptTokens', 'prompt_tokens'),
    out: pick('outputTokens', 'output', 'completionTokens', 'completion_tokens')
  }
}

function composePrompt(config, options) {
  const requested = typeof options.task === 'string' ? options.task : ''
  const task = TASK_KEYS.includes(requested) ? requested : config.defaultTask
  const extra = typeof options.prompt === 'string' ? options.prompt.trim() : ''
  const parts = []
  if (config.promptPrefix.trim() !== '') parts.push(config.promptPrefix.trim())
  // task=auto: the caller owns the whole instruction. Sent verbatim, with no
  // template appended, because mixing the two produces contradictory rules.
  if (task === 'auto') {
    if (extra !== '') {
      parts.push(extra)
      return parts.join('\n\n')
    }
    parts.push(config.taskTemplates.describe || DEFAULTS.taskTemplates.describe)
    return parts.join('\n\n')
  }
  parts.push(config.taskTemplates[task] || DEFAULTS.taskTemplates.describe)
  if (extra !== '') parts.push('补充要求：' + extra)
  return parts.join('\n\n')
}

async function readImages(call, options) {
  const config = readConfig()
  if (!config.enabled) throw new Error('dsh-vision is switched off in its settings panel; enable it there first')

  const files = options.files
  if (!Array.isArray(files) || files.length === 0) throw new Error('vision_read needs at least one image path')
  if (files.length > config.maxImages) {
    throw new Error('too many images: ' + files.length + ', limit is ' + config.maxImages)
  }

  const images = []
  for (const file of files) images.push(await loadImage(file, config.maxImageBytes))

  const prompt = composePrompt(config, options)
  const candidates = []
  const explicit = options.route !== undefined ? options.route : config.route
  const primary = normalizeRoute(explicit)
  if (primary !== undefined) candidates.push(primary)
  if (primary === undefined) {
    // No route configured: fall back to whatever the host currently reports as
    // image-capable. This keeps a stock install working without the operator
    // having to name a provider first.
    let discovered = []
    try {
      discovered = await discoverRoutes(call.llm, false)
    } catch {
      discovered = []
    }
    for (const entry of discovered) {
      const route = normalizeRoute(entry.route)
      if (route !== undefined) candidates.push(route)
      if (!config.fallbackEnabled) break
    }
    if (candidates.length === 0) {
      throw new Error(
        'no vision route available: the host reports no image-capable model, and none is configured. ' +
          'Open the settings panel and pick a route, or add a custom API endpoint.'
      )
    }
  }
  if (options.route === undefined && config.fallbackEnabled) {
    for (const text of config.fallbacks) {
      const route = normalizeRoute(text)
      if (route !== undefined && !candidates.some((item) => routeText(item) === routeText(route))) candidates.push(route)
    }
  }
  if (candidates.length === 0) throw new Error('no vision route configured; pick one in the settings panel')

  const transports = config.transport === 'auto'
    ? (call.attachments !== null ? ['inline', 'attachment'] : ['inline'])
    : [config.transport]

  const failures = []
  for (const route of candidates) {
    const isCustom = route.provider === CUSTOM_PROVIDER
    const directEntry = isCustom ? undefined : resolveDirectRoute(route)
    const isDirect = directEntry !== undefined
    if (route.provider === DIRECT_PROVIDER && !isDirect) {
      failures.push(routeText(route) + ': 宿主 provider 里找不到这条直连路线（baseURL 或模型名不匹配）')
      continue
    }
    const isOpenAi = isCustom || isDirect
    const routeTransports = isOpenAi ? ['api'] : transports
    for (let index = 0; index < routeTransports.length; index += 1) {
      const transport = routeTransports[index]
      let content = null
      if (!isOpenAi) {
        try {
          content = [{ type: 'text', text: prompt }]
          for (const image of images) content.push(await imageBlockFor(transport, call.attachments, image))
        } catch (error) {
          failures.push(routeText(route) + ' (' + transport + '): ' + errorText(error))
          continue
        }
      }
      const started = Date.now()
      try {
        const result = isOpenAi
          ? await callOpenAiCompatible(route, config, prompt, images, directEntry)
          : await streamOnce(call, route, content)
        const tokens = tokensOf(result.usage)
        const chars = result.text.trim().length
        if (chars === 0) throw new Error('the model returned no text (finish: ' + finishText(result.finish) + ')')
        if (looksLikeMissingImage(result.text)) {
          throw new Error('the model could not see the image (finish: ' + finishText(result.finish) + ')')
        }
        const bytes = images.reduce((sum, image) => sum + image.bytes, 0)
        recordCall({
          at: Date.now(),
          route: routeText(route),
          ok: true,
          ms: result.ms,
          bytes,
          chars,
          images: images.length,
          transport,
          prompt,
          error: '',
          tokensIn: tokens.in,
          tokensOut: tokens.out
        })
        // Remember the transport that actually worked, so a wrong guess costs
        // one retry in total rather than one per call.
        if (config.transport === 'auto' && transport !== 'attachment') {
          try {
            const stored = readJson(CONFIG_FILE, {})
            if (stored.transport === undefined) {
              stored.transport = 'auto'
              await writeJsonAtomic(CONFIG_FILE, stored)
            }
          } catch {
            /* remembering is optional */
          }
        }
        return {
          ok: true,
          route: routeText(route),
          model: route.model,
          provider: route.provider,
          transport,
          ms: result.ms,
          bytes,
          images: images.map((image) => ({ path: image.path, mediaType: image.mediaType, bytes: image.bytes })),
          tokensIn: tokens.in,
          tokensOut: tokens.out,
          finish: result.finish === undefined ? null : finishText(result.finish),
          text: result.text.trim(),
          failures
        }
      } catch (error) {
        const message = errorText(error)
        failures.push(routeText(route) + ' (' + transport + '): ' + message)
        recordCall({
          at: Date.now(),
          route: routeText(route),
          ok: false,
          ms: Date.now() - started,
          bytes: images.reduce((sum, image) => sum + image.bytes, 0),
          chars: 0,
          images: images.length,
          transport,
          prompt,
          error: message,
          tokensIn: 0,
          tokensOut: 0
        })
        // A transport mismatch is worth exactly one retry with the other one.
        if (index < routeTransports.length - 1) continue
        break
      }
    }
  }
  throw new Error('every vision route failed:\n' + failures.join('\n'))
}

function renderResult(result, config) {
  const lines = []
  lines.push(result.text)
  if (config.verbosity === 'rich') {
    const parts = [
      'model ' + result.route,
      'transport ' + result.transport,
      (result.ms / 1000).toFixed(1) + 's',
      result.images.length + ' image(s)',
      Math.round(result.bytes / 1024) + ' KB'
    ]
    if (result.tokensIn + result.tokensOut > 0) {
      parts.push('tokens ' + result.tokensIn + '→' + result.tokensOut)
    }
    lines.push('')
    lines.push('[' + parts.join(' · ') + ']')
    if (result.failures.length > 0) {
      lines.push('[earlier attempts: ' + result.failures.join(' | ') + ']')
    }
  }
  return lines.join('\n')
}

// ------------------------------------------------------------------ routes

function isLoopback(req) {
  const host = String(req.headers.host || '')
  const hostName = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostName)) return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      const parsed = new URL(origin)
      return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
    } catch {
      return false
    }
  }
  return true
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(isPlainObject(parsed) ? parsed : {})
      } catch (error) {
        reject(new Error('invalid JSON body: ' + errorText(error)))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

function customModelEntries(config) {
  return (config.customRoutes || []).map((entry) => ({
    provider: CUSTOM_PROVIDER,
    model: entry.name,
    route: CUSTOM_PROVIDER + ROUTE_SEPARATOR + entry.name,
    name: entry.label + ' · ' + entry.model,
    description: '自定义 API · ' + entry.baseUrl,
    custom: true,
    vision: true
  }))
}

function configView() {
  const config = readConfig()
  return {
    ...config,
    customRoutes: config.customRoutes.map((entry) => {
      const view = { ...entry }
      delete view.apiKey
      view.apiKeySet = entry.apiKey !== ''
      view.apiKeyRef = entry.apiKeyRef || ''
      view.refFound = entry.apiKeyRef !== '' && readCredentialRef(entry.apiKeyRef) !== ''
      return view
    }),
    file: CONFIG_FILE
  }
}

function statsView() {
  const stats = readStats()
  const averageMs = stats.calls === 0 ? 0 : Math.round(stats.totalMs / stats.calls)
  return {
    ...stats,
    averageMs,
    successRate: stats.calls === 0 ? null : Math.round((stats.ok / stats.calls) * 1000) / 10
  }
}

async function statePayload(call) {
  const payload = {
    ok: true,
    version: '0.1.0',
    config: configView(),
    stats: statsView(),
    services: {
      llm: call.llm !== null,
      attachments: call.attachments !== null
    },
    provider: {
      id: 'dsh-vision',
      mounted: call.provider.mounted === true,
      error: call.provider.error
    },
    models: discovery.routes,
    otherModels: discovery.other,
    directModels: directModelList(),
    profileDir: PROFILE_DIR,
    discoveryAt: discovery.at,
    home: HOME
  }
  if (call.llm !== null) {
    try {
      payload.models = await discoverRoutes(call.llm, false)
      payload.otherModels = discovery.other
      payload.discoveryAt = discovery.at
    } catch (error) {
      payload.modelsError = errorText(error)
    }
  }
  const custom = customModelEntries(readConfig())
  payload.models = [...(payload.models || []), ...custom]
  // Which settings are re-read on every call and which ones are frozen into the
  // boot-time tool registration. The panel shows this next to each control.
  payload.hotKeys = ['enabled', 'route', 'fallbackEnabled', 'fallbacks', 'transport', 'customRoutes',
    'timeoutMs', 'maxImageBytes', 'maxImages', 'promptPrefix', 'defaultTask', 'taskTemplates',
    'verbosity', 'recordLog', 'logLimit']
  payload.restartKeys = ['toolName']
  payload.taskKeys = TASK_KEYS
  payload.defaultTaskTemplates = DEFAULTS.taskTemplates
  return payload
}

function applyConfigPatch(patch) {
  const stored = readJson(CONFIG_FILE, {})
  const next = { ...stored }
  const dropped = []
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) {
      dropped.push(key)
      continue
    }
    if (value === undefined || value === null || value === '') {
      delete next[key]
      continue
    }
    if (key === 'customRoutes' && Array.isArray(value)) {
      // The panel never receives api keys back, so an empty apiKey on an
      // existing route means "keep the stored one".
      const known = normalizeCustomRoutes(next.customRoutes)
      next[key] = value.map((entry) => {
        if (!isPlainObject(entry)) return entry
        const copy = { ...entry }
        const name = typeof copy.name === 'string' ? copy.name.trim().toLowerCase() : ''
        const previous = known.find((item) => item.name === name)
        if (previous !== undefined && (copy.apiKey === undefined || copy.apiKey === '')) {
          copy.apiKey = previous.apiKey
        }
        if (previous !== undefined && (copy.apiKeyRef === undefined || copy.apiKeyRef === '')) {
          copy.apiKeyRef = previous.apiKeyRef
        }
        return copy
      })
      continue
    }
    next[key] = value
  }
  const normalized = normalizeConfig({ ...DEFAULTS, ...next })
  return { stored: next, normalized, dropped }
}

// --------------------------------------------------------------- the plugin

// --- restarting the host -----------------------------------------------------
//
// The host has no reload API: a plugin row's fiber has an internal restart()
// but it is not reachable from plugin code, and dshmarket's hotUnmount only
// disposes plugins that were hot-mounted in this same session (boot-mounted
// rows are not in its handle table, so it returns false). What is reachable is
// the process itself: a detached cmd script that waits a moment, kills the
// application by image name and starts process.execPath again. It is the same
// thing the menu's restart item does, minus the menu.

const RESTART_SCRIPT = path.join(HOME, 'restart.cmd')

function restartScriptBody() {
  const exe = process.execPath
  const imageName = path.basename(exe)
  return [
    '@echo off',
    'rem Written by dsh-vision. Detached: it must outlive the application it kills.',
    'timeout /t 2 /nobreak >nul',
    'taskkill /IM "' + imageName + '" /F >nul 2>&1',
    'timeout /t 2 /nobreak >nul',
    'start "" "' + exe + '"',
    ''
  ].join('\r\n')
}

async function scheduleRestart(call) {
  await ensureHome()
  await fsp.writeFile(RESTART_SCRIPT, restartScriptBody(), { encoding: 'utf8', mode: 0o600 })
  // Escape hatch for tests and for anyone who wants to inspect the script first.
  if (process.env.DSH_VISION_NO_RESTART === '1') {
    return { ok: true, restarting: false, dryRun: true, delayMs: 2000, script: RESTART_SCRIPT }
  }
  const spawnFn = typeof call.spawnRestart === 'function' ? call.spawnRestart : spawn
  const child = spawnFn('cmd.exe', ['/c', RESTART_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  if (child !== null && typeof child.unref === 'function') child.unref()
  return { ok: true, restarting: true, delayMs: 2000, script: RESTART_SCRIPT }
}

export function apply(ctx, pluginConfig = {}) {
  const call = {
    llm: null,
    attachments: null,
    spawnRestart: null,
    provider: { mounted: false, error: null, released: false },
    providerHandle: null,
    pluginConfig: isPlainObject(pluginConfig) ? pluginConfig : {}
  }

  ensureHome()

  // Seed the config file from the cordis row on first boot, so the panel has
  // something to show and the row is the documented place for defaults.
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      const seed = {}
      for (const key of Object.keys(DEFAULTS)) {
        if (call.pluginConfig[key] !== undefined) seed[key] = call.pluginConfig[key]
      }
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(seed, null, 2) + '\n', { mode: 0o600 })
    }
  } catch (error) {
    console.error('[dsh-vision] could not seed ' + CONFIG_FILE + ': ' + errorText(error))
  }

  const registerTool = (scope) => {
    const config = readConfig()
    const toolName = config.toolName
    const tool = {
      name: toolName,
      description:
        'Read one or more local images with a vision model the host already has (or a custom OpenAI-compatible endpoint configured in its panel). ' +
        'Use it when a message points at a screenshot, photo, chart, diagram, scanned page or UI mock-up and the current model cannot see images, ' +
        'or when a second, cheaper or more literal read of an image would help. ' +
        'Prefer the "task" argument over writing your own prompt: the built-in task templates are tuned for faithful extraction and behave the same in every session. ' +
        'Only add "prompt" for extra requirements a task does not cover. ' +
        'Returns the transcript plus which route answered. Local files only.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute local path of one image (PNG/JPEG/GIF/WEBP).' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Several image paths read in one call (a multi-page scan, two screenshots to compare).'
          },
          task: {
            type: 'string',
            enum: TASK_KEYS,
            description:
              'What kind of read you need. describe = faithful scene/photo breakdown with verbatim text; ' +
              'text = OCR only, no description; ui = software screenshot inventory (controls, states, labels); ' +
              'chart = axes, series and readable values; diff = compare these images and list what changed; ' +
              'question = answer a specific question strictly from what is visible; ' +
              'auto = you write the whole instruction yourself in "prompt" (sent verbatim, no template added) — ' +
              'use it only when no built-in task fits.'
          },
          prompt: {
            type: 'string',
            description:
              'Optional extra requirement appended to the task template (for example "只关心左上角的错误提示"). ' +
              'With task=auto this is required and becomes the entire instruction. ' +
              'Leave empty otherwise unless the task templates really do not cover what you need.'
          },
          route: {
            type: 'string',
            description: 'Override the configured route for this call, as "provider/model" or "custom/<name>".'
          }
        }
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            route: { type: 'string' },
            ok: { type: 'boolean' }
          },
          required: ['text']
        },
        render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : String(value) }]
      },
      timeoutMs: 300000,
      isConcurrencySafe: () => true,
      presentCall: (args) => {
        const list = []
        if (typeof args?.path === 'string') list.push(args.path)
        if (Array.isArray(args?.paths)) for (const entry of args.paths) if (typeof entry === 'string') list.push(entry)
        return {
          card: 'generic',
          title: toolName,
          kind: 'read',
          rawInput: args,
          ...(list.length > 0 ? { locations: list.map((file) => ({ path: file })) } : {})
        }
      },
      async execute(args) {
        const files = []
        if (typeof args?.path === 'string' && args.path.trim() !== '') files.push(args.path.trim())
        if (Array.isArray(args?.paths)) {
          for (const entry of args.paths) {
            if (typeof entry === 'string' && entry.trim() !== '') files.push(entry.trim())
          }
        }
        const config = readConfig()
        const result = await readImages(call, {
          files,
          task: typeof args?.task === 'string' ? args.task : undefined,
          prompt: typeof args?.prompt === 'string' ? args.prompt : undefined,
          route: typeof args?.route === 'string' ? args.route : undefined
        })
        return { ok: true, route: result.route, text: renderResult(result, config) }
      }
    }
    try {
      scope.tools.register(tool)
    } catch (error) {
      console.error('[dsh-vision] tool registration failed: ' + errorText(error))
    }
  }

  // Tools and LLM are resolved independently: losing one must not take the
  // panel down, and the panel must still explain what is missing.
  if (typeof ctx.inject !== 'function') {
    if (ctx.tools && typeof ctx.tools.register === 'function') registerTool(ctx)
  } else {
    ctx.inject(['llm'], (scope) => {
      call.llm = scope.llm
      mountProvider(call).catch((error) => {
        call.provider.error = errorText(error)
        console.error('[dsh-vision] could not register the LLM provider: ' + call.provider.error)
      })
    })
    ctx.inject(['attachments'], (scope) => {
      call.attachments = scope.attachments ?? null
    })
    ctx.inject(['tools'], (scope) => {
      registerTool(scope)
    })
    ctx.inject(['webServer'], (scope) => {
      const routes = [
        {
          path: '/dsh-vision/state',
          handler: async (req, res) => {
            if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
            sendJson(res, 200, await statePayload(call))
          }
        },
        {
          path: '/dsh-vision/config',
          handler: async (req, res) => {
            if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
            try {
              const body = await readBody(req, 262144)
              const patch = isPlainObject(body.patch) ? body.patch : body
              const applied = applyConfigPatch(patch)
              await writeJsonAtomic(CONFIG_FILE, applied.stored)
              sendJson(res, 200, {
                ok: true,
                config: configView(),
                dropped: applied.dropped,
                state: await statePayload(call)
              })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: errorText(error) })
            }
          }
        },
        {
          path: '/dsh-vision/models',
          handler: async (req, res) => {
            if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
            if (call.llm === null) return sendJson(res, 503, { ok: false, error: 'the llm service is not mounted' })
            try {
              const models = await discoverRoutes(call.llm, true)
              sendJson(res, 200, { ok: true, models, otherModels: discovery.other, discoveryAt: discovery.at })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: errorText(error) })
            }
          }
        },
        {
          path: '/dsh-vision/probe',
          handler: async (req, res) => {
            if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
            try {
              const body = await readBody(req, 262144)
              if (call.llm === null) throw new Error('the llm service is not mounted')
              const color = TEST_COLORS[Math.floor(Math.random() * TEST_COLORS.length)]
              const png = solidPng(160, 120, color.rgb)
              const file = path.join(HOME, 'selftest-' + Date.now() + '.png')
              await fsp.writeFile(file, png, { mode: 0o600 })
              const route = typeof body.route === 'string' && body.route.trim() !== ''
                ? body.route.trim()
                : readConfig().route
              const result = await readImages(call, {
                files: [file],
                prompt: 'What colour fills this image? Answer with one word.',
                route
              })
              const answer = result.text.toLowerCase()
              const matched = answer.includes(color.zh) || answer.includes(color.en)
              sendJson(res, 200, {
                ok: true,
                matched,
                expected: color.en,
                answer: result.text.slice(0, 400),
                route: result.route,
                transport: result.transport,
                ms: result.ms
              })
            } catch (error) {
              sendJson(res, 502, { ok: false, error: errorText(error) })
            }
          }
        },
        {
          path: '/dsh-vision/stats/reset',
          handler: async (req, res) => {
            if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
            statsCache = emptyStats()
            try {
              await writeJsonAtomic(STATS_FILE, statsCache)
            } catch (error) {
              return sendJson(res, 500, { ok: false, error: errorText(error) })
            }
            sendJson(res, 200, { ok: true, stats: statsView() })
          }
        },
        {
          path: '/dsh-vision/log/clear',
          handler: async (req, res) => {
            if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
            const stats = readStats()
            stats.log = []
            persistStatsSoon()
            sendJson(res, 200, { ok: true, stats: statsView() })
          }
        },
        {
          path: '/dsh-vision/restart',
          handler: async (req, res) => {
            if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
            try {
              const info = await scheduleRestart(call)
              sendJson(res, 200, info)
            } catch (error) {
              sendJson(res, 500, { ok: false, error: errorText(error) })
            }
          }
        },
        {
          // 给「自定义 API」用：由宿主代发 GET {baseUrl}/models，避开浏览器跨域。
          path: '/dsh-vision/custom-models',
          handler: async (req, res) => {
            if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
            try {
              const body = (await readBody(req, 262144)) || {}
              const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim().replace(/\/+$/, '') : ''
              if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
                return sendJson(res, 400, { ok: false, error: '接口地址要以 http(s):// 开头' })
              }
              const bearer = typeof body.apiKey === 'string' && body.apiKey !== ''
                ? body.apiKey
                : readCredentialRef(typeof body.apiKeyRef === 'string' ? body.apiKeyRef.trim() : '')
              const headers = { accept: 'application/json' }
              if (bearer !== '') headers.authorization = 'Bearer ' + bearer
              const controller = new AbortController()
              const timer = setTimeout(() => controller.abort(), 20000)
              if (typeof timer.unref === 'function') timer.unref()
              try {
                const response = await fetch(baseUrl + '/models', { headers, signal: controller.signal })
                const text = await response.text()
                if (!response.ok) {
                  return sendJson(res, 200, {
                    ok: false,
                    status: response.status,
                    error: '上游返回 ' + response.status + '：' + redactSecrets(text).slice(0, 300)
                  })
                }
                let parsed
                try {
                  parsed = JSON.parse(text)
                } catch {
                  return sendJson(res, 200, { ok: false, error: '返回的不是 JSON：' + redactSecrets(text).slice(0, 200) })
                }
                const list = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : []
                const models = list
                  .map((item) => (typeof item === 'string' ? item : item && item.id))
                  .filter((id) => typeof id === 'string' && id !== '')
                sendJson(res, 200, { ok: true, models, count: models.length })
              } finally {
                clearTimeout(timer)
              }
            } catch (error) {
              sendJson(res, 200, { ok: false, error: errorText(error) })
            }
          }
        },
        {
          // 宿主 provider 的直连候选：baseURL + apiKeyEnv 全部来自宿主自己的配置，
          // 让面板能"测试哪个模型真能看图"，而不是让人手工抄地址和密钥。
          path: '/dsh-vision/host-models',
          handler: async (req, res) => {
            if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
            if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
            try {
              sendJson(res, 200, { ok: true, models: directModelList(), profileDir: PROFILE_DIR })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: errorText(error) })
            }
          }
        },
        {
          // 用一张纯色测试图真的打一次请求，回答的颜色对得上才算"能看图"。
          path: '/dsh-vision/detect',
          handler: async (req, res) => {
            if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
            try {
              const body = (await readBody(req, 262144)) || {}
              const wanted = typeof body.route === 'string' ? body.route.trim() : ''
              const parsed = normalizeRoute(wanted)
              if (parsed === undefined) {
                return sendJson(res, 400, { ok: false, error: 'route 要写成 direct/<provider>/<model>' })
              }
              const color = TEST_COLORS[Math.floor(Math.random() * TEST_COLORS.length)]
              const png = solidPng(160, 120, color.rgb)
              const file = path.join(HOME, 'detect-' + Date.now() + '.png')
              await fsp.writeFile(file, png, { mode: 0o600 })
              let result
              try {
                result = await readImages(call, {
                  files: [file],
                  prompt: 'What colour fills this image? Answer with one word.',
                  route: wanted
                })
              } finally {
                await fsp.unlink(file).catch(() => undefined)
              }
              const answer = String(result.text || '').toLowerCase()
              const matched = answer.includes(color.zh) || answer.includes(color.en)
              const map = readDetections()
              map[wanted] = { ok: matched, answer: answer.slice(0, 160), at: Date.now(), ms: result.ms }
              await writeDetections(map)
              sendJson(res, 200, {
                ok: true,
                matched,
                route: wanted,
                expected: color.zh,
                answer: answer.slice(0, 200),
                ms: result.ms
              })
            } catch (error) {
              sendJson(res, 200, { ok: false, error: errorText(error) })
            }
          }
        }
      ]
      for (const route of routes) {
        try {
          const routeName = route.path.replace(/^\//, '').replace(/\//g, '-')
          scope.webServer.register({ name: routeName, kind: 'exact', path: route.path, handler: route.handler })
        } catch (error) {
          console.error('[dsh-vision] route ' + route.path + ' skipped: ' + errorText(error))
        }
      }
    })
  }
}