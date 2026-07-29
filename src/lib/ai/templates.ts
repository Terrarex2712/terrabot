import type { SupabaseClient } from '@supabase/supabase-js'
import { extractVariableIndices } from '@/lib/whatsapp/template-validators'
import type { AiTool, ToolCallValidator } from './types'

// ============================================================
// Lets the AI auto-reply bot select and send one of the account's
// approved WhatsApp templates instead of free text.
//
// Deliberately scoped: only `Utility`/`Authentication` templates are
// ever offered (never `Marketing` — the bot must never autonomously
// fire a promotional message), and templates with a variable URL
// button are excluded (no `buttonParams` support yet). See the plan
// this shipped under for the reasoning.
// ============================================================

export const SEND_TEMPLATE_TOOL_NAME = 'send_whatsapp_template'

export interface AiTemplateSpec {
  name: string
  language: string
  category: 'Utility' | 'Authentication'
  bodyText: string
  requiredBodyVars: number
  headerRequiresText: boolean
}

interface TemplateRow {
  name: string
  language: string | null
  category: string
  body_text: string
  header_type: string | null
  header_content: string | null
  buttons: unknown
}

function hasVariableUrlButton(buttons: unknown): boolean {
  if (!Array.isArray(buttons)) return false
  return buttons.some((b) => {
    if (!b || typeof b !== 'object') return false
    const button = b as { type?: unknown; url?: unknown }
    if (button.type !== 'URL') return false
    return extractVariableIndices(String(button.url ?? '')).length > 0
  })
}

/**
 * Load the account's approved, tool-eligible templates. Returns `[]` on
 * any DB error or when there's nothing eligible — callers treat that as
 * "don't offer the tool", not an error.
 */
export async function loadAiTemplateSpecs(
  db: SupabaseClient,
  accountId: string,
): Promise<AiTemplateSpec[]> {
  const { data, error } = await db
    .from('message_templates')
    .select('name, language, category, body_text, header_type, header_content, buttons')
    .eq('account_id', accountId)
    .eq('status', 'APPROVED')
    .in('category', ['Utility', 'Authentication'])

  if (error || !data) return []

  const specs: AiTemplateSpec[] = []
  for (const row of data as TemplateRow[]) {
    if (hasVariableUrlButton(row.buttons)) continue
    specs.push({
      name: row.name,
      language: row.language || 'en_US',
      category: row.category as 'Utility' | 'Authentication',
      bodyText: row.body_text,
      requiredBodyVars: extractVariableIndices(row.body_text).length,
      headerRequiresText:
        row.header_type === 'text' &&
        extractVariableIndices(row.header_content ?? '').length > 0,
    })
  }
  return specs
}

/**
 * Build the single generic tool the model can call. The full catalog
 * lives in the tool's own `description` (not the system prompt) so it
 * doesn't bloat every call and can't drift from the input schema.
 */
export function buildTemplateTool(templates: AiTemplateSpec[]): AiTool {
  const catalog = templates
    .map((t) => {
      const requirements: string[] = []
      if (t.headerRequiresText) requirements.push('header_text required')
      if (t.requiredBodyVars > 0) {
        requirements.push(`body_params: ${t.requiredBodyVars} value(s), in order`)
      }
      const reqLine = requirements.length ? `\n  Requires: ${requirements.join('; ')}` : ''
      return `- "${t.name}" (${t.language}, ${t.category}): "${t.bodyText}"${reqLine}`
    })
    .join('\n')

  return {
    name: SEND_TEMPLATE_TOOL_NAME,
    description:
      "Send one of the business's pre-approved WhatsApp templates instead of a free-text reply. " +
      'Use this ONLY when a template below is a clear, exact fit for what the customer needs right now ' +
      "(e.g. an order-status lookup, a confirmation, an OTP-style notice). Never invent a value it needs, " +
      'and never call this when a template is only "close enough" — reply normally instead when nothing ' +
      `truly fits.\n\nAvailable templates:\n${catalog}`,
    inputSchema: {
      type: 'object',
      properties: {
        template_name: {
          type: 'string',
          description: 'Exact name of the template to send, from the list above.',
        },
        language: {
          type: 'string',
          description:
            'Template language code, only if the template is listed in more than one language. Optional.',
        },
        body_params: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Values for the template body's {{1}}, {{2}}, … placeholders, in order. Omit if the template has none.",
        },
        header_text: {
          type: 'string',
          description:
            "Value for the template header's {{1}} placeholder — only if the template requires one.",
        },
      },
      required: ['template_name'],
    },
  }
}

/**
 * Local, synchronous validation of a tool call against the same
 * in-memory template list the tool was built from — no DB round trip.
 */
export function buildTemplateToolValidator(templates: AiTemplateSpec[]): ToolCallValidator {
  const byName = new Map(templates.map((t) => [t.name, t]))

  return (toolName, input) => {
    if (toolName !== SEND_TEMPLATE_TOOL_NAME) {
      return { ok: false, error: `Unknown tool "${toolName}".` }
    }

    const templateName = input.template_name
    if (typeof templateName !== 'string' || !templateName.trim()) {
      return { ok: false, error: 'template_name is required.' }
    }

    const spec = byName.get(templateName)
    if (!spec) {
      return { ok: false, error: `"${templateName}" is not one of the available templates.` }
    }

    const bodyParams = input.body_params
    const bodyParamsArr = Array.isArray(bodyParams) ? bodyParams : []
    if (bodyParams !== undefined && !Array.isArray(bodyParams)) {
      return { ok: false, error: 'body_params must be an array of strings.' }
    }
    if (!bodyParamsArr.every((v) => typeof v === 'string')) {
      return { ok: false, error: 'body_params must all be strings.' }
    }
    if (bodyParamsArr.length < spec.requiredBodyVars) {
      return {
        ok: false,
        error: `Template "${templateName}" needs ${spec.requiredBodyVars} body_params value(s), got ${bodyParamsArr.length}.`,
      }
    }

    if (spec.headerRequiresText) {
      const headerText = input.header_text
      if (typeof headerText !== 'string' || !headerText.trim()) {
        return { ok: false, error: `Template "${templateName}" requires header_text.` }
      }
    }

    return { ok: true }
  }
}
