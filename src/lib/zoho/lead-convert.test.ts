import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  loadZohoConfig: vi.fn(),
  createLead: vi.fn(),
  addLeadTag: vi.fn(),
  updateLead: vi.fn(),
  state: {
    contact: null as Record<string, unknown> | null,
    rules: [] as Record<string, unknown>[],
    messages: [] as { content_text: string }[],
    updatePayload: null as Record<string, unknown> | null,
    contactUpdates: [] as Record<string, unknown>[],
    // Controls whether the atomic claim UPDATE ... WHERE zoho_lead_id
    // IS NULL "affects a row" — false simulates losing the race to a
    // concurrent dispatch.
    claimSucceeds: true,
  },
}))

vi.mock('./config', () => ({ loadZohoConfig: h.loadZohoConfig }))
vi.mock('./client', () => ({
  createLead: h.createLead,
  addLeadTag: h.addLeadTag,
  updateLead: h.updateLead,
}))
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
            h.state.contactUpdates.push(payload)
            // Supports both call shapes used by lead-convert.ts:
            //   .update(...).eq(...).is(...).select(...)   — the atomic claim
            //   .update(...).eq(...)                        — release/finalize (awaited directly)
            const chain: Record<string, unknown> = {
              eq: () => chain,
              is: () => chain,
              select: () =>
                Promise.resolve({
                  data: h.state.claimSucceeds ? [{ id: 'contact-1' }] : [],
                  error: null,
                }),
              then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
            }
            return chain
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

import { dispatchInboundToZohoLeadConvert, syncCapturedInfoToExistingLead } from './lead-convert'

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
  h.state.contactUpdates = []
  h.state.claimSucceeds = true
  h.loadZohoConfig.mockResolvedValue(zohoConfig())
  h.createLead.mockResolvedValue({ ok: true, leadId: 'zoho-lead-1' })
  h.addLeadTag.mockResolvedValue(undefined)
  h.updateLead.mockResolvedValue({ ok: true, leadId: 'zoho-lead-1' })
})

describe('dispatchInboundToZohoLeadConvert', () => {
  it('converts on a keyword match found in an earlier (not latest) message, and tags the lead', async () => {
    await dispatchInboundToZohoLeadConvert(ARGS)

    expect(h.createLead).toHaveBeenCalledWith(
      zohoConfig(),
      expect.objectContaining({ lastName: 'Ramesh', leadSource: 'WhatsApp Bot' }),
    )
    // First claims atomically (a non-null placeholder), then finalizes
    // with the real id once Zoho confirms the create.
    expect(h.state.contactUpdates[0]).toMatchObject({ zoho_lead_id: expect.any(String) })
    expect(h.state.updatePayload).toMatchObject({ zoho_lead_id: 'zoho-lead-1' })
    expect(h.state.updatePayload?.zoho_lead_synced_at).toBeTruthy()
    expect(h.addLeadTag).toHaveBeenCalledWith(zohoConfig(), 'zoho-lead-1', 'Whatsapp')
  })

  it('does not create a second lead when the atomic claim loses the race', async () => {
    h.state.claimSucceeds = false
    await dispatchInboundToZohoLeadConvert(ARGS)
    expect(h.createLead).not.toHaveBeenCalled()
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

  it('a well-formed Zoho rejection is logged, releases the claim, and does not write a real zoho_lead_id', async () => {
    h.createLead.mockResolvedValue({ ok: false, code: 'DUPLICATE_DATA', message: 'duplicate data' })
    await dispatchInboundToZohoLeadConvert(ARGS)
    // Claimed, then released back to null so a later matching inbound retries.
    expect(h.state.updatePayload).toEqual({ zoho_lead_id: null })
  })

  it('swallows a thrown error instead of throwing, and releases the claim', async () => {
    h.createLead.mockRejectedValue(new Error('network down'))
    await expect(dispatchInboundToZohoLeadConvert(ARGS)).resolves.toBeUndefined()
    expect(h.state.updatePayload).toEqual({ zoho_lead_id: null })
  })

  it('never matches a contact_city rule today (no data source populates contacts.city)', async () => {
    h.state.rules = [messageTextRule({ criteria_type: 'contact_city', keywords: ['jaunpur'] })]
    h.state.contact = { ...h.state.contact, city: null }
    await dispatchInboundToZohoLeadConvert(ARGS)
    expect(h.createLead).not.toHaveBeenCalled()
  })
})

describe('syncCapturedInfoToExistingLead', () => {
  const SYNC_ARGS = { accountId: 'acct-1', contactId: 'contact-1', name: 'Sailesh Kumar Yadav', city: 'Jaunpur' }

  it('pushes the captured name/city onto the already-created lead', async () => {
    h.state.contact = { zoho_lead_id: 'zoho-lead-1' }
    await syncCapturedInfoToExistingLead(SYNC_ARGS)
    expect(h.updateLead).toHaveBeenCalledWith(zohoConfig(), 'zoho-lead-1', {
      lastName: 'Sailesh Kumar Yadav',
      city: 'Jaunpur',
    })
  })

  it('does nothing when the contact has not converted yet', async () => {
    h.state.contact = { zoho_lead_id: null }
    await syncCapturedInfoToExistingLead(SYNC_ARGS)
    expect(h.updateLead).not.toHaveBeenCalled()
  })

  it('does nothing while the contact is mid-claim (create is already sending the right values)', async () => {
    h.state.contact = { zoho_lead_id: '__claiming__' }
    await syncCapturedInfoToExistingLead(SYNC_ARGS)
    expect(h.updateLead).not.toHaveBeenCalled()
  })

  it('does nothing when neither name nor city was captured', async () => {
    h.state.contact = { zoho_lead_id: 'zoho-lead-1' }
    await syncCapturedInfoToExistingLead({ accountId: 'acct-1', contactId: 'contact-1' })
    expect(h.updateLead).not.toHaveBeenCalled()
  })

  it('never throws, even when updateLead rejects', async () => {
    h.state.contact = { zoho_lead_id: 'zoho-lead-1' }
    h.updateLead.mockRejectedValue(new Error('network down'))
    await expect(syncCapturedInfoToExistingLead(SYNC_ARGS)).resolves.toBeUndefined()
  })
})
