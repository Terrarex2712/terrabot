import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  loadZohoConfig: vi.fn(),
  createLead: vi.fn(),
  addLeadTag: vi.fn(),
  state: {
    contact: null as Record<string, unknown> | null,
    rules: [] as Record<string, unknown>[],
    messages: [] as { content_text: string }[],
    updatePayload: null as Record<string, unknown> | null,
  },
}))

vi.mock('./config', () => ({ loadZohoConfig: h.loadZohoConfig }))
vi.mock('./client', () => ({ createLead: h.createLead, addLeadTag: h.addLeadTag }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'contacts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: h.state.contact, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            h.state.updatePayload = payload
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      if (table === 'zoho_lead_rules') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: h.state.rules, error: null }),
            }),
          }),
        }
      }
      // messages
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: h.state.messages, error: null }),
              }),
            }),
          }),
        }),
      }
    },
  }),
}))

import { dispatchInboundToZohoLeadConvert } from './lead-convert'

const ARGS = { accountId: 'acct-1', contactId: 'contact-1', conversationId: 'conv-1' }

function messageTextRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    account_id: 'acct-1',
    name: 'Jaunpur leads',
    criteria_type: 'message_text',
    match_type: 'contains',
    case_sensitive: false,
    keywords: ['jaunpur'],
    lead_source: 'WhatsApp Bot',
    is_active: true,
    ...overrides,
  }
}

function zohoConfig() {
  return { dataCenter: 'in', clientId: 'id', clientSecret: 'secret', refreshToken: 'rt', isActive: true }
}

beforeEach(() => {
  h.state.contact = {
    account_id: 'acct-1',
    name: 'Ramesh',
    phone: '+919999999999',
    city: null,
    zoho_lead_id: null,
  }
  h.state.rules = [messageTextRule()]
  h.state.messages = [{ content_text: 'hi' }, { content_text: 'I am from Jaunpur' }, { content_text: 'ok thanks' }]
  h.state.updatePayload = null
  h.loadZohoConfig.mockResolvedValue(zohoConfig())
  h.createLead.mockResolvedValue({ ok: true, leadId: 'zoho-lead-1' })
  h.addLeadTag.mockResolvedValue(undefined)
})

describe('dispatchInboundToZohoLeadConvert', () => {
  it('converts on a keyword match found in an earlier (not latest) message, and tags the lead', async () => {
    await dispatchInboundToZohoLeadConvert(ARGS)

    expect(h.createLead).toHaveBeenCalledWith(
      zohoConfig(),
      expect.objectContaining({ lastName: 'Ramesh', leadSource: 'WhatsApp Bot' }),
    )
    expect(h.state.updatePayload).toMatchObject({ zoho_lead_id: 'zoho-lead-1' })
    expect(h.state.updatePayload?.zoho_lead_synced_at).toBeTruthy()
    expect(h.addLeadTag).toHaveBeenCalledWith(zohoConfig(), 'zoho-lead-1', 'Whatsapp')
  })

  it('still records the conversion when tagging fails', async () => {
    h.addLeadTag.mockRejectedValue(new Error('tag not found'))
    await expect(dispatchInboundToZohoLeadConvert(ARGS)).resolves.toBeUndefined()
    expect(h.state.updatePayload).toMatchObject({ zoho_lead_id: 'zoho-lead-1' })
  })

  it('skips when the contact is already converted', async () => {
    h.state.contact = { ...h.state.contact, zoho_lead_id: 'already-converted' }
    await dispatchInboundToZohoLeadConvert(ARGS)
    expect(h.createLead).not.toHaveBeenCalled()
  })

  it('skips when Zoho is not configured or sync is off', async () => {
    h.loadZohoConfig.mockResolvedValue(null)
    await dispatchInboundToZohoLeadConvert(ARGS)
    expect(h.createLead).not.toHaveBeenCalled()
  })

  it('skips when there are no active rules', async () => {
    h.state.rules = []
    await dispatchInboundToZohoLeadConvert(ARGS)
    expect(h.createLead).not.toHaveBeenCalled()
  })

  it('does not convert when no rule matches', async () => {
    h.state.messages = [{ content_text: 'hello there' }]
    await dispatchInboundToZohoLeadConvert(ARGS)
    expect(h.createLead).not.toHaveBeenCalled()
  })

  it('OR-semantics: converts when only the second of two rules matches', async () => {
    h.state.rules = [
      messageTextRule({ id: 'rule-1', keywords: ['nomatch'] }),
      messageTextRule({ id: 'rule-2', keywords: ['jaunpur'], lead_source: 'Second Rule' }),
    ]
    await dispatchInboundToZohoLeadConvert(ARGS)
    expect(h.createLead).toHaveBeenCalledWith(
      zohoConfig(),
      expect.objectContaining({ leadSource: 'Second Rule' }),
    )
  })

  it('a well-formed Zoho rejection is logged and does not write zoho_lead_id', async () => {
    h.createLead.mockResolvedValue({ ok: false, code: 'DUPLICATE_DATA', message: 'duplicate data' })
    await dispatchInboundToZohoLeadConvert(ARGS)
    expect(h.state.updatePayload).toBeNull()
  })

  it('swallows a thrown error instead of throwing', async () => {
    h.createLead.mockRejectedValue(new Error('network down'))
    await expect(dispatchInboundToZohoLeadConvert(ARGS)).resolves.toBeUndefined()
    expect(h.state.updatePayload).toBeNull()
  })

  it('never matches a contact_city rule today (no data source populates contacts.city)', async () => {
    h.state.rules = [messageTextRule({ criteria_type: 'contact_city', keywords: ['jaunpur'] })]
    h.state.contact = { ...h.state.contact, city: null }
    await dispatchInboundToZohoLeadConvert(ARGS)
    expect(h.createLead).not.toHaveBeenCalled()
  })
})
