import { sendTemplateMessage, normalizeAiSensyLanguage } from '@/lib/whatsapp/aisensy-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import { supabaseAdmin } from './admin-client'

// ============================================================
// Sends the template the AI auto-reply bot chose via its tool call.
// Mirrors `engineSendText` in src/lib/flows/meta-send.ts (account-scoped
// contact + config lookup, same `messages`/`conversations` persistence
// convention as src/lib/automations/meta-send.ts's `engineSendTemplate`),
// but loads the full template row so header/body variables build through
// the same `buildSendComponents` path the manual/broadcast send uses
// (src/lib/whatsapp/send-message.ts) — no new payload-building code.
// ============================================================

export class AiTemplateSendError extends Error {}

interface SendAiTemplateReplyArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  templateLanguage?: string
  bodyParams?: string[]
  headerText?: string
}

export async function sendAiTemplateReply(
  args: SendAiTemplateReplyArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new AiTemplateSendError('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new AiTemplateSendError(`contact phone invalid: ${contact.phone}`)
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config) {
    throw new AiTemplateSendError('WhatsApp not configured for this account')
  }

  // Approved + account-scoped, same as the manual/broadcast send lookup.
  // The model may omit language when a template only exists in one; when
  // it does, prefer 'en_US' if present, else take any approved row under
  // this name.
  const resolvedTemplate = args.templateLanguage
    ? await (async () => {
        const { data } = await db
          .from('message_templates')
          .select('*')
          .eq('account_id', args.accountId)
          .eq('name', args.templateName)
          .eq('status', 'APPROVED')
          .eq('language', args.templateLanguage)
          .maybeSingle()
        return data
      })()
    : await (async () => {
        const { data: rows } = await db
          .from('message_templates')
          .select('*')
          .eq('account_id', args.accountId)
          .eq('name', args.templateName)
          .eq('status', 'APPROVED')
        if (!rows || rows.length === 0) return null
        return (
          rows.find(
            (r: { language?: string }) => normalizeAiSensyLanguage(r.language ?? '') === 'en',
          ) ?? rows[0]
        )
      })()

  if (!resolvedTemplate) {
    throw new AiTemplateSendError(
      `template "${args.templateName}" is not an approved template for this account`,
    )
  }
  if (!isMessageTemplate(resolvedTemplate)) {
    throw new AiTemplateSendError(
      `template "${args.templateName}" row is malformed locally`,
    )
  }

  const apiKey = decrypt(config.api_key)

  const { messageId: waMessageId } = await sendTemplateMessage({
    projectId: config.project_id,
    apiKey,
    to: sanitized,
    templateName: resolvedTemplate.name,
    language: resolvedTemplate.language || 'en_US',
    template: resolvedTemplate,
    messageParams: {
      body: args.bodyParams,
      headerText: args.headerText,
    },
  })

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'template',
    content_text: null,
    template_name: resolvedTemplate.name,
    message_id: waMessageId,
    status: 'sent',
    ai_generated: true,
  })
  if (msgErr) {
    throw new AiTemplateSendError(
      `sent to AiSensy but DB insert failed: ${msgErr.message}`,
    )
  }

  await db
    .from('conversations')
    .update({
      last_message_text: `[template:${resolvedTemplate.name}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { whatsapp_message_id: waMessageId }
}
