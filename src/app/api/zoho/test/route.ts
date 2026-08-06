import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import { testConnection } from '@/lib/zoho/client'
import { ZohoError, type ZohoDataCenter } from '@/lib/zoho/types'

const DATA_CENTERS: ZohoDataCenter[] = ['com', 'eu', 'in', 'com.cn', 'com.au', 'jp', 'ca']

/**
 * POST /api/zoho/test  (admin+)
 *
 * "Test connection" button: verify a candidate credential set against
 * Zoho WITHOUT saving. Any field omitted from the body falls back to
 * the account's stored+decrypted value, so an admin can test before
 * ever typing a secret, or re-test an already-saved config. Returns
 * `{ ok: true, company_name }` on success, 400 with the Zoho error on
 * failure. Mirrors `/api/ai/test`.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`zoho-test:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const { data: existing } = await supabase
      .from('zoho_configs')
      .select('data_center, client_id, client_secret, refresh_token')
      .eq('account_id', accountId)
      .maybeSingle()

    const dataCenter = (
      typeof body.data_center === 'string' && DATA_CENTERS.includes(body.data_center as ZohoDataCenter)
        ? body.data_center
        : existing?.data_center
    ) as ZohoDataCenter | undefined
    if (!dataCenter) {
      return NextResponse.json({ error: 'data_center is required' }, { status: 400 })
    }

    const clientId =
      (typeof body.client_id === 'string' ? body.client_id.trim() : '') || existing?.client_id
    if (!clientId) {
      return NextResponse.json({ error: 'client_id is required' }, { status: 400 })
    }

    const rawSecret = typeof body.client_secret === 'string' ? body.client_secret.trim() : ''
    let clientSecret = rawSecret
    if (!clientSecret) {
      if (!existing?.client_secret) {
        return NextResponse.json({ error: 'client_secret is required' }, { status: 400 })
      }
      try {
        clientSecret = decrypt(existing.client_secret)
      } catch {
        return NextResponse.json(
          { error: 'Stored client secret could not be decrypted — re-enter your credentials.' },
          { status: 400 },
        )
      }
    }

    const rawRefreshToken = typeof body.refresh_token === 'string' ? body.refresh_token.trim() : ''
    let refreshToken = rawRefreshToken
    if (!refreshToken) {
      if (!existing?.refresh_token) {
        return NextResponse.json({ error: 'refresh_token is required' }, { status: 400 })
      }
      try {
        refreshToken = decrypt(existing.refresh_token)
      } catch {
        return NextResponse.json(
          { error: 'Stored refresh token could not be decrypted — re-enter your credentials.' },
          { status: 400 },
        )
      }
    }

    try {
      const { companyName } = await testConnection({ dataCenter, clientId, clientSecret, refreshToken })
      return NextResponse.json({ ok: true, company_name: companyName })
    } catch (err) {
      if (err instanceof ZohoError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
      }
      console.error('[zoho/test] connection test error:', err)
      return NextResponse.json({ error: 'Could not verify the Zoho credentials.' }, { status: 400 })
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
