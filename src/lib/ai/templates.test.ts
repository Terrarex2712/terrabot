import { describe, it, expect } from 'vitest'
import {
  loadAiTemplateSpecs,
  buildTemplateTool,
  buildTemplateToolValidator,
  SEND_TEMPLATE_TOOL_NAME,
  type AiTemplateSpec,
} from './templates'

// Minimal fake of the Supabase query-builder chain this module uses:
// .from(table).select(cols).eq(...).eq(...).in(...) → { data, error }.
function fakeDb(rows: unknown[] | null, error: unknown = null) {
  const calls: { method: string; args: unknown[] }[] = []
  const chain = {
    select: (...a: unknown[]) => {
      calls.push({ method: 'select', args: a })
      return chain
    },
    eq: (...a: unknown[]) => {
      calls.push({ method: 'eq', args: a })
      return chain
    },
    in: (...a: unknown[]) => {
      calls.push({ method: 'in', args: a })
      return Promise.resolve({ data: rows, error })
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = {
    from: (table: string) => {
      calls.push({ method: 'from', args: [table] })
      return chain
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return { db, calls }
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    name: 'order_status',
    language: 'en_US',
    category: 'Utility',
    body_text: 'Your order is on its way.',
    header_type: null,
    header_content: null,
    buttons: null,
    ...overrides,
  }
}

describe('loadAiTemplateSpecs', () => {
  it('scopes the query to the account, APPROVED status, and eligible categories', async () => {
    const { db, calls } = fakeDb([])
    await loadAiTemplateSpecs(db, 'acct-1')
    expect(calls).toContainEqual({ method: 'from', args: ['message_templates'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['account_id', 'acct-1'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['status', 'APPROVED'] })
    expect(calls).toContainEqual({ method: 'in', args: ['category', ['Utility', 'Authentication']] })
  })

  it('returns [] on a DB error rather than throwing', async () => {
    const { db } = fakeDb(null, { message: 'boom' })
    await expect(loadAiTemplateSpecs(db, 'acct-1')).resolves.toEqual([])
  })

  it('computes requiredBodyVars and headerRequiresText', async () => {
    const { db } = fakeDb([
      row({
        body_text: 'Hi {{1}}, your order {{2}} shipped.',
        header_type: 'text',
        header_content: 'Order update for {{1}}',
      }),
    ])
    const [spec] = await loadAiTemplateSpecs(db, 'acct-1')
    expect(spec.requiredBodyVars).toBe(2)
    expect(spec.headerRequiresText).toBe(true)
  })

  it('does not require header text for a static (non-variable) text header', async () => {
    const { db } = fakeDb([
      row({ header_type: 'text', header_content: 'Order Update' }),
    ])
    const [spec] = await loadAiTemplateSpecs(db, 'acct-1')
    expect(spec.headerRequiresText).toBe(false)
  })

  it('excludes a template with a variable URL button', async () => {
    const { db } = fakeDb([
      row({ name: 'has_variable_link', buttons: [{ type: 'URL', text: 'Track', url: 'https://x.test/track/{{1}}' }] }),
      row({ name: 'static_link', buttons: [{ type: 'URL', text: 'Visit', url: 'https://x.test/about' }] }),
    ])
    const specs = await loadAiTemplateSpecs(db, 'acct-1')
    expect(specs.map((s) => s.name)).toEqual(['static_link'])
  })

  it('defaults language to en_US when the row has none', async () => {
    const { db } = fakeDb([row({ language: null })])
    const [spec] = await loadAiTemplateSpecs(db, 'acct-1')
    expect(spec.language).toBe('en_US')
  })
})

function spec(overrides: Partial<AiTemplateSpec> = {}): AiTemplateSpec {
  return {
    name: 'order_status',
    language: 'en_US',
    category: 'Utility',
    bodyText: 'Hi {{1}}, your order {{2}} shipped.',
    requiredBodyVars: 2,
    headerRequiresText: false,
    ...overrides,
  }
}

describe('buildTemplateTool', () => {
  it('names the tool and embeds the catalog with requirements', () => {
    const tool = buildTemplateTool([spec(), spec({ name: 'welcome', requiredBodyVars: 0, bodyText: 'Welcome!' })])
    expect(tool.name).toBe(SEND_TEMPLATE_TOOL_NAME)
    expect(tool.description).toContain('order_status')
    expect(tool.description).toContain('body_params: 2 value(s)')
    expect(tool.description).toContain('welcome')
    expect(tool.inputSchema).toMatchObject({ required: ['template_name'] })
  })
})

describe('buildTemplateToolValidator', () => {
  const validate = buildTemplateToolValidator([spec(), spec({ name: 'with_header', headerRequiresText: true, requiredBodyVars: 0 })])

  it('rejects a call to the wrong tool name', () => {
    expect(validate('some_other_tool', { template_name: 'order_status' })).toEqual({
      ok: false,
      error: expect.stringContaining('Unknown tool'),
    })
  })

  it('rejects a missing template_name', () => {
    expect(validate(SEND_TEMPLATE_TOOL_NAME, {})).toMatchObject({ ok: false })
  })

  it('rejects an unknown template', () => {
    expect(validate(SEND_TEMPLATE_TOOL_NAME, { template_name: 'does_not_exist' })).toMatchObject({
      ok: false,
    })
  })

  it('rejects too few body_params', () => {
    expect(
      validate(SEND_TEMPLATE_TOOL_NAME, { template_name: 'order_status', body_params: ['only-one'] }),
    ).toMatchObject({ ok: false })
  })

  it('rejects non-string body_params', () => {
    expect(
      validate(SEND_TEMPLATE_TOOL_NAME, { template_name: 'order_status', body_params: ['a', 2] }),
    ).toMatchObject({ ok: false })
  })

  it('rejects a missing header_text when the template requires one', () => {
    expect(validate(SEND_TEMPLATE_TOOL_NAME, { template_name: 'with_header' })).toMatchObject({
      ok: false,
    })
  })

  it('accepts a fully valid call', () => {
    expect(
      validate(SEND_TEMPLATE_TOOL_NAME, {
        template_name: 'order_status',
        body_params: ['Sam', '#123'],
      }),
    ).toEqual({ ok: true })
  })

  it('accepts a valid call with header_text supplied when required', () => {
    expect(
      validate(SEND_TEMPLATE_TOOL_NAME, { template_name: 'with_header', header_text: 'Hi Sam' }),
    ).toEqual({ ok: true })
  })
})
