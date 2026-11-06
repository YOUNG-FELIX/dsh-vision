/**
 * Register the panel's custom OpenAI-compatible endpoints as a real DSH LLM
 * provider, so they show up in the host's model picker and receive images
 * natively (no `[image omitted …]` placeholder) instead of only being usable
 * through the vision_read tool.
 *
 * The adapter class extends whatever `LlmAdapter` the host exposes. That base
 * lives inside the host bundle, so it is imported dynamically by the caller and
 * injected here; the smoke test runs the same code against a stub base, which
 * keeps every code path testable without booting DSH.
 */

export const PROVIDER_ID = 'dsh-vision'
export const PROVIDER_NAME = '视觉自定义 API'

const DEFAULT_CONTEXT_WINDOW = 32000
const DEFAULT_MAX_TOKENS = 4096

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '')
}

function imageBytesToDataUrl(bytes, mediaType) {
  return 'data:' + (mediaType || 'image/png') + ';base64,' + Buffer.from(bytes).toString('base64')
}

/** Flatten one harness message into OpenAI chat/completions content. */
async function toOpenAiContent(content, readImage) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      const resolved = readImage === null ? null : await readImage(block)
      if (resolved === null) {
        parts.push({ type: 'text', text: '[image could not be read by this endpoint]' })
        continue
      }
      parts.push({ type: 'image_url', image_url: { url: imageBytesToDataUrl(resolved.bytes, resolved.mediaType) } })
    }
  }
  return parts.length === 0 ? '' : parts
}

/**
 * Build the adapter object registered through `ctx.llm.registerAdapter`.
 *
 * @param {object} options
 * @param {Function} options.Base harness `LlmAdapter` class (or a stub in tests)
 * @param {Function} [options.attributionHeaders] host helper for wire headers
 * @param {Function} options.getRoutes returns the current `customRoutes` array
 * @param {Function} options.resolveKey resolves a route's bearer token
 * @param {Function} [options.readImage] reads one image block to `{bytes, mediaType}`
 * @param {Function} [options.fetchImpl] fetch override (tests)
 * @param {Function} [options.onEvent] observability hook (tests / logging)
 */
export function buildAdapter(options) {
  const Base = typeof options.Base === 'function' ? options.Base : class {}
  const attributionHeaders = typeof options.attributionHeaders === 'function' ? options.attributionHeaders : () => ({})
  const getRoutes = options.getRoutes
  const resolveKey = options.resolveKey
  const readImage = options.readImage ?? null
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => undefined

  class DshVisionAdapter extends Base {
    providerInfo(provider) {
      return { id: provider, name: PROVIDER_NAME }
    }

    listModels(provider) {
      try {
        const routes = getRoutes() || []
        /* The host validates every row: model.provider must equal the provider
           route it was listed under, ids must be non-empty and unique, and the
           name must be a non-empty string. Anything else throws
           INVALID_CATALOG and the whole provider disappears from the picker. */
        const seen = new Set()
        const rows = []
        for (const route of routes) {
          if (!route || typeof route.baseUrl !== 'string' || route.baseUrl.length === 0) continue
          if (typeof route.model !== 'string' || route.model.length === 0) continue
          if (seen.has(route.model)) continue
          seen.add(route.model)
          const label = typeof route.label === 'string' && route.label.length > 0 ? route.label : route.model
          rows.push({
            provider,
            id: route.model,
            name: label,
            contextWindow: Number.isFinite(route.contextWindow) && route.contextWindow > 0 ? route.contextWindow : DEFAULT_CONTEXT_WINDOW,
            maxTokens: Number.isFinite(route.maxTokens) && route.maxTokens > 0 ? route.maxTokens : DEFAULT_MAX_TOKENS,
            inputModalities: ['text', 'image']
          })
        }
        return Promise.resolve(rows)
      } catch (error) {
        onEvent('listModels-failed', { error: String(error && error.message) })
        return Promise.resolve([])
      }
    }

    resolveModel(provider, model) {
      const route = (getRoutes() || []).find((item) => item.model === model)
      const label = route && typeof route.label === 'string' && route.label.length > 0 ? route.label : model
      return Promise.resolve({
        provider,
        id: typeof model === 'string' && model.length > 0 ? model : 'unknown',
        name: label,
        contextWindow: (route && route.contextWindow) || DEFAULT_CONTEXT_WINDOW,
        maxTokens: (route && route.maxTokens) || DEFAULT_MAX_TOKENS,
        inputModalities: ['text', 'image']
      })
    }

    async prepareCall(provider, model, signal) {
      const resolved = await this.resolveModel(provider, model, signal)
      return { model: resolved, stream: (request) => this.stream(request) }
    }

    /**
     * Bridge one harness generation to an OpenAI-compatible chat/completions
     * SSE stream. Yields the harness chunk vocabulary and always ends with
     * `usage` then `finish`.
     */
    async *stream(request) {
      const model = String(request && request.model)
      const route = (getRoutes() || []).find((item) => item.model === model)
      if (route === undefined) throw new Error('dsh-vision: no custom endpoint is configured for model "' + model + '"')

      const messages = []
      for (const message of Array.isArray(request.messages) ? request.messages : []) {
        const role = message && typeof message.role === 'string' ? message.role : 'user'
        if (role === 'system') {
          const content = await toOpenAiContent(message.content, readImage)
          messages.push({ role: 'system', content: typeof content === 'string' ? content : content.map((part) => part.text || '').join('\n') })
          continue
        }
        messages.push({ role, content: await toOpenAiContent(message.content, readImage) })
      }

      const key = await resolveKey(route)
      if (key === undefined || key === '') throw new Error('dsh-vision: the endpoint "' + route.name + '" has no API key')

      const headers = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: 'Bearer ' + key,
        ...attributionHeaders()
      }
      for (const [name, value] of Object.entries(route.headers || {})) headers[name] = value

      const controller = new AbortController()
      const onAbort = () => controller.abort()
      if (request.signal !== undefined) request.signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      const url = trimSlash(route.baseUrl) + '/chat/completions'
      let text = ''
      let inputTokens = 0
      let outputTokens = 0
      let started = false
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model,
            stream: true,
            stream_options: { include_usage: true },
            messages
          })
        })
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          throw new Error('HTTP ' + String(response.status) + ' from ' + url + ': ' + String(detail).slice(0, 300))
        }
        if (response.body === null || typeof response.body.getReader !== 'function') {
          throw new Error('dsh-vision: the endpoint returned no stream body')
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const step = await reader.read()
          if (step.done) break
          buffer += decoder.decode(step.value, { stream: true })
          let index
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim()
            buffer = buffer.slice(index + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '' || payload === '[DONE]') continue
            let parsed
            try {
              parsed = JSON.parse(payload)
            } catch {
              continue
            }
            if (parsed.usage !== undefined && parsed.usage !== null) {
              inputTokens = Number(parsed.usage.prompt_tokens || 0) || inputTokens
              outputTokens = Number(parsed.usage.completion_tokens || 0) || outputTokens
            }
            const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined
            const delta = choice && choice.delta ? choice.delta : undefined
            const piece = delta && typeof delta.content === 'string' ? delta.content : ''
            if (piece === '') continue
            if (!started) {
              started = true
              yield { type: 'block-start', index: 0, blockType: 'text' }
            }
            text += piece
            yield { type: 'text-delta', index: 0, text: piece }
          }
        }
        if (!started) yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield {
          type: 'usage',
          usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
        }
        yield { type: 'finish', reason: 'stop' }
      } finally {
        clearTimeout(timer)
        if (request.signal !== undefined) request.signal.removeEventListener('abort', onAbort)
      }
    }
  }

  return new DshVisionAdapter()
}