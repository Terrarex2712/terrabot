import { supabaseAdmin } from './admin-client'
import { loadZohoConfig } from './config'
import { createLead } from './client'
import type { ZohoLeadRuleCriteriaType } from './types'

interface DispatchArgs {
  accountId: string
  contactId: string
  conversationId: string
}

interface ContactRow {
  account_id: string
  name: string | null
  phone: string
  city: string | null
  zoho_lead_id: string | null
}

interface ZohoLeadRuleRow {
  id: string
  account_id: string
  name: string
  criteria_type: ZohoLeadRuleCriteriaType
  match_type: 'contains' | 'exact'
  case_sensitive: boolean
  keywords: string[]
  lead_source: string | null
  is_active: boolean
}

/**
 * Zoho lead conversion for a freshly-arrived inbound message (or a new
 * contact). Invoked fire-and-forget from the webhook — mirrors
 * `dispatchInboundToAiReply`'s contract: owns its own try/catch and
 * NEVER throws, since a Zoho outage or a bad token must never affect
 * the webhook's ack.
 *
 * Eligibility gates (any → silent no-op):
 *   - contact not found / doesn't belong to this account
 *   - contact already converted (`zoho_lead_id` set — this doubles as
 *     the dedupe flag, no separate boolean needed)
 *   - Zoho isn't configured / sync isn't turned on for the account
 *   - no active rules
 *   - no rule matches
 */
export async function dispatchInboundToZohoLeadConvert(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, contactId, conversationId } = args

  try {
    const db = supabaseAdmin()

    const [{ data: contact, error: contactErr }, config, { data: rules, error: rulesErr }] =
      await Promise.all([
        db
          .from('contacts')
          .select('account_id, name, phone, city, zoho_lead_id')
          .eq('id', contactId)
          .maybeSingle(),
        loadZohoConfig(db, accountId),
        db
          .from('zoho_lead_rules')
          .select('id, account_id, name, criteria_type, match_type, case_sensitive, keywords, lead_source, is_active')
          .eq('account_id', accountId)
          .eq('is_active', true),
      ])

    if (contactErr || !contact) return
    const contactRow = contact as ContactRow
    if (contactRow.account_id !== accountId) return // ownership guard
    if (contactRow.zoho_lead_id) return // already converted

    if (!config) return // Zoho not configured / sync off for this account

    if (rulesErr || !rules || rules.length === 0) return
    const activeRules = rules as ZohoLeadRuleRow[]

    // Only fetch the conversation's message history when at least one
    // rule actually needs it — most accounts will have zero or one rule.
    const needsMessages = activeRules.some((r) => r.criteria_type === 'message_text')
    const customerMessages = needsMessages
      ? await fetchAllCustomerText(db, conversationId)
      : []

    const matchedRule = activeRules.find((rule) =>
      evaluateRule(rule, { customerMessages, contactCity: contactRow.city }),
    )
    if (!matchedRule) return

    const result = await createLead(config, {
      lastName: contactRow.name?.trim() || contactRow.phone,
      phone: contactRow.phone,
      city: contactRow.city ?? undefined,
      leadSource: matchedRule.lead_source ?? undefined,
    })

    if (!result.ok) {
      // A well-formed Zoho rejection (duplicate, validation, etc.) — log
      // and leave `zoho_lead_id` unset so the next matching inbound
      // naturally retries.
      console.warn(
        `[zoho lead-convert] contact ${contactId} rejected by Zoho: ${result.code} — ${result.message}`,
      )
      return
    }

    await db
      .from('contacts')
      .update({ zoho_lead_id: result.leadId, zoho_lead_synced_at: new Date().toISOString() })
      .eq('id', contactId)
  } catch (err) {
    console.error('[zoho lead-convert] dispatch failed:', err)
  }
}

/** Fetch all of a conversation's customer text messages, oldest first.
 *  Deliberately uncapped (unlike `buildConversationContext`'s windowed
 *  fetch) — a keyword mentioned several messages back must still match
 *  on a later inbound. */
async function fetchAllCustomerText(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
): Promise<string[]> {
  const { data, error } = await db
    .from('messages')
    .select('content_text')
    .eq('conversation_id', conversationId)
    .eq('content_type', 'text')
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: true })

  if (error || !data) return []
  return data
    .map((m: { content_text: string | null }) => m.content_text)
    .filter((t: string | null): t is string => !!t)
}

function evaluateRule(
  rule: ZohoLeadRuleRow,
  ctx: { customerMessages: string[]; contactCity: string | null },
): boolean {
  if (!rule.keywords || rule.keywords.length === 0) return false

  const haystacks =
    rule.criteria_type === 'message_text'
      ? ctx.customerMessages
      : ctx.contactCity
        ? [ctx.contactCity]
        : []

  return haystacks.some((raw) => matchesAnyKeyword(raw, rule))
}

function matchesAnyKeyword(text: string, rule: ZohoLeadRuleRow): boolean {
  const haystack = rule.case_sensitive ? text : text.toLowerCase()
  return rule.keywords.some((raw) => {
    const keyword = rule.case_sensitive ? raw : raw.toLowerCase()
    return rule.match_type === 'exact' ? haystack === keyword : haystack.includes(keyword)
  })
}
