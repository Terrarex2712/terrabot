import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendTemplateMessage, normalizeAiSensyLanguage } from './aisensy-api'

// ============================================================
// Regression coverage for the language-code bug found while building
// the AI template auto-reply feature: AiSensy's `wa_template` sync
// stores `language` as a human-readable display name ("English",
// "Hindi"), but the send endpoint rejects that outright and wants a
// short code ("en", "hi") — confirmed against a real account
// (`(#132001) Template name does not exist in the translation`). The
// pre-existing `en_US` fallback used throughout this codebase (a
// leftover from the Meta-era default) fails the exact same way, so
// it's normalized too.
// ============================================================

describe('normalizeAiSensyLanguage', () => {
  it('maps known display names to their real AiSensy code', () => {
    expect(normalizeAiSensyLanguage('English')).toBe('en')
    expect(normalizeAiSensyLanguage('Hindi')).toBe('hi')
  })

  it('is case-insensitive', () => {
    expect(normalizeAiSensyLanguage('ENGLISH')).toBe('en')
  })

  it('maps the legacy Meta-era default to the confirmed-working code', () => {
    expect(normalizeAiSensyLanguage('en_US')).toBe('en')
  })

  it('passes an unrecognized value through unchanged rather than guessing', () => {
    expect(normalizeAiSensyLanguage('fr_FR')).toBe('fr_FR')
  })
})

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ messages: [{ id: 'wamid-1' }] })))
})
afterEach(() => vi.unstubAllGlobals())

describe('sendTemplateMessage — language normalization', () => {
  it('sends the normalized code, not the raw display name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ messages: [{ id: 'wamid-1' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await sendTemplateMessage({
      projectId: 'proj-1',
      apiKey: 'key-1',
      to: '15551234567',
      templateName: 'zoho_desk_ticket_created2',
      language: 'English',
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.template.language).toEqual({ code: 'en' })
  })

  it('normalizes the en_US default the same way', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ messages: [{ id: 'wamid-1' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await sendTemplateMessage({
      projectId: 'proj-1',
      apiKey: 'key-1',
      to: '15551234567',
      templateName: 'zoho_desk_ticket_created2',
      // language omitted → defaults to 'en_US' internally
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.template.language).toEqual({ code: 'en' })
  })
})
