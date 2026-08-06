import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { loadAiTemplateSpecs, buildTemplateTool, buildTemplateToolValidator } from './templates'
import { sendAiTemplateReply } from './send-template'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    // These three reads don't depend on one another — fetch them
    // concurrently (one round trip's worth of latency instead of three)
    // and apply the same early-out checks afterward.
    const [{ data: config }, { data: autoResponders }, { data: conv, error: convErr }] =
      await Promise.all([
        loadAiConfig(db, accountId).then((c) => ({ data: c })),
        db
          .from('automations')
          .select('id')
          .eq('account_id', accountId)
          .eq('is_active', true)
          .in('trigger_type', ['new_message_received', 'keyword_match'])
          .limit(1),
        db
          .from('conversations')
          .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
          .eq('id', conversationId)
          .maybeSingle(),
      ])
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    if (autoResponders && autoResponders.length > 0) return

    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    // Only Anthropic has tool-calling wired up (see providers/openai.ts's
    // documented gap) — offering the template tool for other providers
    // would be dead weight the model can never actually use.
    const templates =
      config.provider === 'anthropic' ? await loadAiTemplateSpecs(db, accountId) : []

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      templatesAvailable: templates.length > 0,
    })

    const result = await generateReply({
      config,
      systemPrompt,
      messages,
      tools: templates.length ? [buildTemplateTool(templates)] : undefined,
      validateToolUse: templates.length ? buildTemplateToolValidator(templates) : undefined,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of outcome — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage: result.usage,
    })

    if (result.kind === 'handoff' || (result.kind === 'text' && !result.text)) {
      // The model produced nothing usable this turn. Auto-reply must
      // never pause itself — only a human explicitly taking over (the
      // inbox "Take over" banner, `/api/ai/autoreply/[id]`) does that —
      // so just skip this send and stay eligible for the next inbound.
      console.warn(
        `[ai auto-reply] conversation ${conversationId} produced no usable reply — skipping send.`,
      )
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    if (result.kind === 'template') {
      await sendAiTemplateReply({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        templateName: result.templateName,
        templateLanguage: result.templateLanguage,
        bodyParams: result.bodyParams,
        headerText: result.headerText,
      })
      return
    }

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: result.text,
      aiGenerated: true,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
