import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { refreshAccessToken, testConnection, createLead, addLeadTag } from './client'
import { ZohoError } from './types'
import type { ZohoCredentials } from './types'

const CREDS: ZohoCredentials = {
  dataCenter: 'in',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  refreshToken: 'refresh-1',
}

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return { ok: false, status, json: async () => json } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('refreshAccessToken', () => {
  it('posts to the data-center-specific accounts domain with the right params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ access_token: 'tok', api_domain: 'https://www.zohoapis.in', expires_in: 3600 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await refreshAccessToken(CREDS)

    expect(res).toEqual({ accessToken: 'tok', apiDomain: 'https://www.zohoapis.in' })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('https://accounts.zoho.in/oauth/v2/token')
    expect(url).toContain('grant_type=refresh_token')
    expect(url).toContain('refresh_token=refresh-1')
    expect(opts.method).toBe('POST')
  })

  it('throws a ZohoError on a non-200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errResponse(400, { error: 'invalid_code' })),
    )
    await expect(refreshAccessToken(CREDS)).rejects.toBeInstanceOf(ZohoError)
  })

  it('throws a ZohoError on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    await expect(refreshAccessToken(CREDS)).rejects.toBeInstanceOf(ZohoError)
  })
})

describe('testConnection', () => {
  it('refreshes then reads the org company_name', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({ access_token: 'tok', api_domain: 'https://www.zohoapis.in' }),
      )
      .mockResolvedValueOnce(okResponse({ org: [{ company_name: 'Acme India' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await testConnection(CREDS)

    expect(res).toEqual({ companyName: 'Acme India' })
    const [orgUrl, orgOpts] = fetchMock.mock.calls[1]
    expect(orgUrl).toBe('https://www.zohoapis.in/crm/v8/org')
    expect(orgOpts.headers.Authorization).toBe('Zoho-oauthtoken tok')
  })

  it('throws when the org response has no company_name', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          okResponse({ access_token: 'tok', api_domain: 'https://www.zohoapis.in' }),
        )
        .mockResolvedValueOnce(okResponse({ org: [] })),
    )
    await expect(testConnection(CREDS)).rejects.toBeInstanceOf(ZohoError)
  })
})

describe('createLead', () => {
  it('posts the mapped lead fields and returns the new lead id on success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({ access_token: 'tok', api_domain: 'https://www.zohoapis.in' }),
      )
      .mockResolvedValueOnce(
        okResponse({
          data: [{ status: 'success', code: 'SUCCESS', details: { id: 'lead-123' } }],
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await createLead(CREDS, { lastName: 'Sharma', phone: '+919999999999', city: 'Jaunpur' })

    expect(res).toEqual({ ok: true, leadId: 'lead-123' })
    const [leadUrl, leadOpts] = fetchMock.mock.calls[1]
    expect(leadUrl).toBe('https://www.zohoapis.in/crm/v8/Leads')
    const body = JSON.parse(leadOpts.body)
    expect(body.data[0]).toMatchObject({ Last_Name: 'Sharma', Phone: '+919999999999', City: 'Jaunpur' })
  })

  it('returns ok:false (not a throw) on a well-formed Zoho rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          okResponse({ access_token: 'tok', api_domain: 'https://www.zohoapis.in' }),
        )
        .mockResolvedValueOnce(
          okResponse({
            data: [{ status: 'error', code: 'DUPLICATE_DATA', message: 'duplicate data' }],
          }),
        ),
    )

    const res = await createLead(CREDS, { lastName: 'Sharma' })
    expect(res).toEqual({ ok: false, code: 'DUPLICATE_DATA', message: 'duplicate data' })
  })

  it('throws a ZohoError on a transport failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          okResponse({ access_token: 'tok', api_domain: 'https://www.zohoapis.in' }),
        )
        .mockRejectedValueOnce(new Error('ECONNRESET')),
    )
    await expect(createLead(CREDS, { lastName: 'Sharma' })).rejects.toBeInstanceOf(ZohoError)
  })
})

describe('addLeadTag', () => {
  it('posts the tag name to the add_tags action for the lead', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({ access_token: 'tok', api_domain: 'https://www.zohoapis.in' }),
      )
      .mockResolvedValueOnce(okResponse({ data: [{ status: 'success', code: 'SUCCESS' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await addLeadTag(CREDS, 'lead-123', 'Whatsapp')

    const [tagUrl, tagOpts] = fetchMock.mock.calls[1]
    expect(tagUrl).toBe('https://www.zohoapis.in/crm/v8/Leads/lead-123/actions/add_tags')
    expect(JSON.parse(tagOpts.body)).toEqual({ tags: [{ name: 'Whatsapp' }] })
  })

  it('throws a ZohoError when Zoho rejects the tag request', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          okResponse({ access_token: 'tok', api_domain: 'https://www.zohoapis.in' }),
        )
        .mockResolvedValueOnce(errResponse(400, { data: [{ code: 'INVALID_DATA' }] })),
    )
    await expect(addLeadTag(CREDS, 'lead-123', 'Whatsapp')).rejects.toBeInstanceOf(ZohoError)
  })
})
