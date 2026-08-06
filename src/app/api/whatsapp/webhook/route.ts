import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { SendMessageError } from '@/lib/whatsapp/send-message'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchInboundToZohoLeadConvert } from '@/lib/zoho/lead-convert'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

// The `after()` callback in POST runs within this route's max duration.
// Vercel clamps this to the plan's ceiling; tune as needed.
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

// ============================================================
// AiSensy Message / Contact shapes.
//
// Fields below match what's confirmed from AiSensy's Stoplight docs
// (the Message / Contact schema pages). `message_content`'s shape for
// anything other than `text` is NOT confirmed — the fields under
// image/video/file/audio/location/button_reply/list_reply are best
// guesses by analogy to Meta's own inbound webhook shape (which
// AiSensy's send API proxies closely). See parseInboundContent below:
// a wrong guess degrades to a placeholder rather than crashing or
// losing the event.
// ============================================================

interface AiSensyMessage {
  /** AiSensy's own internal message id — NOT the WhatsApp message id. */
  id: string
  /** The real WhatsApp `wamid` — this is what we store as messages.message_id. */
  messageId: string
  project_id: string
  phone_number: string
  status: string
  sender: 'SYSTEM' | 'AGENT' | 'USER' | 'API'
  sent_at: number | null
  delivered_at: number | null
  read_at: number | null
  message_type: string
  message_content?: {
    text?: string
    image?: { link?: string; caption?: string }
    video?: { link?: string; caption?: string }
    document?: { link?: string; caption?: string; filename?: string }
    file?: { link?: string; caption?: string; filename?: string }
    audio?: { link?: string }
    location?: { latitude?: number; longitude?: number; name?: string; address?: string }
    button_reply?: { id?: string; title?: string }
    list_reply?: { id?: string; title?: string; description?: string }
  }
  /** Contact's display name. Confirmed camelCase from a real delivery
   *  — the docs screenshot showed `user_name`, which is wrong. */
  userName?: string
}

interface AiSensyContact {
  id: string
  project_id: string
  phone_number: string
  name?: string
}

// Real envelope, confirmed by inspecting an actual delivery through
// ngrok:
//   { id, created_at, topic, app_id, webhook_id, project_id,
//     delivery_attempt, data: { message?, contact? } }
// Notably different from the docs screenshots: the topic name comes
// through as `topic` (real events) — the dashboard's "Verify"/"Test"
// ping instead sends `event: "test.webhook"` with `data.message` as a
// plain greeting *string*, not a Message object. `project_id` is
// present at the top level of the body AND as its own
// `X-Aisensy-Project-Id` header (the header is what POST actually
// uses below — no body parsing needed to route to the right account).
interface AiSensyWebhookBody {
  event?: string
  topic?: string
  project_id?: string
  data?: {
    // `test.webhook` sets this to a plain string; real events set it
    // to a full Message object — see the shape guard in POST below.
    message?: AiSensyMessage | string
    contact?: AiSensyContact
  }
}

// GET — AiSensy's "Verify and Save" step in their webhook dashboard
// pings this with a plain GET before it'll let you save the endpoint
// (confirmed by inspecting the actual request through ngrok — no
// challenge/token to echo back, just needs a 2xx).
export async function GET() {
  return NextResponse.json({ status: 'ok' })
}

// POST — receive AiSensy webhook events (message.created,
// message.status.updated, message.sender.user, contact.*, …).
//
// The `event` field names the topic, but downstream dispatch still
// runs off the Message object's own `sender` field (USER = inbound
// customer message; AGENT/API/SYSTEM = an outbound send being echoed
// back, acted on only for its delivery `status`) rather than
// `event` directly — that's confirmed data and sufficient on its own,
// so it stays correct even for topics we haven't seen a real payload
// for yet.
export async function POST(request: Request) {
  const rawBody = await request.text()

  let body: AiSensyWebhookBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // `test.webhook` (and possibly other synthetic pings) sets
  // `data.message` to a plain greeting *string*, not a Message
  // object — confirmed by replaying the dashboard's actual "Verify"
  // request. Guard on object shape, not just truthiness, or a string
  // here silently passes the `!message` check and then fails later
  // looking for `.project_id` on a string.
  const rawMessage = body.data?.message
  const message =
    rawMessage && typeof rawMessage === 'object' ? rawMessage : undefined
  const contact = body.data?.contact

  // No real message/contact — nothing to act on and no project to
  // scope a signature check to, so just confirm reachability.
  if (!message && !contact) {
    return NextResponse.json({ status: 'ok' }, { status: 200 })
  }

  // Prefer the dedicated header — confirmed present on every real
  // delivery and avoids depending on body shape at all; body fields
  // are only a fallback.
  const projectId =
    request.headers.get('x-aisensy-project-id') ??
    body.project_id ??
    message?.project_id ??
    contact?.project_id
  if (!projectId) {
    console.warn('[aisensy-webhook] payload has no project_id — cannot resolve account')
    return NextResponse.json({ error: 'Missing project_id' }, { status: 400 })
  }

  const { data: config, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id, user_id')
    .eq('project_id', projectId)
    .maybeSingle()

  if (configError) {
    console.error('[aisensy-webhook] config lookup failed:', configError)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
  if (!config) {
    console.warn('[aisensy-webhook] no whatsapp_config for project_id:', projectId)
    return NextResponse.json({ error: 'Unknown project' }, { status: 404 })
  }

  // No signature verification: AiSensy doesn't expose a per-webhook
  // signing secret at the "App Password" credential tier — confirmed
  // exhaustively (dashboard UI, Network tab captured live from
  // creation, the read API, the create API, and testing whether the
  // Project API key itself was the HMAC key against real captured
  // deliveries — none of it turned up a usable secret). The account
  // is still scoped correctly via `project_id` above; what's missing
  // is proof the request really came from AiSensy rather than
  // anyone who discovers this URL. Accepted tradeoff, not an
  // oversight — revisit if AiSensy support ever provides a real key.
  // Process AFTER the response so we ack AiSensy quickly, while still
  // guaranteeing the work runs to completion. Serverless platforms can
  // freeze the function the moment the response is sent, so a
  // detached promise isn't safe here — see issue #301 on the previous
  // Meta webhook for the dropped-message failure mode this avoids.
  after(async () => {
    try {
      await processEvent(message, contact, config.account_id, config.user_id)
    } catch (error) {
      console.error('[aisensy-webhook] error processing event:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processEvent(
  message: AiSensyMessage | undefined,
  contact: AiSensyContact | undefined,
  accountId: string,
  configOwnerUserId: string,
): Promise<void> {
  if (!message) {
    // contact.created / contact.chat.closed and similar contact-only
    // events carry no `message`. Nothing downstream reacts to a bare
    // contact event yet — log for visibility rather than silently
    // dropping it.
    if (contact) {
      console.info('[aisensy-webhook] contact-only event, no-op:', contact.id)
    }
    return
  }

  if (message.sender === 'USER') {
    await processInboundMessage(message, accountId, configOwnerUserId)
    return
  }

  // AGENT / API / SYSTEM — AiSensy echoing back a message we (or an
  // agent, or AiSensy's own tooling) sent. The only thing to act on
  // here is its delivery status.
  if (message.status) {
    await handleStatusUpdate(message, accountId)
  }
}

// ============================================================
// Inbound customer messages
// ============================================================

async function processInboundMessage(
  message: AiSensyMessage,
  accountId: string,
  configOwnerUserId: string,
): Promise<void> {
  const db = supabaseAdmin()

  let resolved
  try {
    resolved = await resolveConversationByPhone(
      db,
      accountId,
      message.phone_number,
      message.userName,
    )
  } catch (err) {
    if (err instanceof SendMessageError) {
      console.warn('[aisensy-webhook] could not resolve conversation:', err.message)
      return
    }
    throw err
  }
  const { conversationId, contactId, contactCreated, conversationCreated } = resolved

  // AiSensy retries webhook deliveries (observed X-Retry-Count on real
  // deliveries) — a retry of the same event must not create a second
  // message or re-run flows/automations/AI-reply a second time.
  // message_id (the wamid) is unique enough scoped to one conversation
  // even though it isn't globally (a Meta quirk — ids can repeat across
  // different numbers, per migration 009).
  const { data: existingMessage } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('message_id', message.messageId)
    .maybeSingle()
  if (existingMessage) {
    console.info('[aisensy-webhook] duplicate delivery for message_id, skipping:', message.messageId)
    return
  }

  // Emit conversation.created as soon as the thread is opened, before
  // anything else, so a subscriber always sees the thread open before
  // its first message.received.
  if (conversationCreated) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: conversationId,
      contact_id: contactId,
    })
  }

  const { contentText, mediaUrl, interactiveReplyId } = parseInboundContent(message)
  const contentType = mapMessageType(message.message_type)

  // Determine whether this is the contact's very first inbound message
  // BEFORE inserting, so the count is accurate.
  const { count: priorCustomerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError, data: insertedMessage } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'customer',
      content_type: contentType,
      content_text: contentText,
      media_url: mediaUrl,
      message_id: message.messageId,
      status: 'delivered',
      interactive_reply_id: interactiveReplyId,
    })
    .select('id')
    .single()

  if (msgError || !insertedMessage) {
    console.error('[aisensy-webhook] error inserting message:', msgError)
    return
  }

  const { data: convRow } = await db
    .from('conversations')
    .select('unread_count')
    .eq('id', conversationId)
    .maybeSingle()

  const { error: convError } = await db
    .from('conversations')
    .update({
      last_message_text: contentText || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (convRow?.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
  if (convError) {
    console.error('[aisensy-webhook] error updating conversation:', convError)
  }

  // If this contact was a recent broadcast recipient, flag the reply
  // so the broadcast's `replied_count` advances.
  await flagBroadcastReplyIfAny(accountId, contactId)

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId,
    conversationId,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: message.messageId,
        }
      : {
          kind: 'text',
          text: contentText ?? '',
          meta_message_id: message.messageId,
        },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  if (contactCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId,
      context: {
        message_text: contentText ?? '',
        conversation_id: conversationId,
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  // Zoho CRM lead conversion — independent side effect, not a reply, so
  // it runs unconditionally (regardless of flow/automation/AI outcome)
  // and fire-and-forget, same idiom as the automations loop above.
  dispatchInboundToZohoLeadConvert({ accountId, contactId, conversationId }).catch((err) =>
    console.error('[zoho] lead-convert dispatch failed:', err),
  )

  // AI auto-reply — only for plain-text inbound the flow runner did
  // NOT consume, and only when the account has enabled it.
  if (!flowConsumed && !interactiveReplyId && (contentText ?? '').trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId,
      contactId,
      configOwnerUserId,
    })
  }

  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversationId,
    contact_id: contactId,
    whatsapp_message_id: message.messageId,
    content_type: contentType,
    text: contentText,
  })
}

function mapMessageType(messageType: string): string {
  switch (messageType) {
    case 'IMAGE':
    case 'STICKER':
      return 'image'
    case 'VIDEO':
      return 'video'
    case 'FILE':
      return 'document'
    case 'AUDIO':
      return 'audio'
    case 'LOCATION':
      return 'location'
    case 'BUTTON_REPLY':
    case 'LIST_REPLY':
      return 'interactive'
    default:
      return 'text'
  }
}

/**
 * Extract text/media/interactive-reply content from an inbound
 * Message. Only the `text` variant of `message_content` is confirmed
 * against AiSensy's docs — every other case guesses field names by
 * analogy to Meta's own webhook shape and falls back to a visible
 * placeholder if the guess doesn't match, so an unconfirmed shape
 * degrades gracefully instead of crashing or silently losing the
 * message.
 */
function parseInboundContent(message: AiSensyMessage): {
  contentText: string | null
  mediaUrl: string | null
  interactiveReplyId: string | null
} {
  const content = message.message_content ?? {}

  switch (message.message_type) {
    case 'TEXT':
      return { contentText: content.text ?? null, mediaUrl: null, interactiveReplyId: null }

    case 'BUTTON_REPLY':
      if (content.button_reply?.id) {
        return {
          contentText: content.button_reply.title || content.button_reply.id,
          mediaUrl: null,
          interactiveReplyId: content.button_reply.id,
        }
      }
      break

    case 'LIST_REPLY':
      if (content.list_reply?.id) {
        return {
          contentText: content.list_reply.title || content.list_reply.id,
          mediaUrl: null,
          interactiveReplyId: content.list_reply.id,
        }
      }
      break

    case 'IMAGE':
    case 'STICKER':
      if (content.image?.link) {
        return { contentText: content.image.caption ?? null, mediaUrl: content.image.link, interactiveReplyId: null }
      }
      break

    case 'VIDEO':
      if (content.video?.link) {
        return { contentText: content.video.caption ?? null, mediaUrl: content.video.link, interactiveReplyId: null }
      }
      break

    case 'FILE':
      if (content.file?.link) {
        return {
          contentText: content.file.caption ?? content.file.filename ?? null,
          mediaUrl: content.file.link,
          interactiveReplyId: null,
        }
      }
      if (content.document?.link) {
        return {
          contentText: content.document.caption ?? content.document.filename ?? null,
          mediaUrl: content.document.link,
          interactiveReplyId: null,
        }
      }
      break

    case 'AUDIO':
      if (content.audio?.link) {
        return { contentText: null, mediaUrl: content.audio.link, interactiveReplyId: null }
      }
      break

    case 'LOCATION':
      if (content.location) {
        const loc = content.location
        const locationText = [
          loc.name,
          loc.address,
          loc.latitude != null && loc.longitude != null ? `${loc.latitude},${loc.longitude}` : null,
        ]
          .filter(Boolean)
          .join(' - ')
        return { contentText: locationText || null, mediaUrl: null, interactiveReplyId: null }
      }
      break
  }

  return {
    contentText: content.text ?? `[Unsupported message type: ${message.message_type}]`,
    mediaUrl: null,
    interactiveReplyId: null,
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast. Best-effort — failures here must
 * not break the main inbound-message flow.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

// ============================================================
// Outbound delivery status (a message WE sent, echoed back)
// ============================================================

// The happy-path status ladder — sent → delivered → read. Webhook
// replays must never regress a recipient back down this ladder.
const RECIPIENT_STATUS_LADDER = ['pending', 'sent', 'delivered', 'read', 'replied'] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false
  if (ci < 0) return true
  return ii > ci
}

async function handleStatusUpdate(message: AiSensyMessage, accountId: string): Promise<void> {
  const db = supabaseAdmin()
  const status = message.status.toLowerCase()

  // Mirror onto messages. No `.select()` — message_id isn't unique
  // (Meta ids could repeat across numbers; same defensive posture
  // carries over), so this updates 0..N rows.
  const { error: msgErr } = await db
    .from('messages')
    .update({ status })
    .eq('message_id', message.messageId)
  if (msgErr) {
    console.error('[aisensy-webhook] error updating message status:', msgErr)
  }

  const tsMillis = message.delivered_at ?? message.read_at ?? message.sent_at ?? Date.now()
  const tsIso = new Date(tsMillis).toISOString()

  // Mirror onto broadcast_recipients via whatsapp_message_id. The
  // aggregate trigger re-derives the parent broadcast's counts.
  const { data: recipient, error: recFetchErr } = await db
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', message.messageId)
    .maybeSingle()

  if (recFetchErr) {
    console.error('[aisensy-webhook] error fetching broadcast recipient:', recFetchErr)
  } else if (recipient && isValidStatusTransition(recipient.status, status)) {
    const update: Record<string, unknown> = { status }
    if (status === 'sent') update.sent_at = tsIso
    if (status === 'delivered') update.delivered_at = tsIso
    if (status === 'read') update.read_at = tsIso

    const { error: recUpdateErr } = await db
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('[aisensy-webhook] error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // Webhook fan-out for messages we store (inbox / API sends). Bounded
  // to one row (message_id isn't unique) purely to resolve the owning
  // account for delivery.
  const { data: msgRow } = await db
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', message.messageId)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = msgRow.conversations as { account_id: string } | null
    const rowAccountId = conv?.account_id ?? accountId
    await dispatchWebhookEvent(db, rowAccountId, 'message.status_updated', {
      whatsapp_message_id: message.messageId,
      conversation_id: msgRow.conversation_id,
      status,
    })
  }
}
