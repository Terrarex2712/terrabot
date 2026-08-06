import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { parseRuleBody } from '@/lib/zoho/validate-rule'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/** GET /api/zoho/rules — any member. */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('zoho_lead_rules')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
    if (error) {
      console.error('[zoho/rules GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load rules' }, { status: 500 })
    }
    return NextResponse.json({ rules: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** POST /api/zoho/rules  (admin+) — create a rule. */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`zoho-rules:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const parsed = parseRuleBody(body)
    if ('error' in parsed) return bad(parsed.error)

    const { data, error } = await supabase
      .from('zoho_lead_rules')
      .insert({ account_id: accountId, created_by: userId, ...parsed.row })
      .select('*')
      .single()
    if (error) {
      console.error('[zoho/rules POST] insert error:', error)
      return NextResponse.json({ error: 'Failed to create rule' }, { status: 500 })
    }
    return NextResponse.json({ rule: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
