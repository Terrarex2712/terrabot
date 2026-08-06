// ============================================================
// Shared types for the Zoho CRM lead-conversion integration
// (bring-your-own OAuth credentials).
// ============================================================

export type ZohoDataCenter = 'com' | 'eu' | 'in' | 'com.cn' | 'com.au' | 'jp' | 'ca'

/** Decrypted, ready-to-use Zoho credentials for one account. */
export interface ZohoCredentials {
  dataCenter: ZohoDataCenter
  clientId: string
  clientSecret: string
  refreshToken: string
}

/** Typed error for every Zoho API failure mode (transport, auth, or an
 *  unexpected response shape) — NOT used for well-formed Zoho business
 *  rejections on lead create (see `CreateLeadResult`), which are an
 *  expected outcome the caller logs and skips rather than treats as a
 *  system failure. */
export class ZohoError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'ZohoError'
    this.code = opts.code ?? 'zoho_error'
    this.status = opts.status ?? 502
  }
}

export interface ZohoLeadInput {
  /** Zoho's only mandatory Leads field. */
  lastName: string
  firstName?: string
  phone?: string
  city?: string
  leadSource?: string
}

export type CreateLeadResult =
  | { ok: true; leadId: string }
  | { ok: false; code: string; message: string }

export type ZohoLeadRuleCriteriaType = 'message_text' | 'contact_city'
export type ZohoLeadRuleMatchType = 'contains' | 'exact'

export interface ZohoLeadRule {
  id: string
  accountId: string
  name: string
  criteriaType: ZohoLeadRuleCriteriaType
  matchType: ZohoLeadRuleMatchType
  caseSensitive: boolean
  keywords: string[]
  leadSource: string | null
  isActive: boolean
}

export interface ZohoConfig {
  dataCenter: ZohoDataCenter
  clientId: string
  clientSecret: string
  refreshToken: string
  isActive: boolean
}
