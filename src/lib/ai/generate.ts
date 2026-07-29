import {
  AiError,
  type AiConfig,
  type AiTool,
  type ChatMessage,
  type GenerateResult,
  type ProviderResult,
  type ToolCallValidator,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
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
 * way. `usage` is passed straight through (null when the provider
 * didn't report it).
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
  const text = result.text.split(HANDOFF_SENTINEL).join('').trim()
  if (handoff) return { kind: 'handoff', usage: result.usage }
  return { kind: 'text', text, usage: result.usage }
}
