import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  loadAiTemplateSpecs: vi.fn(),
  buildTemplateTool: vi.fn(),
  buildTemplateToolValidator: vi.fn(),
  sendAiTemplateReply: vi.fn(),
  syncCapturedInfoToExistingLead: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    contactUpdatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./templates', () => ({
  loadAiTemplateSpecs: h.loadAiTemplateSpecs,
  buildTemplateTool: h.buildTemplateTool,
  buildTemplateToolValidator: h.buildTemplateToolValidator,
}))
vi.mock('./send-template', () => ({ sendAiTemplateReply: h.sendAiTemplateReply }))
vi.mock('@/lib/zoho/lead-convert', () => ({
  syncCapturedInfoToExistingLead: h.syncCapturedInfoToExistingLead,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'contacts') {
        return {
          update: (payload: Record<string, unknown>) => {
            h.state.contactUpdatePayload = payload
            return { eq: () => Promise.resolve({ error: null }) }
          },
        }
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.contactUpdatePayload = null
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ kind: 'text', text: 'Hello!', usage: null })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.loadAiTemplateSpecs.mockResolvedValue([])
  h.buildTemplateTool.mockReturnValue({ name: 'send_whatsapp_template', description: 'd', inputSchema: {} })
  h.buildTemplateToolValidator.mockReturnValue(() => ({ ok: true }))
  h.sendAiTemplateReply.mockResolvedValue({ whatsapp_message_id: 'm2' })
  h.syncCapturedInfoToExistingLead.mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('skips the send on handoff without disabling auto-reply', async () => {
    h.generateReply.mockResolvedValue({ kind: 'handoff', usage: null })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    // Auto-reply must never pause itself — only the manual "Take over"
    // route does that.
    expect(h.state.updatePayload).toBeNull()
  })

  it('treats an empty text result the same as a handoff, still without disabling', async () => {
    h.generateReply.mockResolvedValue({ kind: 'text', text: '', usage: null })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
  })
})

describe('dispatchInboundToAiReply — captured lead info', () => {
  it('persists the captured name and city onto the contact', async () => {
    h.generateReply.mockResolvedValue({
      kind: 'text',
      text: 'Nice to meet you!',
      usage: null,
      leadInfo: { name: 'Ramesh', city: 'Jaunpur' },
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.contactUpdatePayload).toEqual({ name: 'Ramesh', city: 'Jaunpur' })
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Nice to meet you!' }),
    )
    // Self-heal: in case a lead was already created earlier this same
    // turn (or an earlier message) with a stale name/city.
    expect(h.syncCapturedInfoToExistingLead).toHaveBeenCalledWith({
      accountId: 'acct-1',
      contactId: 'contact-1',
      name: 'Ramesh',
      city: 'Jaunpur',
    })
  })

  it('only writes whichever field was actually captured', async () => {
    h.generateReply.mockResolvedValue({
      kind: 'text',
      text: 'Got it.',
      usage: null,
      leadInfo: { name: 'Ramesh' },
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.contactUpdatePayload).toEqual({ name: 'Ramesh' })
  })

  it('does not touch the contact when no lead info was captured', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.contactUpdatePayload).toBeNull()
    expect(h.syncCapturedInfoToExistingLead).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — template sends', () => {
  it('sends via sendAiTemplateReply, not engineSendText, when the model picks a template', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ provider: 'anthropic' }))
    h.loadAiTemplateSpecs.mockResolvedValue([{ name: 'order_status' }])
    h.generateReply.mockResolvedValue({
      kind: 'template',
      templateName: 'order_status',
      bodyParams: ['12345'],
      usage: null,
    })

    await dispatchInboundToAiReply(ARGS)

    expect(h.sendAiTemplateReply).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        contactId: 'contact-1',
        templateName: 'order_status',
        bodyParams: ['12345'],
      }),
    )
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('never offers tools for a non-Anthropic provider', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ provider: 'openai' }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadAiTemplateSpecs).not.toHaveBeenCalled()
    expect(h.generateReply).toHaveBeenCalledWith(
      expect.objectContaining({ tools: undefined, validateToolUse: undefined }),
    )
  })

  it('never offers tools when the Anthropic account has no eligible templates', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ provider: 'anthropic' }))
    h.loadAiTemplateSpecs.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledWith(
      expect.objectContaining({ tools: undefined, validateToolUse: undefined }),
    )
  })

  it('swallows a send failure instead of throwing', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ provider: 'anthropic' }))
    h.loadAiTemplateSpecs.mockResolvedValue([{ name: 'order_status' }])
    h.generateReply.mockResolvedValue({
      kind: 'template',
      templateName: 'order_status',
      usage: null,
    })
    h.sendAiTemplateReply.mockRejectedValue(new Error('template no longer approved'))

    await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined()
  })
})
