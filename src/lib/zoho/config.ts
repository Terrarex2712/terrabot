import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { ZohoConfig, ZohoDataCenter } from './types'

interface ZohoConfigRow {
  data_center: ZohoDataCenter
  client_id: string
  client_secret: string
  refresh_token: string
  is_active: boolean
}

const CONFIG_COLUMNS = 'data_center, client_id, client_secret, refresh_token, is_active'

/**
 * Load and decrypt the account's Zoho config for *use* (the lead-convert
 * dispatcher, or a "Test connection" call). Returns `null` when there's
 * no row or (when `requireActive`) the master switch is off — both mean
 * "sync is not available", which callers treat identically. Mirrors
 * `src/lib/ai/config.ts`'s `loadAiConfig`.
 */
export async function loadZohoConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<ZohoConfig | null> {
  const { requireActive = true } = opts
  const { data, error } = await db
    .from('zoho_configs')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as ZohoConfigRow
  if (requireActive && !row.is_active) return null

  return {
    dataCenter: row.data_center,
    clientId: row.client_id,
    clientSecret: decrypt(row.client_secret),
    refreshToken: decrypt(row.refresh_token),
    isActive: row.is_active,
  }
}
