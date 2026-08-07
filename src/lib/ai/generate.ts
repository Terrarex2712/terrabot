import {
  AiError,
  type AiConfig,
  type AiTool,
  type ChatMessage,
  type GenerateResult,
  type LeadInfo,
  type ProviderResult,
  type ToolCallValidator,
} from './types'
import { HANDOFF_SENTINEL, LEAD_INFO_SENTINEL_PREFIX, aiRequestTimeoutMs } from './defaults'

// Matches `[[LEAD:{...}]]` — captures the JSON object between the fixed
// prefix and the closing `]]`. Non-greedy so it stops at the first `]]`
// rather than swallowing anything after it. Built from the shared
// constant (rather than a hardcoded literal) so the prompt text in
// `defaults.ts` and this parser can never drift apart.
const LEAD_INFO_PATTERN = new RegExp(
  `${LEAD_INFO_SENTINEL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\{.*?\\})\\]\\]`,
)
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
  /** Tools the model may call instead of replying in plain text (e.g.
   *  the template-send tool). Only acted on by providers that support
   *  tool-calling — currently Anthropic only. */
  tools?: AiTool[]
  /** Required whenever `tools` is set — validates a tool call locally. */
  validateToolUse?: ToolCallValidator
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the result into a
 * discriminated `text` / `handoff` / `template` outcome. Throws
 * `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages, tools, validateToolUse } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
    tools,
    validateToolUse,
  }

  let result: ProviderResult
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result)
}

/**
 * Turn a provider's raw result into a discriminated outcome: a
 * validated tool call becomes `{kind: 'template', ...}`; otherwise the
 * `[[HANDOFF]]` sentinel (which can appear alone or trailing a partial
 * reply) decides `handoff` vs `text`, with the marker stripped either
 * way. A `[[LEAD:{...}]]` marker (see `defaults.ts`) is parsed out of a
 * `text` result into `leadInfo` and likewise stripped, so the customer
 * never sees either sentinel. `usage` is passed straight through (null
 * when the provider didn't report it).
 */
export function parseGeneration(result: ProviderResult): GenerateResult {
  if (result.toolCall) {
    const input = result.toolCall.input
    const bodyParams = Array.isArray(input.body_params)
      ? input.body_params.map(String)
      : undefined
    return {
      kind: 'template',
      templateName: String(input.template_name ?? ''),
      templateLanguage: typeof input.language === 'string' ? input.language : undefined,
      bodyParams,
      headerText: typeof input.header_text === 'string' ? input.header_text : undefined,
      usage: result.usage,
    }
  }

  const handoff = result.text.includes(HANDOFF_SENTINEL)
  let text = result.text.split(HANDOFF_SENTINEL).join('').trim()
  if (handoff) return { kind: 'handoff', usage: result.usage }

  const leadInfo = extractLeadInfo(text)
  if (leadInfo.match) text = text.replace(leadInfo.match, '').trim()

  return { kind: 'text', text, usage: result.usage, leadInfo: leadInfo.info }
}

/**
 * Pull a `[[LEAD:{...}]]` marker out of the model's reply, if present.
 * Malformed JSON (the model mis-formatting the marker) is swallowed —
 * this is best-effort capture, not something that should ever break a
 * reply — and only non-empty string `name`/`city` values are kept.
 */
function extractLeadInfo(text: string): { info?: LeadInfo; match?: string } {
  const found = text.match(LEAD_INFO_PATTERN)
  if (!found) return {}

  try {
    const parsed = JSON.parse(found[1]) as Record<string, unknown>
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
    const city = typeof parsed.city === 'string' ? parsed.city.trim() : ''
    const info: LeadInfo = {}
    if (name) info.name = name
    if (city) info.city = city
    return { info: name || city ? info : undefined, match: found[0] }
  } catch {
    return { match: found[0] }
  }
}
