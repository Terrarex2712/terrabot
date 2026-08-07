import { ZohoError, type ZohoCredentials, type ZohoLeadInput, type CreateLeadResult } from './types'

/**
 * Thin Zoho CRM API v8 client. No token caching — call frequency is low
 * (a "Test connection" click, and one lead create per matching inbound),
 * so refreshing an access token on every call is cheap and avoids the
 * complexity of a cache with its own expiry/invalidation bugs.
 */

function accountsDomain(creds: ZohoCredentials): string {
  return `https://accounts.zoho.${creds.dataCenter}`
}

interface RefreshTokenResponse {
  access_token?: string
  api_domain?: string
  error?: string
}

/**
 * Exchange the stored refresh token for a fresh (~1hr) access token.
 * `api_domain` is read from the response every time rather than derived
 * from `dataCenter` — Zoho's accounts host (`accounts.zoho.in`) and API
 * host (`www.zohoapis.in`) are documented as two different hosts, and
 * the token response is the authoritative source for the latter.
 */
export async function refreshAccessToken(
  creds: ZohoCredentials,
): Promise<{ accessToken: string; apiDomain: string }> {
  const url = new URL('/oauth/v2/token', accountsDomain(creds))
  url.searchParams.set('refresh_token', creds.refreshToken)
  url.searchParams.set('client_id', creds.clientId)
  url.searchParams.set('client_secret', creds.clientSecret)
  url.searchParams.set('grant_type', 'refresh_token')

  let res: Response
  try {
    res = await fetch(url.toString(), { method: 'POST' })
  } catch {
    throw new ZohoError('Could not reach Zoho to refresh the access token.', {
      code: 'network',
    })
  }

  const body = (await res.json().catch(() => null)) as RefreshTokenResponse | null
  if (!res.ok || !body?.access_token || !body?.api_domain) {
    throw new ZohoError(
      body?.error ?? `Zoho token refresh failed with status ${res.status}.`,
      { code: body?.error ?? 'invalid_grant', status: res.status },
    )
  }

  return { accessToken: body.access_token, apiDomain: body.api_domain }
}

interface OrgResponse {
  org?: { company_name?: string }[]
  // Present instead of `org` when Zoho rejects the request outright
  // (e.g. a missing scope) rather than returning an empty org list.
  code?: string
  message?: string
}

/** "Test connection" — refreshes a token, then confirms it works by
 *  reading the org's display name (also what the settings UI shows as
 *  "Connected as ..."). Requires the `ZohoCRM.org.READ` scope. */
export async function testConnection(
  creds: ZohoCredentials,
): Promise<{ companyName: string }> {
  const { accessToken, apiDomain } = await refreshAccessToken(creds)

  let res: Response
  try {
    res = await fetch(`${apiDomain}/crm/v8/org`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    })
  } catch {
    throw new ZohoError('Could not reach Zoho to verify the connection.', {
      code: 'network',
    })
  }

  const body = (await res.json().catch(() => null)) as OrgResponse | null
  const companyName = body?.org?.[0]?.company_name
  if (!res.ok || !companyName) {
    // Surface Zoho's own explanation when it gave one (e.g.
    // OAUTH_SCOPE_MISMATCH when the refresh token wasn't granted
    // `ZohoCRM.org.READ`) instead of just a bare HTTP status.
    const detail = body?.message ? ` — ${body.message} (${body.code})` : ''
    throw new ZohoError(
      `Zoho rejected the connection test (status ${res.status})${detail}.`,
      { code: body?.code ?? 'unexpected_response', status: res.status },
    )
  }

  return { companyName }
}

interface InsertRecordsResponse {
  data?: {
    status?: 'success' | 'error'
    code?: string
    message?: string
    details?: { id?: string }
  }[]
}

/**
 * Create one Lead. A well-formed Zoho rejection (duplicate, missing
 * mandatory field, etc.) comes back as `{ ok: false }` — it's an
 * expected business outcome the caller logs and skips, not a thrown
 * error. `ZohoError` is reserved for transport/auth failures and
 * responses too malformed to interpret. Requires the
 * `ZohoCRM.modules.leads.CREATE` scope.
 */
export async function createLead(
  creds: ZohoCredentials,
  input: ZohoLeadInput,
): Promise<CreateLeadResult> {
  const { accessToken, apiDomain } = await refreshAccessToken(creds)

  const record: Record<string, string> = { Last_Name: input.lastName }
  if (input.firstName) record.First_Name = input.firstName
  // Sent as both — which one is the module's actual visible phone field
  // varies by org layout (this account's Leads layout uses Mobile, not
  // the standard Phone field); Zoho ignores whichever isn't part of
  // the module's fields rather than erroring.
  if (input.phone) {
    record.Mobile = input.phone
    record.Phone = input.phone
  }
  if (input.city) record.City = input.city
  if (input.leadSource) record.Lead_Source = input.leadSource

  let res: Response
  try {
    res = await fetch(`${apiDomain}/crm/v8/Leads`, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: [record] }),
    })
  } catch {
    throw new ZohoError('Could not reach Zoho to create the lead.', {
      code: 'network',
    })
  }

  const body = (await res.json().catch(() => null)) as InsertRecordsResponse | null
  const entry = body?.data?.[0]
  if (!entry) {
    throw new ZohoError(
      `Zoho returned an unexpected response creating the lead (status ${res.status}).`,
      { code: 'unexpected_response', status: res.status },
    )
  }

  if (entry.status === 'success' && entry.details?.id) {
    return { ok: true, leadId: entry.details.id }
  }
  return {
    ok: false,
    code: entry.code ?? 'unknown_error',
    message: entry.message ?? 'Zoho rejected the lead.',
  }
}

/**
 * Tag a Lead by tag name (matched against an existing tag in the
 * module — Zoho's `add_tags` action prioritizes `id` over `name` but
 * accepts a bare name, which resolves to the module's existing tag of
 * that name rather than creating a new one). Best-effort from the
 * caller's perspective: throws `ZohoError` on failure so
 * `lead-convert.ts` can log and continue rather than let a tagging
 * hiccup undo an already-successful lead creation.
 */
export async function addLeadTag(
  creds: ZohoCredentials,
  leadId: string,
  tagName: string,
): Promise<void> {
  const { accessToken, apiDomain } = await refreshAccessToken(creds)

  let res: Response
  try {
    res = await fetch(`${apiDomain}/crm/v8/Leads/${leadId}/actions/add_tags`, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tags: [{ name: tagName }] }),
    })
  } catch {
    throw new ZohoError('Could not reach Zoho to tag the lead.', { code: 'network' })
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as InsertRecordsResponse | null
    const entry = body?.data?.[0]
    throw new ZohoError(
      `Zoho rejected tagging the lead (status ${res.status}).`,
      { code: entry?.code ?? 'unexpected_response', status: res.status },
    )
  }
}
