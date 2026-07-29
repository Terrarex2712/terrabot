import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'
import type { TemplateButton } from '@/types'

/**
 * Sync message templates from AiSensy → local message_templates table.
 *
 * Templates are dashboard-managed on AiSensy's side (no create/edit/
 * delete API available at this project's credential tier — confirmed
 * empirically, POST returns 403). This route only ever reads.
 *
 * Confirmed via a real call to `GET /project/{id}/wa_template`:
 *   { template: [{ id, name, label, status, category, text,
 *       sample_text, message_action_type, total_parameters, buttons,
 *       template_id, language, created_at, updated_at, ... }],
 *     size: <returned count>, count: <total available> }
 *
 * Pagination: the default page is 10 templates. `page`/`offset`/`skip`/
 * `start`/`cursor` are all silently ignored — confirmed by requesting
 * each against a real 45-template account and getting back the exact
 * same first 10 every time. `limit` is the one query param that
 * actually works (confirmed: `?limit=50` against that same account
 * returned all 45, uniquely). There's still no real offset-based
 * paging, so "fetch everything" means one extra request sized to
 * `count` rather than a loop: request the default page, and if
 * `count > size`, refetch once with `?limit=${count}`.
 *
 * One known remaining gap:
 *   - `language` comes back as a human name ("English (US)", "Hindi"),
 *     not a Meta-style code ("en_US"). Stored verbatim — whether
 *     AiSensy's send endpoint wants this same string or a translated
 *     code back is unconfirmed until a template send is attempted.
 *
 * Locally-created rows with no AiSensy counterpart are NOT deleted —
 * they remain visible so drift is noticeable rather than silently
 * erased.
 */

const AISENSY_API_BASE = 'https://apis.aisensy.com/project-apis/v1'

interface AiSensyTemplateButton {
  type: string
  button_title?: string
  button_value?: string
}

interface AiSensyTemplate {
  id: string
  name: string
  label?: string
  status: string
  category: string
  type?: string
  language?: string
  text?: string
  footerText?: string
  buttons?: AiSensyTemplateButton[]
  template_id?: string
  created_at?: number
  updated_at?: number
}

function normalizeCategory(
  raw: string,
): 'Marketing' | 'Utility' | 'Authentication' {
  const upper = raw.toUpperCase()
  if (upper === 'UTILITY') return 'Utility'
  if (upper === 'AUTHENTICATION') return 'Authentication'
  return 'Marketing'
}

function parseButtons(
  aisensyButtons: AiSensyTemplateButton[] | undefined,
): TemplateButton[] {
  if (!aisensyButtons?.length) return []
  const out: TemplateButton[] = []
  for (const b of aisensyButtons) {
    const title = b.button_title ?? ''
    switch (b.type?.toUpperCase()) {
      case 'QUICK_REPLY':
        out.push({ type: 'QUICK_REPLY', text: title })
        break
      case 'URL':
        out.push({ type: 'URL', text: title, url: b.button_value ?? '' })
        break
      case 'PHONE_NUMBER':
      case 'CALL':
        out.push({
          type: 'PHONE_NUMBER',
          text: title,
          phone_number: b.button_value ?? '',
        })
        break
      // COPY_CODE and anything else — no confirmed AiSensy shape yet;
      // drop silently rather than guess.
    }
  }
  return out
}

export async function POST() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config || !config.project_id || !config.api_key) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Connect your AiSensy project in Settings first.',
        },
        { status: 400 },
      )
    }

    const apiKey = decrypt(config.api_key)
    const templateUrl = `${AISENSY_API_BASE}/project/${config.project_id}/wa_template`

    async function fetchTemplates(query?: string) {
      const res = await fetch(query ? `${templateUrl}?${query}` : templateUrl, {
        headers: {
          Accept: 'application/json',
          'X-AiSensy-Project-API-Pwd': apiKey,
        },
      })
      if (!res.ok) {
        let message = `AiSensy API error: ${res.status}`
        try {
          const body = await res.json()
          if (body?.message) message = body.message
        } catch {
          // response wasn't JSON — keep the fallback
        }
        throw new Error(message)
      }
      return (await res.json()) as { template?: AiSensyTemplate[]; size?: number; count?: number }
    }

    let aisensyBody: { template?: AiSensyTemplate[]; size?: number; count?: number }
    try {
      aisensyBody = await fetchTemplates()
      // `limit` is the only pagination knob AiSensy actually honors —
      // see the module docstring. One extra request sized to `count`
      // covers the rest instead of a real offset-based loop.
      if (
        typeof aisensyBody.count === 'number' &&
        aisensyBody.count > (aisensyBody.template?.length ?? 0)
      ) {
        aisensyBody = await fetchTemplates(`limit=${aisensyBody.count}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AiSensy API error'
      return NextResponse.json({ error: message }, { status: 502 })
    }

    const templates = aisensyBody.template ?? []
    const truncated =
      typeof aisensyBody.count === 'number' && aisensyBody.count > templates.length

    let inserted = 0
    let updated = 0
    const errors: { name: string; language: string; message: string }[] = []

    for (const t of templates) {
      const language = t.language ?? 'en'

      const row = {
        account_id: accountId,
        user_id: user.id,
        name: t.name,
        category: normalizeCategory(t.category),
        language,
        body_text: t.text ?? '',
        footer_text: t.footerText ?? null,
        buttons: parseButtons(t.buttons).length ? parseButtons(t.buttons) : null,
        status: normalizeStatus(t.status),
        meta_template_id: t.template_id ?? null,
        updated_at: new Date().toISOString(),
      }

      const { data: existing, error: lookupErr } = await supabase
        .from('message_templates')
        .select('id')
        .eq('account_id', accountId)
        .eq('name', t.name)
        .eq('language', language)
        .maybeSingle()

      if (lookupErr) {
        errors.push({ name: t.name, language, message: lookupErr.message })
        continue
      }

      if (existing?.id) {
        const { error: updErr } = await supabase
          .from('message_templates')
          .update(row)
          .eq('id', existing.id)
        if (updErr) {
          errors.push({ name: t.name, language, message: updErr.message })
        } else {
          updated++
        }
      } else {
        const { error: insErr } = await supabase.from('message_templates').insert(row)
        if (insErr) {
          errors.push({ name: t.name, language, message: insErr.message })
        } else {
          inserted++
        }
      }
    }

    return NextResponse.json({
      success: errors.length === 0,
      total: templates.length,
      inserted,
      updated,
      errors,
      truncated,
    })
  } catch (error) {
    console.error('Error syncing WhatsApp templates:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to sync templates',
      },
      { status: 500 },
    )
  }
}
