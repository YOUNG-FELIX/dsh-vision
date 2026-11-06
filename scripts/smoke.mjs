// dsh-vision smoke test — no browser, no network, no real LLM.
//
// Boots the host half against a fake cordis context (fake llm / attachments /
// tools / webServer), then drives the loopback handlers the panel uses plus the
// tool itself. Writes into a throwaway USERPROFILE so the real ~/.dsh state is
// never touched.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const REAL_PROFILE = process.env.USERPROFILE || os.homedir()
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vision-smoke-'))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition === true, detail: detail === undefined ? '' : String(detail) })
}

const plugin = await import('../lib/index.js')

// --------------------------------------------------------------- fake cordis

const registered = { tools: [], routes: new Map() }
const llmCalls = []
const fake = { script: ['这是蓝色的一张图。'], failNext: false, failAlways: false, attachmentsBroken: false, placeholderOnce: false, lastError: '' }

const fakeLlm = {
  listProviders: () => [{ id: 'alpha' }, { id: 'beta' }, { id: 'textonly' }],
  listModels: async (provider) => {
    if (provider === 'alpha') return [{ id: 'alpha-vision', name: 'Alpha Vision' }, { id: 'alpha-text' }]
    if (provider === 'beta') return [{ id: 'beta-vision' }]
    return [{ id: 'plain-text' }]
  },
  resolveModelInfo: async (provider, model) => {
    const vision = ['alpha-vision', 'beta-vision'].includes(model)
    return { inputModalities: vision ? ['text', 'image'] : ['text'] }
  },
  stream: async function* (options) {
    llmCalls.push(options)
    if (fake.failAlways || fake.failNext) {
      fake.failNext = false
      throw new Error('upstream explode')
    }
    if (fake.placeholderOnce) {
      fake.placeholderOnce = false
      yield { type: 'text-delta', index: 0, text: '[image omitted because this model accepts text only; attachment sha256:aaaaaaaa]' }
      yield { type: 'finish', reason: 'stop' }
      return
    }
    for (const text of fake.script) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
    }
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 8 } }
    yield { type: 'finish', reason: 'stop' }
  }
}

const fakeAttachments = {
  saveImage: async (input) => {
    if (fake.attachmentsBroken) throw new Error('attachment store offline')
    return {
      attachmentId: 'sha256:' + 'a'.repeat(64),
      mediaType: input.mediaType,
      width: 1,
      height: 1,
      bytes: input.data.length,
      name: input.name
    }
  }
}

class FakeRequest {
  constructor(method, body, headers) {
    this.method = method
    this.headers = Object.assign({ host: '127.0.0.1:5694' }, headers || {})
    this._body = body === undefined ? null : Buffer.from(JSON.stringify(body))
    this._listeners = {}
  }
  on(event, handler) {
    this._listeners[event] = handler
    return this
  }
  destroy() {}
  dispatch() {
    if (this._body !== null) this._listeners.data?.(this._body)
    this._listeners.end?.()
  }
}

const fakeCtx = {
  inject: (names, callback) => {
    const scope = {}
    if (names.includes('llm')) scope.llm = fakeLlm
    if (names.includes('attachments')) scope.attachments = fakeAttachments
    if (names.includes('tools')) {
      scope.tools = { register: (tool) => registered.tools.push(tool) }
    }
    if (names.includes('webServer')) {
      scope.webServer = { register: (route) => registered.routes.set(route.path, route.handler) }
    }
    callback(scope)
  }
}

plugin.apply(fakeCtx, { route: 'alpha/alpha-vision' })

async function callRoute(routePath, method, body, headers) {
  const handler = registered.routes.get(routePath)
  if (handler === undefined) throw new Error('route not registered: ' + routePath)
  const req = new FakeRequest(method, body, headers)
  const captured = { status: 0, headers: {}, body: '' }
  const res = {
    statusCode: 0,
    setHeader: (key, value) => {
      captured.headers[key] = value
    },
    end: (text) => {
      captured.body = text === undefined ? '' : String(text)
    }
  }
  const pending = handler(req, res)
  req.dispatch()
  await pending
  captured.status = res.statusCode
  let parsed = null
  try {
    parsed = JSON.parse(captured.body)
  } catch {
    parsed = null
  }
  return { status: captured.status, body: parsed, raw: captured.body }
}

// ------------------------------------------------------------------- tests

check('tool registered', registered.tools.length === 1, registered.tools.map((t) => t.name).join(','))
check('tool name defaults to vision_read', registered.tools[0]?.name === 'vision_read', registered.tools[0]?.name)
check('ten panel routes registered', registered.routes.size === 10, [...registered.routes.keys()].join(' '))

const state = await callRoute('/dsh-vision/state', 'GET')
check('state 200', state.status === 200, state.status)
check('state reports llm mounted', state.body?.services?.llm === true, JSON.stringify(state.body?.services))
check('state reports attachments mounted', state.body?.services?.attachments === true, JSON.stringify(state.body?.services))
check('vision models discovered (2 of 4)', state.body?.models?.length === 2, JSON.stringify(state.body?.models?.map((m) => m.route)))
check('text-only model excluded', (state.body?.models ?? []).every((m) => m.route !== 'textonly/plain-text'), '')
check('undeclared models listed separately (2 of 4)', state.body?.otherModels?.length === 2, JSON.stringify(state.body?.otherModels?.map((m) => m.route)))
check('undeclared list keeps the text-only model', (state.body?.otherModels ?? []).some((m) => m.route === 'textonly/plain-text'), JSON.stringify(state.body?.otherModels?.map((m) => m.route)))
check('vision list entries flagged vision', (state.body?.models ?? []).every((m) => m.vision === true || m.custom === true), JSON.stringify(state.body?.models?.map((m) => [m.route, m.vision])))

const modelsRoute = await callRoute('/dsh-vision/models', 'GET')
check('models route returns both groups', modelsRoute.body?.models?.length === 2 && modelsRoute.body?.otherModels?.length === 2, JSON.stringify([modelsRoute.body?.models?.length, modelsRoute.body?.otherModels?.length]))

const saved = await callRoute('/dsh-vision/config', 'POST', {
  patch: { route: 'beta/beta-vision', maxImages: 2, transport: 'inline', fallbacks: ['alpha/alpha-vision', 'bad-entry'], bogusKey: 1 }
})
check('config save 200', saved.status === 200, saved.status)
check('config persisted route', saved.body?.config?.route === 'beta/beta-vision', saved.body?.config?.route)
check('fallback list normalized', JSON.stringify(saved.body?.config?.fallbacks) === JSON.stringify(['alpha/alpha-vision']), JSON.stringify(saved.body?.config?.fallbacks))
check('unknown key reported as dropped', (saved.body?.dropped ?? []).includes('bogusKey'), JSON.stringify(saved.body?.dropped))

const configFile = path.join(sandbox, '.dsh', 'dsh-vision', 'config.json')
const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'))
check('config.json written on disk', onDisk.route === 'beta/beta-vision', JSON.stringify(onDisk))

const imagePath = path.join(sandbox, 'shot.png')
fs.writeFileSync(imagePath, PNG_1x1)
const tool = registered.tools[0]

const toolResult = await tool.execute({ path: imagePath, prompt: '图里是什么颜色？' })
check('tool returns model text', typeof toolResult?.text === 'string' && toolResult.text.includes('蓝色'), (toolResult?.text ?? '').slice(0, 120))
check('tool reports route', toolResult?.route === 'beta/beta-vision', toolResult?.route)
check('result renders metadata line', typeof toolResult?.text === 'string' && toolResult.text.includes('model beta/beta-vision'), (toolResult?.text ?? '').slice(-160))

const inlineCall = llmCalls[llmCalls.length - 1]
const inlineBlocks = inlineCall?.messages?.[0]?.content ?? []
check('llm got an inline base64 image block', inlineBlocks.some((block) => block.type === 'image' && typeof block.data === 'string' && block.mimeType === 'image/png'), JSON.stringify(inlineBlocks.map((b) => b.type)))
check('prompt carried through', String(inlineBlocks[0]?.text ?? '').includes('图里是什么颜色'), inlineBlocks[0]?.text)

let refused = ''
try {
  await tool.execute({ path: configFile })
} catch (error) {
  refused = String(error?.message ?? error)
}
check('non-image refused by magic bytes', refused.includes('magic bytes'), refused)

await callRoute('/dsh-vision/config', 'POST', { patch: { enabled: false } })
let disabledError = ''
try {
  await tool.execute({ path: imagePath })
} catch (error) {
  disabledError = String(error?.message ?? error)
}
check('disabled plugin refuses', disabledError.includes('switched off'), disabledError)

await callRoute('/dsh-vision/config', 'POST', { patch: { enabled: true, transport: 'auto', fallbackEnabled: false } })

// auto transport: inline block first, attachment is the fallback
const attached = await tool.execute({ path: imagePath })
const attachmentCall = llmCalls[llmCalls.length - 1]
const attachmentBlocks = attachmentCall?.messages?.[0]?.content ?? []
check('auto transport starts with inline block', attachmentBlocks.some((block) => block.type === 'image' && typeof block.data === 'string'), JSON.stringify(attachmentBlocks.map((b) => Object.keys(b))))
check('attachment result renders', typeof attached?.text === 'string' && attached.text.includes('蓝色'), '')

// a "model accepts text only" placeholder is not an answer: retry the other shape
fake.placeholderOnce = true
const retried = await tool.execute({ path: imagePath })
const retryCall = llmCalls[llmCalls.length - 1]
const retryBlocks = retryCall?.messages?.[0]?.content ?? []
check('placeholder answer retried with attachment', /transport attachment/.test(String(retried?.text)), String(retried?.text).slice(0, 160))
check('retried call actually carries the attachment', retryBlocks.some((block) => block.type === 'image' && block.attachment !== undefined), JSON.stringify(retryBlocks.map((b) => Object.keys(b))))
check('retry keeps the answer', typeof retried?.text === 'string' && retried.text.includes('蓝色'), '')

// auto transport: broken attachment store must fall back to inline
fake.attachmentsBroken = true
const fellBack = await tool.execute({ path: imagePath })
const fallbackCall = llmCalls[llmCalls.length - 1]
const fallbackBlocks = fallbackCall?.messages?.[0]?.content ?? []
check('broken attachments falls back to inline', fallbackBlocks.some((block) => block.type === 'image' && typeof block.data === 'string'), JSON.stringify(fallbackBlocks.map((b) => Object.keys(b))))
check('fallback keeps the answer', typeof fellBack?.text === 'string' && fellBack.text.includes('蓝色'), '')
fake.attachmentsBroken = false

// hard failure is reported and counted
fake.failAlways = true
let hardError = ''
try {
  await tool.execute({ path: imagePath })
} catch (error) {
  hardError = String(error?.message ?? error)
}
check('hard failure surfaced', hardError.includes('every vision route failed') && hardError.includes('upstream explode'), hardError.slice(0, 200))
fake.failAlways = false

// probe
fake.script = ['red green blue']
const probe = await callRoute('/dsh-vision/probe', 'POST', {})
check('probe 200', probe.status === 200, probe.status + ' ' + probe.raw.slice(0, 160))
check('probe matched colour', probe.body?.matched === true, JSON.stringify(probe.body))
check('probe used the inline transport', probe.body?.transport === 'inline', probe.body?.transport)

// guards
const blockedHost = await callRoute('/dsh-vision/state', 'GET', undefined, { host: 'evil.example.com' })
check('non-loopback host rejected', blockedHost.status === 403, blockedHost.status)
const blockedOrigin = await callRoute('/dsh-vision/state', 'GET', undefined, { origin: 'https://evil.example.com' })
check('cross-origin rejected', blockedOrigin.status === 403, blockedOrigin.status)

// statistics
const after = await callRoute('/dsh-vision/state', 'GET')
const stats = after.body?.stats ?? {}
check('stats count calls', (stats.calls ?? 0) >= 4, stats.calls)
check('stats count the hard failure', (stats.fail ?? 0) >= 1, stats.fail)
check('stats keep a per-route bucket', Boolean(stats.byRoute?.['beta/beta-vision']), JSON.stringify(Object.keys(stats.byRoute ?? {})))
check('stats log populated', Array.isArray(stats.log) && stats.log.length >= 4, stats.log?.length)
check('stats record last error text', String(stats.lastError ?? '').includes('upstream explode'), stats.lastError)
await new Promise((resolve) => setTimeout(resolve, 700))
check('stats persisted to disk', fs.existsSync(path.join(sandbox, '.dsh', 'dsh-vision', 'stats.json')), '')

const reset = await callRoute('/dsh-vision/stats/reset', 'POST', {})
check('stats reset to zero', reset.body?.stats?.calls === 0, reset.body?.stats?.calls)

const emptyBody = await callRoute('/dsh-vision/config', 'POST', undefined, {})
check('empty body tolerated', emptyBody.status === 200, emptyBody.status)

// ------------------------------------------------------- restart (dry run)
//
// DSH_VISION_NO_RESTART keeps the smoke test from killing the host: the route
// still writes the script and answers, it just never spawns it.

process.env.DSH_VISION_NO_RESTART = '1'
const restart = await callRoute('/dsh-vision/restart', 'POST', {})
check('restart route answers', restart.status === 200 && restart.body?.ok === true, restart.status)
check('restart honours the dry-run switch', restart.body?.dryRun === true, JSON.stringify(restart.body))
check(
  'restart script written',
  fs.existsSync(path.join(sandbox, '.dsh', 'dsh-vision', 'restart.cmd')),
  ''
)
const restartGet = await callRoute('/dsh-vision/restart', 'GET', undefined, {})
check('restart rejects GET', restartGet.status === 405, restartGet.status)

const badBase = await callRoute('/dsh-vision/custom-models', 'POST', { baseUrl: 'ftp://nope' })
check('custom-models rejects a non-http base url', badBase.status === 400, badBase.status + ' ' + JSON.stringify(badBase.body))
const modelsGet = await callRoute('/dsh-vision/custom-models', 'GET', undefined, {})
check('custom-models rejects GET', modelsGet.status === 405, modelsGet.status)

const hostModels = await callRoute('/dsh-vision/host-models', 'GET')
check(
  'host-models lists host provider candidates',
  hostModels.status === 200 && hostModels.body?.ok === true && Array.isArray(hostModels.body.models),
  hostModels.status + ' n=' + (hostModels.body?.models || []).length
)
const detectBad = await callRoute('/dsh-vision/detect', 'POST', { route: 'nope' })
check('detect rejects a malformed route', detectBad.status === 400, detectBad.status)
const restartCross = await callRoute('/dsh-vision/restart', 'POST', {}, { host: 'evil.example', origin: 'https://evil.example' })
check('restart rejects cross-site', restartCross.status === 403, restartCross.status)
delete process.env.DSH_VISION_NO_RESTART

// ------------------------------- a custom OpenAI-compatible endpoint, live

{
  const http = await import('node:http')
  let seen = null
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      seen = {
        url: req.url,
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '自定义接口说：蓝色。' } }] }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const baseUrl = 'http://127.0.0.1:' + port + '/v1'

  const savedCustom = await callRoute('/dsh-vision/config', 'POST', {
    patch: {
      route: 'custom/local',
      transport: 'inline',
      fallbackEnabled: false,
      customRoutes: [{ name: 'local', label: '本地', baseUrl, model: 'vl-test', apiKey: 'secret-key' }]
    }
  })
  check('custom route saved', savedCustom.body?.config?.route === 'custom/local', savedCustom.body?.config?.route)
  check(
    'custom route api key masked',
    savedCustom.body?.config?.customRoutes?.[0]?.apiKey === undefined &&
      savedCustom.body?.config?.customRoutes?.[0]?.apiKeySet === true,
    JSON.stringify(savedCustom.body?.config?.customRoutes?.[0])
  )
  check(
    'custom route appears in the model list',
    Array.isArray(savedCustom.body?.state?.models) &&
      savedCustom.body.state.models.some((model) => model.route === 'custom/local'),
    JSON.stringify((savedCustom.body?.state?.models ?? []).map((model) => model.route))
  )
  check(
    'no response payload carries the raw api key',
    !JSON.stringify(savedCustom.body ?? {}).includes('secret-key'),
    'the saved config response echoed the key'
  )
  const afterState = await callRoute('/dsh-vision/state', 'GET')
  check(
    'state payload carries no raw api key',
    !JSON.stringify(afterState.body ?? {}).includes('secret-key'),
    'the state response echoed the key'
  )

  const custom = await tool.execute({ path: imagePath, prompt: '图里是什么颜色？' })
  check('custom route answers', typeof custom?.text === 'string' && custom.text.includes('自定义接口说'), (custom?.text ?? '').slice(0, 160))
  check('custom route posts to /chat/completions', seen?.url === '/v1/chat/completions', seen?.url)
  check('custom route sends bearer', seen?.auth === 'Bearer secret-key', seen?.auth)
  check('custom route sends the model name', seen?.body?.model === 'vl-test', seen?.body?.model)
  const imagePart = (seen?.body?.messages?.[0]?.content ?? []).find((part) => part.type === 'image_url')
  check(
    'custom route sends an inline image_url',
    typeof imagePart?.image_url?.url === 'string' && imagePart.image_url.url.startsWith('data:image/png;base64,'),
    (imagePart?.image_url?.url ?? '').slice(0, 32)
  )

  const resaved = await callRoute('/dsh-vision/config', 'POST', {
    patch: { customRoutes: [{ name: 'local', label: '本地', baseUrl, model: 'vl-test' }] }
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  const storedAgain = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  check(
    'an empty api key keeps the stored secret',
    (storedAgain.customRoutes ?? [])[0]?.apiKey === 'secret-key',
    JSON.stringify((storedAgain.customRoutes ?? [])[0]?.apiKey)
  )
  check('resave still masks the key', resaved.body?.config?.customRoutes?.[0]?.apiKeySet === true, String(resaved.body?.config?.customRoutes?.[0]?.apiKeySet))

  await new Promise((resolve) => server.close(resolve))
}

// ------------------------------------------- built-in task prompt templates

{
  const lastPrompt = () => {
    const call = llmCalls[llmCalls.length - 1]
    const parts = (call?.messages ?? [])[0]?.content ?? []
    const textPart = parts.find((part) => part.type === 'text')
    return typeof textPart?.text === 'string' ? textPart.text : ''
  }

  await callRoute('/dsh-vision/config', 'POST', {
    patch: { route: 'beta/beta-vision', transport: 'inline', fallbackEnabled: false }
  })

  await tool.execute({ path: imagePath, prompt: '只关心左上角' })
  const describePrompt = lastPrompt()
  check('default task uses the built-in describe template', describePrompt.includes('事实清单'), describePrompt.slice(0, 30))
  check('a model prompt is appended as 补充要求', describePrompt.includes('补充要求：只关心左上角'), describePrompt.slice(-40))

  await tool.execute({ path: imagePath, task: 'text' })
  check('task=text switches to the OCR template', lastPrompt().includes('只做文字转写'), lastPrompt().slice(0, 30))

  await tool.execute({ path: imagePath, task: 'ui' })
  check('task=ui switches to the UI template', lastPrompt().includes('软件界面截图'), lastPrompt().slice(0, 30))

  await tool.execute({ path: imagePath, task: 'chart' })
  check('task=chart switches to the chart template', lastPrompt().includes('坐标轴'), lastPrompt().slice(0, 30))

  await tool.execute({ path: imagePath, task: 'nonsense' })
  const fallbackPrompt = lastPrompt()
  check('an unknown task falls back to the default', fallbackPrompt.includes('事实清单'), fallbackPrompt.slice(0, 30))

  const savedTemplates = await callRoute('/dsh-vision/config', 'POST', {
    patch: { defaultTask: 'text', taskTemplates: { describe: '只看颜色，不要文字。' } }
  })
  check('task templates are editable', savedTemplates.body?.config?.taskTemplates?.describe === '只看颜色，不要文字。', savedTemplates.body?.config?.taskTemplates?.describe)
  check('untouched templates keep their defaults', String(savedTemplates.body?.config?.taskTemplates?.chart ?? '').includes('坐标轴'), '')
  await tool.execute({ path: imagePath })
  check('the edited default task is used when task is omitted', lastPrompt().includes('只做文字转写'), lastPrompt().slice(0, 30))

  // task=auto hands the whole instruction to the caller: it must be sent
  // verbatim, with no template glued on top.
  await tool.execute({ path: imagePath, task: 'auto', prompt: '只列出图中的红色物体。' })
  const autoPrompt = lastPrompt()
  check('task=auto sends the caller prompt verbatim', autoPrompt.trim() === '只列出图中的红色物体。', autoPrompt.slice(0, 40))
  check('task=auto does not append a template', !autoPrompt.includes('只做文字转写') && !autoPrompt.includes('事实清单'), autoPrompt.slice(-40))

  await tool.execute({ path: imagePath, task: 'auto', prompt: '' })
  // Empty auto falls back to the *configured* describe template, which this
  // suite has already replaced with "只看颜色，不要文字。".
  check('task=auto without a prompt falls back to the describe template', lastPrompt().trim() === '只看颜色，不要文字。', lastPrompt().slice(0, 30))
}

// ------------------------------------------------- provider adapter (LLM 注册)

{
  const { buildAdapter, PROVIDER_ID } = await import('../lib/provider.js')
  check('provider id is stable', PROVIDER_ID === 'dsh-vision', PROVIDER_ID)

  const served = []
  const adapter = buildAdapter({
    Base: class {},
    attributionHeaders: () => ({ 'x-app': 'dsh' }),
    getRoutes: () => [
      {
        name: 'fake',
        label: '假接口',
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'fake-vl',
        apiKey: 'test-key',
        headers: {},
        contextWindow: 8000,
        maxTokens: 512
      }
    ],
    resolveKey: async (route) => route.apiKey,
    readImage: async () => ({ bytes: Buffer.from('png-bytes'), mediaType: 'image/png' }),
    fetchImpl: async (url, init) => {
      served.push({ url, init })
      const NL = String.fromCharCode(10)
      const body = [
        'data: {"choices":[{"delta":{"content":"一张"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"测试图"}}],"usage":{"prompt_tokens":11,"completion_tokens":3}}',
        '',
        'data: [DONE]',
        ''
      ].join(NL) + NL
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
  })

  const models = await adapter.listModels(PROVIDER_ID)
  check(
    'adapter advertises the endpoint as an image model',
    models.length === 1 && models[0].id === 'fake-vl' && models[0].inputModalities.includes('image'),
    JSON.stringify(models[0])
  )

  /* The host throws INVALID_CATALOG unless every row carries provider === the
     registered route, a non-empty unique id, and a non-empty name. A missing
     label used to produce name:undefined and take the provider offline. */
  const dup = buildAdapter({
    Base: class {},
    getRoutes: () => [
      { name: 'a', baseUrl: 'http://127.0.0.1:1/v1', model: 'dup', label: '' },
      { name: 'b', baseUrl: 'http://127.0.0.1:1/v1', model: 'dup', label: '重复' },
      { name: 'c', baseUrl: '', model: 'nobase', label: 'x' },
      { name: 'd', baseUrl: 'http://127.0.0.1:1/v1', model: 'ok', label: '正常' }
    ],
    resolveKey: async () => 'k',
    fetchImpl: async () => {
      throw new Error('unused')
    }
  })
  check(
    'adapter rows satisfy the host catalog contract',
    (await dup.listModels(PROVIDER_ID)).every(
      (row) =>
        row.provider === PROVIDER_ID &&
        typeof row.id === 'string' &&
        row.id.length > 0 &&
        typeof row.name === 'string' &&
        row.name.length > 0
    ),
    JSON.stringify(await dup.listModels(PROVIDER_ID))
  )
  const dupRows = await dup.listModels(PROVIDER_ID)
  check('adapter drops duplicate ids', dupRows.filter((row) => row.id === 'dup').length === 1, JSON.stringify(dupRows.map((r) => r.id)))
  check('adapter drops rows without a base url', dupRows.every((row) => row.id !== 'nobase'), JSON.stringify(dupRows.map((r) => r.id)))
  check('adapter falls back to the model id as name', dupRows[0].name === 'dup', dupRows[0].name)

  const call = await adapter.prepareCall(PROVIDER_ID, 'fake-vl')
  check('prepareCall resolves one generation', typeof call.stream === 'function')

  const chunks = []
  for await (const chunk of call.stream({
    provider: PROVIDER_ID,
    model: 'fake-vl',
    messages: [
      { role: 'system', content: 'system text' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '描述这张图' },
          { type: 'image', attachment: 'sha256:abc' }
        ]
      }
    ]
  })) {
    chunks.push(chunk)
  }

  const kinds = chunks.map((chunk) => chunk.type)
  check(
    'adapter streams the harness chunk vocabulary',
    kinds[0] === 'block-start' && kinds.includes('text-delta') && kinds[kinds.length - 1] === 'finish',
    kinds.join(',')
  )
  check(
    'adapter joins the deltas into one block-end',
    chunks.some((chunk) => chunk.type === 'block-end' && chunk.block.text === '一张测试图')
  )

  const wire = served[0]
  const payload = JSON.parse(wire.init.body)
  check('adapter hits <baseUrl>/chat/completions', wire.url === 'http://127.0.0.1:1/v1/chat/completions', wire.url)
  check('adapter sends the bearer and attribution headers',
    wire.init.headers.authorization === 'Bearer test-key' && wire.init.headers['x-app'] === 'dsh')
  check('adapter streams with usage', payload.stream === true && payload.stream_options.include_usage === true)
  const userParts = payload.messages[1].content
  check(
    'adapter turns an image block into an image_url data URL',
    Array.isArray(userParts) &&
      userParts.some((part) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,'))
  )
  const usage = chunks.find((chunk) => chunk.type === 'usage')
  check('adapter reports usage', usage.usage.inputTokens === 11 && usage.usage.outputTokens === 3 && usage.usage.totalTokens === 14)

  const bad = buildAdapter({ Base: class {}, getRoutes: () => [], resolveKey: async () => undefined })
  let missing = ''
  try {
    for await (const _ of bad.stream({ model: 'nope', messages: [] })) void _
  } catch (error) {
    missing = String(error.message)
  }
  check('adapter refuses an unconfigured model', missing.includes('no custom endpoint'), missing)
}

// ------------------------------------------------------------------ summary

const failed = results.filter((entry) => entry.ok === false)
for (const entry of results) {
  console.log((entry.ok ? 'PASS ' : 'FAIL ') + entry.name + (entry.detail ? ' :: ' + entry.detail : ''))
}
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')

await fsp.rm(sandbox, { recursive: true, force: true })
process.env.USERPROFILE = REAL_PROFILE
process.exit(failed.length === 0 ? 0 : 1)