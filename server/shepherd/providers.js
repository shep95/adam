/**
 * Shepherd model providers behind one streaming interface.
 *
 * Every provider turns the same normalized conversation into its own wire
 * format and emits the same events:
 *   {type:'text', delta}
 *   {type:'tool_call', id, name, args}
 *   {type:'usage', inputTokens, outputTokens, cachedTokens}
 *
 * Normalized messages:
 *   {role:'user', text, images?:[{mime, data}]}
 *   {role:'assistant', text, toolCalls?:[{id, name, args}]}
 *   {role:'tool', toolCallId, name, result}
 */
import Anthropic from '@anthropic-ai/sdk';

const ENV = () => process.env;

export const PROVIDERS = Object.freeze({
  anthropic: {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-opus-5-5',
    vision: true,
    promptMode: 'full',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_CHAT_MODEL',
    defaultModel: 'gpt-5-mini',
    vision: true,
    promptMode: 'full',
    baseUrl: 'https://api.openai.com/v1',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini (Google)',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-2.5-flash',
    vision: true,
    promptMode: 'full',
  },
  venice: {
    id: 'venice',
    label: 'Venice',
    keyEnv: 'VENICE_API_KEY',
    modelEnv: 'VENICE_MODEL',
    defaultModel: 'llama-3.3-70b',
    vision: false,
    promptMode: 'core',
    baseUrl: 'https://api.venice.ai/api/v1',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    keyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    defaultModel: 'anthropic/claude-sonnet-4.6',
    vision: true,
    promptMode: 'full',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
});

/** Task routing: which providers to try, in order, for a kind of work. */
export const TASK_ROUTES = Object.freeze({
  chat: ['anthropic', 'openai', 'gemini', 'openrouter', 'venice'],
  osint: ['anthropic', 'openai', 'gemini', 'openrouter', 'venice'],
  vision: ['gemini', 'anthropic', 'openai', 'openrouter'],
  private: ['venice', 'anthropic', 'openai', 'gemini', 'openrouter'],
});

export function providerKey(id, env = ENV()) {
  const spec = PROVIDERS[id];
  if (!spec) return '';
  const value = String(env[spec.keyEnv] || '').trim();
  if (id === 'gemini' && !value)
    return String(env.GOOGLE_AI_API_KEY || '').trim();
  return value;
}

export function providerModel(id, requested, env = ENV()) {
  const spec = PROVIDERS[id];
  const safe =
    /^[A-Za-z0-9._:/@-]{1,120}$/.test(String(requested || '')) &&
    !String(requested).includes('..')
      ? String(requested)
      : '';
  return safe || String(env[spec.modelEnv] || '').trim() || spec.defaultModel;
}

/** Providers with a key, ordered for the task; `preferred` goes first. */
export function routeProviders(task, preferred, env = ENV()) {
  const order = [...(TASK_ROUTES[task] || TASK_ROUTES.chat)];
  if (preferred && PROVIDERS[preferred]) {
    const i = order.indexOf(preferred);
    if (i >= 0) order.splice(i, 1);
    order.unshift(preferred);
  }
  return order.filter((id) => providerKey(id, env));
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Split a byte stream of server-sent events into `data:` payloads. */
export async function* sseData(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer +=
      typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const event = buffer.slice(0, index);
      buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, '');
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) yield data;
    }
  }
  const tail = buffer
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (tail) yield tail;
}

// ── OpenAI-compatible (OpenAI, Venice, OpenRouter) ───────────────────────────

export function openAiMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      const images = Array.isArray(m.images) ? m.images : [];
      out.push({
        role: 'user',
        content: images.length
          ? [
              ...images.map((img) => ({
                type: 'image_url',
                image_url: { url: `data:${img.mime};base64,${img.data}` },
              })),
              { type: 'text', text: m.text || '' },
            ]
          : m.text || '',
      });
    } else if (m.role === 'assistant') {
      const message = { role: 'assistant', content: m.text || '' };
      if (m.toolCalls?.length)
        message.tool_calls = m.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args || {}),
          },
        }));
      out.push(message);
    } else if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: String(m.result ?? ''),
      });
    }
  }
  return out;
}

export async function* parseOpenAiStream(body) {
  const calls = new Map();
  for await (const data of sseData(body)) {
    if (data === '[DONE]') break;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = json.choices?.[0];
    const delta = choice?.delta || {};
    if (typeof delta.content === 'string' && delta.content)
      yield { type: 'text', delta: delta.content };
    for (const part of delta.tool_calls || []) {
      const slot = calls.get(part.index) || { id: '', name: '', args: '' };
      if (part.id) slot.id = part.id;
      if (part.function?.name) slot.name += part.function.name;
      if (part.function?.arguments) slot.args += part.function.arguments;
      calls.set(part.index, slot);
    }
    if (json.usage)
      yield {
        type: 'usage',
        inputTokens: json.usage.prompt_tokens || 0,
        outputTokens: json.usage.completion_tokens || 0,
        cachedTokens: json.usage.prompt_tokens_details?.cached_tokens || 0,
      };
  }
  for (const [, slot] of [...calls].sort((a, b) => a[0] - b[0])) {
    if (slot.name)
      yield {
        type: 'tool_call',
        id: slot.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: slot.name,
        args: parseArgs(slot.args),
      };
  }
}

async function* streamOpenAiCompatible(
  spec,
  { key, model, system, messages, tools, signal, fetchImpl },
) {
  const body = {
    model,
    stream: true,
    messages: openAiMessages(system, messages),
    ...(spec.id === 'openai'
      ? { max_completion_tokens: 8000, stream_options: { include_usage: true } }
      : { max_tokens: 8000 }),
  };
  if (tools.length)
    body.tools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  };
  if (spec.id === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/shep95/adam';
    headers['X-Title'] = 'ADAM';
  }
  const response = await fetchImpl(`${spec.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await upstreamError(spec.id, response);
  yield* parseOpenAiStream(response.body);
}

// ── Gemini ───────────────────────────────────────────────────────────────────

/** Gemini function declarations accept a subset of JSON Schema. */
export function geminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (
      ['additionalProperties', '$schema', 'minLength', 'maxLength'].includes(
        key,
      )
    )
      continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, geminiSchema(v)]),
      );
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = geminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  if (
    out.type === 'object' &&
    out.properties &&
    !Object.keys(out.properties).length
  )
    delete out.properties;
  // Untyped values ({}) are not accepted: treat them as strings.
  if (!out.type && !out.anyOf && !out.enum) out.type = 'string';
  return out;
}

export function geminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    if (m.role === 'user') {
      contents.push({
        role: 'user',
        parts: [
          ...(m.images || []).map((img) => ({
            inlineData: { mimeType: img.mime, data: img.data },
          })),
          { text: m.text || '' },
        ],
      });
    } else if (m.role === 'assistant') {
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      for (const call of m.toolCalls || [])
        parts.push({
          functionCall: { name: call.name, args: call.args || {} },
        });
      if (parts.length) contents.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      let response;
      try {
        response = JSON.parse(m.result);
      } catch {
        response = { result: String(m.result ?? '') };
      }
      if (!response || typeof response !== 'object' || Array.isArray(response))
        response = { result: response };
      const part = { functionResponse: { name: m.name, response } };
      const last = contents[contents.length - 1];
      if (last?.role === 'user' && last.parts.every((p) => p.functionResponse))
        last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
    }
  }
  return contents;
}

export async function* parseGeminiStream(body) {
  let n = 0;
  for await (const data of sseData(body)) {
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    for (const part of json.candidates?.[0]?.content?.parts || []) {
      if (typeof part.text === 'string' && part.text && !part.thought)
        yield { type: 'text', delta: part.text };
      if (part.functionCall?.name)
        yield {
          type: 'tool_call',
          id: `gem_${Date.now().toString(36)}_${n++}`,
          name: part.functionCall.name,
          args: part.functionCall.args || {},
        };
    }
    if (json.usageMetadata)
      yield {
        type: 'usage',
        inputTokens: json.usageMetadata.promptTokenCount || 0,
        outputTokens: json.usageMetadata.candidatesTokenCount || 0,
        cachedTokens: json.usageMetadata.cachedContentTokenCount || 0,
      };
  }
}

async function* streamGemini({
  key,
  model,
  system,
  messages,
  tools,
  signal,
  fetchImpl,
}) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: geminiContents(messages),
    generationConfig: { maxOutputTokens: 8000 },
  };
  if (tools.length)
    body.tools = [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: geminiSchema(tool.parameters),
        })),
      },
    ];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await upstreamError('gemini', response);
  yield* parseGeminiStream(response.body);
}

// ── Anthropic ────────────────────────────────────────────────────────────────

export function anthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({
        role: 'user',
        content: [
          ...(m.images || []).map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mime, data: img.data },
          })),
          { type: 'text', text: m.text || ' ' },
        ],
      });
    } else if (m.role === 'assistant') {
      const content = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const call of m.toolCalls || [])
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.args || {},
        });
      if (content.length) out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: String(m.result ?? ''),
      };
      const last = out[out.length - 1];
      // All results for one assistant turn go back in a single user message.
      if (
        last?.role === 'user' &&
        last.content.every((b) => b.type === 'tool_result')
      )
        last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

/** Anthropic's server-side web search (runs on Anthropic's side; results
 * arrive as cited text in the reply). */
export const ANTHROPIC_WEB_SEARCH = Object.freeze({
  type: 'web_search_20260209',
  name: 'web_search',
  max_uses: 5,
});

async function* streamAnthropic({
  key,
  model,
  system,
  messages,
  tools,
  webSearch = false,
  signal,
  clientFactory,
}) {
  const client = clientFactory
    ? clientFactory(key)
    : new Anthropic({ apiKey: key });
  const stream = client.messages.stream(
    {
      model,
      max_tokens: 16000,
      system: [
        { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
      ],
      messages: anthropicMessages(messages),
      ...(tools.length || webSearch
        ? {
            tools: [
              ...tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters,
              })),
              ...(webSearch ? [ANTHROPIC_WEB_SEARCH] : []),
            ],
          }
        : {}),
    },
    { signal },
  );
  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta?.type === 'text_delta'
    )
      yield { type: 'text', delta: event.delta.text };
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal')
    yield { type: 'text', delta: '\n(the model declined this request.)' };
  if (final.stop_reason === 'pause_turn')
    yield {
      type: 'text',
      delta: '\n(web search paused mid-turn; ask me to continue.)',
    };
  for (const block of final.content) {
    if (block.type === 'tool_use')
      yield {
        type: 'tool_call',
        id: block.id,
        name: block.name,
        args: block.input || {},
      };
  }
  yield {
    type: 'usage',
    inputTokens: final.usage?.input_tokens || 0,
    outputTokens: final.usage?.output_tokens || 0,
    cachedTokens: final.usage?.cache_read_input_tokens || 0,
  };
}

async function upstreamError(id, response) {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    detail = '';
  }
  const error = new Error(`${id} HTTP ${response.status}`);
  error.status = response.status;
  error.detail = detail;
  return error;
}

/**
 * Stream one provider.
 * @returns {AsyncGenerator<object>}
 */
export function streamProvider(id, options) {
  const spec = PROVIDERS[id];
  if (!spec) throw new Error(`Unknown provider: ${id}`);
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  if (id === 'anthropic') return streamAnthropic({ ...options, fetchImpl });
  if (id === 'gemini') return streamGemini({ ...options, fetchImpl });
  return streamOpenAiCompatible(spec, { ...options, fetchImpl });
}

/** List models a provider offers (Venice and OpenRouter expose 100+). */
export async function listProviderModels(id, { key, fetchImpl = fetch } = {}) {
  const spec = PROVIDERS[id];
  if (!spec) return [];
  if (id === 'anthropic') {
    const client = new Anthropic({ apiKey: key });
    const out = [];
    for await (const model of client.models.list())
      out.push({ id: model.id, name: model.display_name || model.id });
    return out;
  }
  if (id === 'gemini') {
    const response = await fetchImpl(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      {
        headers: { 'x-goog-api-key': key },
      },
    );
    if (!response.ok) throw await upstreamError(id, response);
    const json = await response.json();
    return (json.models || [])
      .filter((m) =>
        (m.supportedGenerationMethods || []).includes('generateContent'),
      )
      .map((m) => ({
        id: String(m.name).replace(/^models\//, ''),
        name: m.displayName || m.name,
      }));
  }
  const response = await fetchImpl(`${spec.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw await upstreamError(id, response);
  const json = await response.json();
  return (json.data || []).map((m) => ({ id: m.id, name: m.name || m.id }));
}
