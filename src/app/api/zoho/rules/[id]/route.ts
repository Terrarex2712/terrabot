import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { parseRuleBody } from '@/lib/zoho/validate-rule'

type Params = { params: Promise<{ id: string }> }

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/** PATCH /api/zoho/rules/[id]  (admin+) — full replace of the editable fields. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`zoho-rules:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const parsed = parseRuleBody(body)
    if ('error' in parsed) return bad(parsed.error)

    const { data, error } = await supabase
      .from('zoho_lead_rules')
      .update(parsed.row)
      .eq('id', id)
      .eq('account_id', accountId)
      .select('*')
      .maybeSingle()
    if (error) {
      console.error('[zoho/rules PATCH] update error:', error)
      return NextResponse.json({ error: 'Failed to update rule' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
    return NextResponse.json({ rule: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/zoho/rules/[id]  (admin+) */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`zoho-rules:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const { data, error } = await supabase
      .from('zoho_lead_rules')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id')
      .maybeSingle()
    if (error) {
      console.error('[zoho/rules DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete rule' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
