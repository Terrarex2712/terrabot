import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  sumUsage,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicContentBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** A message in Anthropic's own wire shape — `content` is either a plain
 *  string (our normal turns) or a content-block array (only used for the
 *  tool-call retry round-trip below). */
interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[] | Record<string, unknown>[]
}

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  return merged
}

function extractText(content: AnthropicContentBlock[] | undefined): string {
  return (content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
}

/** Takes the first `tool_use` block if the model returned one (or more —
 *  we only ever act on one, to guarantee at most one template send). */
function extractToolUse(
  content: AnthropicContentBlock[] | undefined,
): AnthropicContentBlock | undefined {
  const blocks = (content ?? []).filter((b) => b.type === 'tool_use')
  if (blocks.length > 1) {
    console.warn(
      '[ai anthropic] model returned multiple tool_use blocks in one turn — using the first, ignoring the rest',
    )
  }
  return blocks[0]
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text/tool-call + token usage (handoff
 * parsing happens in `generateReply`).
 *
 * Tool-calling (only when `args.tools` is set): if the model calls the
 * offered tool with invalid input (per `args.validateToolUse`), one
 * retry is attempted — the assistant's tool call is echoed back with a
 * `tool_result` error, matching Anthropic's documented correction
 * pattern. A second invalid attempt degrades to an empty text result
 * (not an error) so the caller's existing "nothing usable → handoff"
 * path handles it without a separate code path.
 */
export async function generateAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, validateToolUse } = args

  const anthropicTools = tools?.length
    ? tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
    : undefined

  const baseMessages: AnthropicMessage[] = normalizeForAnthropic(messages).map((m) => ({
    role: m.role,
    content: m.content,
  }))

  const call = async (msgs: AnthropicMessage[]): Promise<AnthropicResponse> => {
    let res: Response
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          system: systemPrompt,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: msgs,
          ...(anthropicTools ? { tools: anthropicTools } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (!res.ok) {
      throw await providerHttpError('Anthropic', res)
    }
    return ((await res.json().catch(() => null)) ?? {}) as AnthropicResponse
  }

  const first = await call(baseMessages)
  const firstText = extractText(first.content)
  const firstToolUse = extractToolUse(first.content)
  const firstUsage = normalizeUsage({
    prompt: first.usage?.input_tokens,
    completion: first.usage?.output_tokens,
  })

  if (!firstText && !firstToolUse) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }

  if (!firstToolUse) {
    return { text: firstText, usage: firstUsage }
  }

  const toolName = firstToolUse.name ?? ''
  const toolInput = firstToolUse.input ?? {}
  const validation = validateToolUse?.(toolName, toolInput) ?? { ok: true }
  if (validation.ok) {
    return { text: firstText, usage: firstUsage, toolCall: { name: toolName, input: toolInput } }
  }

  // Exactly one retry: echo the assistant's tool call back with a
  // tool_result error and see what the model does with the correction.
  const retryMessages: AnthropicMessage[] = [
    ...baseMessages,
    { role: 'assistant', content: first.content ?? [] },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: firstToolUse.id,
          content: validation.error,
          is_error: true,
        },
      ],
    },
  ]

  const second = await call(retryMessages)
  const secondText = extractText(second.content)
  const secondToolUse = extractToolUse(second.content)
  const usage = sumUsage(
    firstUsage,
    normalizeUsage({
      prompt: second.usage?.input_tokens,
      completion: second.usage?.output_tokens,
    }),
  )

  if (secondToolUse) {
    const retryToolName = secondToolUse.name ?? ''
    const retryToolInput = secondToolUse.input ?? {}
    const retryValidation = validateToolUse?.(retryToolName, retryToolInput) ?? { ok: true }
    if (retryValidation.ok) {
      return { text: secondText, usage, toolCall: { name: retryToolName, input: retryToolInput } }
    }
    // Invalid twice — degrade quietly. The caller's existing
    // "nothing usable" branch treats empty text as a handoff signal.
    return { text: '', usage }
  }

  return { text: secondText, usage }
}
