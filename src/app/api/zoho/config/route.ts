import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { testConnection } from '@/lib/zoho/client'
import { ZohoError, type ZohoDataCenter } from '@/lib/zoho/types'

const DATA_CENTERS: ZohoDataCenter[] = ['com', 'eu', 'in', 'com.cn', 'com.au', 'jp', 'ca']

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/zoho/config
 *
 * Any member may read the config so the settings page can reflect
 * whether Zoho sync is set up. Secrets are NEVER returned — only
 * `has_client_secret`/`has_refresh_token` flags; the form shows a
 * masked placeholder. Mirrors `/api/ai/config`.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('zoho_configs')
      .select('data_center, client_id, client_secret, refresh_token, is_active, last_org_name, last_connected_at')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[zoho/config GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load Zoho configuration' }, { status: 500 })
    }

    if (!data) return NextResponse.json({ configured: false })

    const { client_secret, refresh_token, ...safe } = data
    return NextResponse.json({
      configured: true,
      has_client_secret: !!client_secret,
      has_refresh_token: !!refresh_token,
      ...safe,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/zoho/config  (admin+)
 *
 * Upsert the account's Zoho credentials. When the client secret or
 * refresh token (or the client id / data center) actually changed, a
 * live "Test connection" call must succeed before anything is
 * persisted — mirrors `/api/ai/config`'s `validateAiCredentials` gate.
 * Untouched secrets are reused (decrypted from the existing row) rather
 * than re-sent by the form.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`zoho-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const dataCenter = body.data_center as ZohoDataCenter
    if (!DATA_CENTERS.includes(dataCenter)) {
      return bad(`data_center must be one of: ${DATA_CENTERS.join(', ')}`)
    }
    const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : ''
    if (!clientId) return bad('client_id is required')

    const isActive = body.is_active === true

    const rawSecret = typeof body.client_secret === 'string' ? body.client_secret.trim() : ''
    const rawRefreshToken = typeof body.refresh_token === 'string' ? body.refresh_token.trim() : ''

    const { data: existing } = await supabase
      .from('zoho_configs')
      .select('id, data_center, client_id, client_secret, refresh_token')
      .eq('account_id', accountId)
      .maybeSingle()

    let clientSecretPlain: string
    if (rawSecret) {
      clientSecretPlain = rawSecret
    } else if (existing?.client_secret) {
      try {
        clientSecretPlain = decrypt(existing.client_secret)
      } catch {
        return bad('Stored client secret could not be decrypted — re-enter your credentials.')
      }
    } else {
      return bad('client_secret is required')
    }

    let refreshTokenPlain: string
    if (rawRefreshToken) {
      refreshTokenPlain = rawRefreshToken
    } else if (existing?.refresh_token) {
      try {
        refreshTokenPlain = decrypt(existing.refresh_token)
      } catch {
        return bad('Stored refresh token could not be decrypted — re-enter your credentials.')
      }
    } else {
      return bad('refresh_token is required')
    }

    // Only spend a round-trip to Zoho when the credentials that affect
    // reachability actually changed — a save that just flips the
    // "enable sync" switch skips it.
    const credentialsChanged =
      !existing ||
      rawSecret !== '' ||
      rawRefreshToken !== '' ||
      dataCenter !== existing.data_center ||
      clientId !== existing.client_id

    let lastOrgName: string | undefined
    if (credentialsChanged) {
      try {
        const { companyName } = await testConnection({
          dataCenter,
          clientId,
          clientSecret: clientSecretPlain,
          refreshToken: refreshTokenPlain,
        })
        lastOrgName = companyName
      } catch (err) {
        if (err instanceof ZohoError) {
          return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
        }
        console.error('[zoho/config POST] connection test error:', err)
        return bad('Could not verify the Zoho credentials.')
      }
    }

    const shared: Record<string, unknown> = {
      data_center: dataCenter,
      client_id: clientId,
      is_active: isActive,
    }
    if (lastOrgName !== undefined) {
      shared.last_org_name = lastOrgName
      shared.last_connected_at = new Date().toISOString()
    }
    if (rawSecret) shared.client_secret = encrypt(rawSecret)
    if (rawRefreshToken) shared.refresh_token = encrypt(rawRefreshToken)

    if (existing) {
      const { error: upErr } = await supabase
        .from('zoho_configs')
        .update(shared)
        .eq('account_id', accountId)
      if (upErr) {
        console.error('[zoho/config POST] update error:', upErr)
        return NextResponse.json({ error: 'Failed to save Zoho configuration' }, { status: 500 })
      }
    } else {
      const { error: insErr } = await supabase.from('zoho_configs').insert({
        account_id: accountId,
        created_by: userId,
        client_secret: encrypt(rawSecret),
        refresh_token: encrypt(rawRefreshToken),
        ...shared,
      })
      if (insErr) {
        console.error('[zoho/config POST] insert error:', insErr)
        return NextResponse.json({ error: 'Failed to save Zoho configuration' }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/zoho/config  (admin+)
 *
 * Removes the account's Zoho config — turns sync off and forgets the
 * credentials. Also the recovery path for a corrupted encrypted secret.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase.from('zoho_configs').delete().eq('account_id', accountId)
    if (error) {
      console.error('[zoho/config DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete Zoho configuration' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
