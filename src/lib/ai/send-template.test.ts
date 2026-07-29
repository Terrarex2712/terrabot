import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(),
  supabaseAdmin: vi.fn(),
}))
vi.mock('@/lib/whatsapp/aisensy-api', () => ({
  sendTemplateMessage: h.sendTemplateMessage,
  normalizeAiSensyLanguage: (language: string) =>
    ({ english: 'en', hindi: 'hi', en_us: 'en' })[language.toLowerCase()] ?? language,
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `decrypted:${v}` }))
vi.mock('./admin-client', () => ({ supabaseAdmin: h.supabaseAdmin }))

import { sendAiTemplateReply, AiTemplateSendError } from './send-template'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeBuilder(result: { data: unknown; error: unknown }): any {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    single: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
    then: (onFulfilled: (r: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  }
  return builder
}

interface DbOpts {
  contactResult?: { data: unknown; error: unknown }
  configResult?: { data: unknown; error: unknown }
  templateResult?: { data: unknown; error: unknown }
  insertResult?: { error: unknown }
}

function buildDb(opts: DbOpts = {}) {
  const inserted: Record<string, unknown>[] = []
  const updated: Record<string, unknown>[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    from(table: string) {
      if (table === 'contacts') {
        return makeBuilder(opts.contactResult ?? { data: null, error: { message: 'not found' } })
      }
      if (table === 'whatsapp_config') {
        return makeBuilder(opts.configResult ?? { data: null, error: { message: 'not found' } })
      }
      if (table === 'message_templates') {
        return makeBuilder(opts.templateResult ?? { data: null, error: null })
      }
      if (table === 'messages') {
        return {
          insert: (payload: Record<string, unknown>) => {
            inserted.push(payload)
            return Promise.resolve(opts.insertResult ?? { error: null })
          },
        }
      }
      if (table === 'conversations') {
        return {
          update: (payload: Record<string, unknown>) => {
            updated.push(payload)
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return { db, inserted, updated }
}

const CONTACT_OK = { data: { id: 'contact-1', phone: '15551234567' }, error: null }
const CONFIG_OK = { data: { project_id: 'proj-1', api_key: 'enc-key' }, error: null }
// `sendAiTemplateReply` queries by list (no `.maybeSingle()`) whenever the
// caller doesn't specify `templateLanguage` — which is every test below
// that reuses this fixture — so this must be an array, matching what a
// real un-.single()'d Supabase query returns.
const TEMPLATE_OK = {
  data: [
    {
      id: 'tpl-1',
      user_id: 'user-1',
      account_id: 'acct-1',
      name: 'order_status',
      language: 'en_US',
      body_text: 'Hi {{1}}, order {{2}} shipped.',
      status: 'APPROVED',
    },
  ],
  error: null,
}

const ARGS = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  templateName: 'order_status',
  bodyParams: ['Sam', '#123'],
}

beforeEach(() => {
  h.sendTemplateMessage.mockReset()
  h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid-1' })
})

describe('sendAiTemplateReply', () => {
  it('sends the template and persists the message + conversation update', async () => {
    const { db, inserted, updated } = buildDb({
      contactResult: CONTACT_OK,
      configResult: CONFIG_OK,
      templateResult: TEMPLATE_OK,
    })
    h.supabaseAdmin.mockReturnValue(db)

    const res = await sendAiTemplateReply(ARGS)

    expect(res).toEqual({ whatsapp_message_id: 'wamid-1' })
    expect(h.sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        apiKey: 'decrypted:enc-key',
        to: '15551234567',
        templateName: 'order_status',
        language: 'en_US',
        messageParams: { body: ['Sam', '#123'], headerText: undefined },
      }),
    )
    expect(inserted).toEqual([
      expect.objectContaining({
        conversation_id: 'conv-1',
        sender_type: 'bot',
        content_type: 'template',
        content_text: null,
        template_name: 'order_status',
        message_id: 'wamid-1',
        status: 'sent',
        ai_generated: true,
      }),
    ])
    expect(updated).toEqual([
      expect.objectContaining({ last_message_text: '[template:order_status]' }),
    ])
  })

  it('throws before any network call when the contact is not found for this account', async () => {
    const { db } = buildDb({ contactResult: { data: null, error: null } })
    h.supabaseAdmin.mockReturnValue(db)

    await expect(sendAiTemplateReply(ARGS)).rejects.toBeInstanceOf(AiTemplateSendError)
    expect(h.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('throws on an invalid contact phone', async () => {
    const { db } = buildDb({
      contactResult: { data: { id: 'contact-1', phone: '123' }, error: null },
      configResult: CONFIG_OK,
      templateResult: TEMPLATE_OK,
    })
    h.supabaseAdmin.mockReturnValue(db)

    await expect(sendAiTemplateReply(ARGS)).rejects.toBeInstanceOf(AiTemplateSendError)
    expect(h.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('throws when WhatsApp is not configured for the account', async () => {
    const { db } = buildDb({ contactResult: CONTACT_OK, configResult: { data: null, error: null } })
    h.supabaseAdmin.mockReturnValue(db)

    await expect(sendAiTemplateReply(ARGS)).rejects.toBeInstanceOf(AiTemplateSendError)
    expect(h.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('throws when the named template is not an approved row for this account', async () => {
    const { db } = buildDb({
      contactResult: CONTACT_OK,
      configResult: CONFIG_OK,
      templateResult: { data: null, error: null },
    })
    h.supabaseAdmin.mockReturnValue(db)

    await expect(sendAiTemplateReply(ARGS)).rejects.toBeInstanceOf(AiTemplateSendError)
    expect(h.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('falls back to the first approved row when the model omits language', async () => {
    const rows = [
      { id: 't1', user_id: 'u1', name: 'order_status', language: 'hi', body_text: 'x', status: 'APPROVED' },
      { id: 't2', user_id: 'u1', name: 'order_status', language: 'en_US', body_text: 'x', status: 'APPROVED' },
    ]
    const { db } = buildDb({
      contactResult: CONTACT_OK,
      configResult: CONFIG_OK,
      templateResult: { data: rows, error: null },
    })
    h.supabaseAdmin.mockReturnValue(db)

    await sendAiTemplateReply({ ...ARGS, templateLanguage: undefined })

    expect(h.sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'en_US' }),
    )
  })
})
