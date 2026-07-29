/**
 * AiSensy Project API helpers — replaces meta-api.ts.
 *
 * AiSensy's `/messages` endpoint is a near-exact proxy of Meta's own
 * WhatsApp Cloud API: same `messaging_product`/`recipient_type`/`to`/
 * `type`/`text.body`/`image.link`/`document.link`/`template.name+
 * language+components` request shape, same `{messaging_product,
 * contacts[].wa_id, messages[].id}` response shape (confirmed against
 * their Stoplight docs + a live cURL example). Only the base URL and
 * auth header differ — no OAuth, no token refresh, just a static
 * per-project key.
 *
 * Every function takes a single options object (named parameters),
 * matching meta-api.ts's convention — a typo surfaces as a TypeScript
 * error instead of a runtime rejection from the API.
 *
 * AiSensy's error-response shape is unconfirmed (their docs don't show
 * one). `throwAiSensyError` tries Meta's `{error:{message}}` envelope
 * first since the success shape is proxied verbatim, then falls back
 * to a couple of common alternatives before giving up on the raw
 * status code — correct this once a real error response is observed.
 */

const AISENSY_API_BASE = 'https://apis.aisensy.com/project-apis/v1'

export interface AiSensySendResult {
  messageId: string
}

async function throwAiSensyError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as {
      error?: { message?: string } | string
      message?: string
    }
    if (typeof data.error === 'string') message = data.error
    else if (data.error?.message) message = data.error.message
    else if (data.message) message = data.message
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

function messagesUrl(projectId: string): string {
  return `${AISENSY_API_BASE}/project/${projectId}/messages`
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-AiSensy-Project-API-Pwd': apiKey,
  }
}

// ============================================================
// Sending
// ============================================================

export interface SendTextMessageArgs {
  projectId: string
  apiKey: string
  to: string
  text: string
  /** message_id of the message being replied to (quote preview). */
  contextMessageId?: string
}

/**
 * Send a free-form WhatsApp text message.
 * Only works inside the 24-hour customer service window.
 */
export async function sendTextMessage(
  args: SendTextMessageArgs
): Promise<AiSensySendResult> {
  const { projectId, apiKey, to, text, contextMessageId } = args
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text },
  }
  if (contextMessageId) {
    body.context = { message_id: contextMessageId }
  }
  const response = await fetch(messagesUrl(projectId), {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwAiSensyError(response, `AiSensy API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

export type MediaKind = 'image' | 'video' | 'document' | 'audio'

export interface SendMediaMessageArgs {
  projectId: string
  apiKey: string
  to: string
  kind: MediaKind
  /** Public URL fetched at send time. */
  link: string
  /** Optional caption — Meta (and presumably AiSensy) caps at 1024 chars. Audio does NOT accept one. */
  caption?: string
  /** Document-only. Shown in the recipient's chat as the file name. */
  filename?: string
  contextMessageId?: string
}

/**
 * Send an image, video, document, or audio (voice note) via a public URL.
 *
 * Audio is special-cased: neither `caption` nor `filename` is sent, per
 * Meta's spec (and this endpoint proxies Meta's exact validation) —
 * WhatsApp auto-renders an OGG/Opus file as a playable voice note.
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs,
): Promise<AiSensySendResult> {
  const { projectId, apiKey, to, kind, link, caption, filename, contextMessageId } = args
  if (!link) throw new Error('sendMediaMessage requires a link.')

  const media: Record<string, unknown> = { link }
  if (caption && kind !== 'audio') media.caption = caption
  if (kind === 'document' && filename) media.filename = filename

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: kind,
    [kind]: media,
  }
  if (contextMessageId) body.context = { message_id: contextMessageId }

  const response = await fetch(messagesUrl(projectId), {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwAiSensyError(response, `AiSensy API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

import type { MessageTemplate } from '@/types'
import {
  buildSendComponents,
  type SendTimeParams,
} from './template-send-builder'

export interface SendTemplateMessageArgs {
  projectId: string
  apiKey: string
  to: string
  templateName: string
  language?: string
  /** Legacy body-only params. See meta-api.ts's history for why both exist. */
  params?: string[]
  /**
   * The template row from message_templates. When provided, the helper
   * builds the full components array (header + body + buttons) via
   * buildSendComponents — the same builder meta-api.ts used, unchanged,
   * since the per-send `template.components` shape is confirmed identical.
   */
  template?: MessageTemplate
  messageParams?: SendTimeParams
  contextMessageId?: string
}

// `GET /wa_template` returns `language` as a human-readable display name
// ("English", "Hindi") — confirmed via templates/sync/route.ts — but the
// send endpoint wants a real language code and rejects the display name
// outright (`(#132001) Template name does not exist in the translation`,
// confirmed against a real account). Also confirmed empirically:
// AiSensy's codes here are short (`en`, `hi`), NOT Meta-style locale tags
// — `en_US` errors the exact same way as `English` does. `en_US` is
// mapped here too because it's the legacy Meta-era default used as a
// fallback throughout this codebase (a leftover from before the AiSensy
// migration); every other caller of this fallback is repaired by fixing
// it once, here. Extend this map as more languages are confirmed
// against a real send — any value not listed passes through unchanged
// rather than guessing.
const AISENSY_DISPLAY_NAME_TO_CODE: Record<string, string> = {
  english: 'en',
  hindi: 'hi',
  en_us: 'en',
}

/** Exported so callers that need to pick among several language variants
 *  of the same template (e.g. "prefer English") can compare normalized
 *  codes instead of the raw display name. */
export function normalizeAiSensyLanguage(language: string): string {
  return AISENSY_DISPLAY_NAME_TO_CODE[language.toLowerCase()] ?? language
}

/**
 * Send a pre-approved WhatsApp message template. Required outside the
 * 24-hour window and for any first-touch messaging.
 */
export async function sendTemplateMessage(
  args: SendTemplateMessageArgs
): Promise<AiSensySendResult> {
  const {
    projectId,
    apiKey,
    to,
    templateName,
    language = 'en_US',
    params,
    template,
    messageParams,
    contextMessageId,
  } = args

  const templatePayload: Record<string, unknown> = {
    name: templateName,
    language: { code: normalizeAiSensyLanguage(language) },
  }

  if (template) {
    const components = buildSendComponents(template, {
      body: messageParams?.body ?? params,
      headerText: messageParams?.headerText,
      headerMediaUrl: messageParams?.headerMediaUrl,
      headerMediaId: messageParams?.headerMediaId,
      buttonParams: messageParams?.buttonParams,
    })
    if (components.length > 0) {
      templatePayload.components = components
    }
  } else if (params && params.length > 0) {
    templatePayload.components = [
      {
        type: 'body',
        parameters: params.map((p) => ({ type: 'text', text: String(p) })),
      },
    ]
  }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: templatePayload,
  }
  if (contextMessageId) {
    body.context = { message_id: contextMessageId }
  }

  const response = await fetch(messagesUrl(projectId), {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwAiSensyError(response, `AiSensy API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

// ============================================================
// Reactions
// ============================================================

export interface SendReactionMessageArgs {
  projectId: string
  apiKey: string
  to: string
  /** message_id of the message being reacted to. */
  targetMessageId: string
  /** Single emoji, or empty string to remove an existing reaction. */
  emoji: string
}

/**
 * Send a reaction (or removal) to a previously-exchanged message.
 *
 * Unconfirmed whether AiSensy's proxy accepts `type: reaction` at all
 * (their documented payload schema didn't show it) — attempted as-is;
 * a failure here surfaces as a normal thrown Error that callers should
 * treat as "reactions may not be supported on this plan" rather than a
 * generic 500.
 */
export async function sendReactionMessage(
  args: SendReactionMessageArgs
): Promise<AiSensySendResult> {
  const { projectId, apiKey, to, targetMessageId, emoji } = args
  const response = await fetch(messagesUrl(projectId), {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'reaction',
      reaction: { message_id: targetMessageId, emoji },
    }),
  })
  if (!response.ok) {
    await throwAiSensyError(
      response,
      `AiSensy API error: ${response.status} (reactions may not be supported on your AiSensy plan)`,
    )
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

// ============================================================
// Interactive (button replies + list messages)
// ============================================================
//
// Same validation + payload shape as Meta's interactive messages —
// unconfirmed whether AiSensy's proxy accepts `type: interactive` at
// all (their documented payload schema didn't show it either), but
// their inbound Message schema's `message_type` enum includes
// BUTTON_REPLY/LIST_REPLY, which implies *receiving* a tap is
// supported. Attempted as-is; see sendReactionMessage's note on
// failure handling.

/**
 * Limits carried over from Meta's documented WhatsApp interactive-
 * message caps (unconfirmed for AiSensy specifically — this endpoint
 * proxies Meta closely enough that they're a reasonable default until
 * proven otherwise). See:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages
 */
export const INTERACTIVE_LIMITS = {
  maxButtons: 3,
  buttonTitleMaxLength: 20,
  maxListSections: 10,
  maxListRowsTotal: 10,
  listRowTitleMaxLength: 24,
  listRowDescriptionMaxLength: 72,
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
} as const

export interface InteractiveButton {
  /** Stable id sent back in the webhook when tapped. */
  id: string
  /** Visible label (≤ 20 chars). */
  title: string
}

export interface SendInteractiveButtonsArgs {
  projectId: string
  apiKey: string
  to: string
  bodyText: string
  headerText?: string
  footerText?: string
  buttons: InteractiveButton[]
  contextMessageId?: string
}

/**
 * Send an interactive message with up to 3 inline reply buttons.
 * Validation throws BEFORE the network call so misconfigured flows
 * fail at save time, not during a live conversation.
 */
export async function sendInteractiveButtons(
  args: SendInteractiveButtonsArgs
): Promise<AiSensySendResult> {
  const {
    projectId, apiKey, to,
    bodyText, headerText, footerText, buttons, contextMessageId,
  } = args
  validateInteractiveBody(bodyText)
  validateInteractiveHeaderFooter(headerText, footerText)
  if (buttons.length < 1 || buttons.length > INTERACTIVE_LIMITS.maxButtons) {
    throw new Error(
      `Interactive button message requires 1-${INTERACTIVE_LIMITS.maxButtons} buttons (got ${buttons.length}).`
    )
  }
  const seenButtonIds = new Set<string>()
  for (const btn of buttons) {
    if (!btn.id) throw new Error('Interactive button missing id.')
    if (seenButtonIds.has(btn.id)) {
      throw new Error(`Interactive message has duplicate button id "${btn.id}".`)
    }
    seenButtonIds.add(btn.id)
    if (!btn.title) throw new Error(`Interactive button "${btn.id}" missing title.`)
    if (btn.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
      throw new Error(
        `Interactive button title "${btn.title}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`
      )
    }
  }

  const interactive: Record<string, unknown> = {
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: buttons.map((b) => ({
        type: 'reply',
        reply: { id: b.id, title: b.title },
      })),
    },
  }
  if (headerText) interactive.header = { type: 'text', text: headerText }
  if (footerText) interactive.footer = { text: footerText }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive,
  }
  if (contextMessageId) body.context = { message_id: contextMessageId }

  const response = await fetch(messagesUrl(projectId), {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwAiSensyError(
      response,
      `AiSensy API error: ${response.status} (interactive buttons may not be supported on your AiSensy plan)`,
    )
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

export interface InteractiveListRow {
  id: string
  title: string
  description?: string
}

export interface InteractiveListSection {
  title?: string
  rows: InteractiveListRow[]
}

export interface SendInteractiveListArgs {
  projectId: string
  apiKey: string
  to: string
  bodyText: string
  buttonLabel: string
  headerText?: string
  footerText?: string
  sections: InteractiveListSection[]
  contextMessageId?: string
}

/**
 * Send an interactive message with a tap-to-expand list of selectable
 * rows. Use when there are more options than the 3-button limit allows.
 */
export async function sendInteractiveList(
  args: SendInteractiveListArgs
): Promise<AiSensySendResult> {
  const {
    projectId, apiKey, to,
    bodyText, buttonLabel, headerText, footerText, sections, contextMessageId,
  } = args
  validateInteractiveBody(bodyText)
  validateInteractiveHeaderFooter(headerText, footerText)
  if (!buttonLabel) throw new Error('Interactive list requires a buttonLabel.')
  if (buttonLabel.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
    throw new Error(
      `Interactive list buttonLabel "${buttonLabel}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`
    )
  }
  if (sections.length < 1 || sections.length > INTERACTIVE_LIMITS.maxListSections) {
    throw new Error(
      `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListSections} sections (got ${sections.length}).`
    )
  }
  const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0)
  if (totalRows < 1 || totalRows > INTERACTIVE_LIMITS.maxListRowsTotal) {
    throw new Error(
      `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListRowsTotal} rows total across all sections (got ${totalRows}).`
    )
  }
  const seenIds = new Set<string>()
  for (const section of sections) {
    for (const row of section.rows) {
      if (!row.id) throw new Error('Interactive list row missing id.')
      if (seenIds.has(row.id)) {
        throw new Error(`Interactive list has duplicate row id "${row.id}".`)
      }
      seenIds.add(row.id)
      if (!row.title) throw new Error(`Interactive list row "${row.id}" missing title.`)
      if (row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength) {
        throw new Error(
          `Interactive list row title "${row.title}" exceeds ${INTERACTIVE_LIMITS.listRowTitleMaxLength} chars.`
        )
      }
      if (
        row.description &&
        row.description.length > INTERACTIVE_LIMITS.listRowDescriptionMaxLength
      ) {
        throw new Error(
          `Interactive list row description for "${row.id}" exceeds ${INTERACTIVE_LIMITS.listRowDescriptionMaxLength} chars.`
        )
      }
    }
  }

  const interactive: Record<string, unknown> = {
    type: 'list',
    body: { text: bodyText },
    action: {
      button: buttonLabel,
      sections: sections.map((s) => ({
        ...(s.title ? { title: s.title } : {}),
        rows: s.rows.map((r) => ({
          id: r.id,
          title: r.title,
          ...(r.description ? { description: r.description } : {}),
        })),
      })),
    },
  }
  if (headerText) interactive.header = { type: 'text', text: headerText }
  if (footerText) interactive.footer = { text: footerText }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive,
  }
  if (contextMessageId) body.context = { message_id: contextMessageId }

  const response = await fetch(messagesUrl(projectId), {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwAiSensyError(
      response,
      `AiSensy API error: ${response.status} (interactive lists may not be supported on your AiSensy plan)`,
    )
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

function validateInteractiveBody(bodyText: string): void {
  if (!bodyText) throw new Error('Interactive message requires bodyText.')
  if (bodyText.length > INTERACTIVE_LIMITS.bodyMaxLength) {
    throw new Error(
      `Interactive bodyText exceeds ${INTERACTIVE_LIMITS.bodyMaxLength} chars.`
    )
  }
}

function validateInteractiveHeaderFooter(
  headerText: string | undefined,
  footerText: string | undefined,
): void {
  if (headerText && headerText.length > INTERACTIVE_LIMITS.headerTextMaxLength) {
    throw new Error(
      `Interactive headerText exceeds ${INTERACTIVE_LIMITS.headerTextMaxLength} chars.`
    )
  }
  if (footerText && footerText.length > INTERACTIVE_LIMITS.footerMaxLength) {
    throw new Error(
      `Interactive footerText exceeds ${INTERACTIVE_LIMITS.footerMaxLength} chars.`
    )
  }
}
