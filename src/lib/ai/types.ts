// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** A tool call the model made instead of (or alongside) plain text. */
export interface ToolCall {
  name: string
  input: Record<string, unknown>
}

/** Raw text + usage a provider adapter returns before handoff parsing.
 *  `toolCall` is set only by adapters that support tool-calling (currently
 *  Anthropic only) and only when the model actually invoked one. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
  toolCall?: ToolCall
}

/**
 * A tool definition a provider adapter can offer the model, in our
 * provider-neutral shape. Adapters translate `inputSchema` into whatever
 * their API expects (Anthropic: `input_schema`).
 */
export interface AiTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Validates a tool call's input once parsed. Returns `ok: true`, or
 *  `ok: false` with a human-readable reason a provider adapter can feed
 *  back to the model as a tool-result error. */
export type ToolCallValidator = (
  toolName: string,
  input: Record<string, unknown>,
) => { ok: true } | { ok: false; error: string }

/**
 * Outcome of a generation call — a discriminated union so callers can't
 * accidentally read `text` off a template result or vice versa.
 */
export type GenerateResult =
  | { kind: 'text'; text: string; usage: AiUsage | null }
  | { kind: 'handoff'; usage: AiUsage | null }
  | {
      kind: 'template'
      templateName: string
      templateLanguage?: string
      bodyParams?: string[]
      headerText?: string
      usage: AiUsage | null
    }

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
