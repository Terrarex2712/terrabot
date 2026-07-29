import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateReply, parseGeneration } from './generate'
import { AiError, type AiConfig, type AiTool } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

const TEMPLATE_TOOL: AiTool = {
  name: 'send_whatsapp_template',
  description: 'send a template',
  inputSchema: { type: 'object', properties: {} },
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration({ text: 'Hello there', usage: null })).toEqual({
      kind: 'text',
      text: 'Hello there',
      usage: null,
    })
  })

  it('detects the handoff sentinel', () => {
    expect(parseGeneration({ text: '[[HANDOFF]]', usage: null })).toEqual({
      kind: 'handoff',
      usage: null,
    })
    expect(
      parseGeneration({ text: 'Let me get a human [[HANDOFF]]', usage: null }),
    ).toEqual({ kind: 'handoff', usage: null })
  })

  it('passes usage straight through', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    expect(parseGeneration({ text: 'Hi', usage })).toEqual({
      kind: 'text',
      text: 'Hi',
      usage,
    })
  })

  it('maps a tool call to a template result', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    expect(
      parseGeneration({
        text: '',
        usage,
        toolCall: {
          name: 'send_whatsapp_template',
          input: {
            template_name: 'order_status',
            body_params: ['123'],
            language: 'en_US',
            header_text: 'hi',
          },
        },
      }),
    ).toEqual({
      kind: 'template',
      templateName: 'order_status',
      templateLanguage: 'en_US',
      bodyParams: ['123'],
      headerText: 'hi',
      usage,
    })
  })

  it('defaults optional template fields to undefined when absent', () => {
    expect(
      parseGeneration({
        text: '',
        usage: null,
        toolCall: { name: 'send_whatsapp_template', input: { template_name: 'welcome' } },
      }),
    ).toEqual({
      kind: 'template',
      templateName: 'welcome',
      templateLanguage: undefined,
      bodyParams: undefined,
      headerText: undefined,
      usage: null,
    })
  })
})

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({
      kind: 'text',
      text: 'Sure — happy to help!',
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'Incorrect API key' } }),
      ),
    )

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })),
    )
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      kind: 'text',
      text: 'Hi there!',
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect(opts.headers['x-api-key']).toBe('sk-ant-x')
    expect(opts.headers['anthropic-version']).toBeTruthy()
    // No tools passed → no `tools` field sent upstream.
    expect(JSON.parse(opts.body)).not.toHaveProperty('tools')
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    })
    expect(res).toEqual({ kind: 'handoff', usage: null })
  })

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages).toHaveLength(1)
  })

  it('sends the offered tools and returns a template result on a valid call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'send_whatsapp_template',
            input: { template_name: 'order_status', body_params: ['12345'] },
          },
        ],
        usage: { input_tokens: 50, output_tokens: 10 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const validateToolUse = vi.fn().mockReturnValue({ ok: true })

    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Where is my order?' }],
      tools: [TEMPLATE_TOOL],
      validateToolUse,
    })

    expect(res).toEqual({
      kind: 'template',
      templateName: 'order_status',
      templateLanguage: undefined,
      bodyParams: ['12345'],
      headerText: undefined,
      usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tools).toEqual([
      { name: 'send_whatsapp_template', description: 'send a template', input_schema: TEMPLATE_TOOL.inputSchema },
    ])
    expect(validateToolUse).toHaveBeenCalledWith('send_whatsapp_template', {
      template_name: 'order_status',
      body_params: ['12345'],
    })
  })

  it('retries once with a tool_result error, then accepts a corrected call', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'send_whatsapp_template',
              input: { template_name: 'bogus_template' },
            },
          ],
          usage: { input_tokens: 40, output_tokens: 5 },
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          content: [
            {
              type: 'tool_use',
              id: 'tu_2',
              name: 'send_whatsapp_template',
              input: { template_name: 'order_status', body_params: ['999'] },
            },
          ],
          usage: { input_tokens: 60, output_tokens: 8 },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const validateToolUse = vi
      .fn()
      .mockReturnValueOnce({ ok: false, error: '"bogus_template" is not a real template.' })
      .mockReturnValueOnce({ ok: true })

    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [TEMPLATE_TOOL],
      validateToolUse,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res).toEqual({
      kind: 'template',
      templateName: 'order_status',
      templateLanguage: undefined,
      bodyParams: ['999'],
      headerText: undefined,
      // Usage summed across both calls.
      usage: { promptTokens: 100, completionTokens: 13, totalTokens: 113 },
    })

    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const [echoedAssistant, toolResultTurn] = retryBody.messages.slice(-2)
    expect(echoedAssistant.role).toBe('assistant')
    expect(echoedAssistant.content[0]).toMatchObject({ type: 'tool_use', id: 'tu_1' })
    expect(toolResultTurn.role).toBe('user')
    expect(toolResultTurn.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      is_error: true,
      content: '"bogus_template" is not a real template.',
    })
  })

  it('degrades to empty text when the retry is also invalid', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'send_whatsapp_template', input: { template_name: 'bad' } },
          ],
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          content: [
            { type: 'tool_use', id: 'tu_2', name: 'send_whatsapp_template', input: { template_name: 'still_bad' } },
          ],
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const validateToolUse = vi.fn().mockReturnValue({ ok: false, error: 'nope' })

    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [TEMPLATE_TOOL],
      validateToolUse,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res).toEqual({
      kind: 'text',
      text: '',
      usage: { promptTokens: 20, completionTokens: 2, totalTokens: 22 },
    })
  })

  it('uses only the first tool_use block when the model returns more than one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'send_whatsapp_template', input: { template_name: 'a' } },
            { type: 'tool_use', id: 'tu_2', name: 'send_whatsapp_template', input: { template_name: 'b' } },
          ],
        }),
      ),
    )
    const validateToolUse = vi.fn().mockReturnValue({ ok: true })

    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [TEMPLATE_TOOL],
      validateToolUse,
    })

    expect(res).toMatchObject({ kind: 'template', templateName: 'a' })
    expect(validateToolUse).toHaveBeenCalledTimes(1)
    expect(validateToolUse).toHaveBeenCalledWith('send_whatsapp_template', { template_name: 'a' })
  })
})
