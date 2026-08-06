import type { ZohoLeadRuleCriteriaType, ZohoLeadRuleMatchType } from './types'

const CRITERIA_TYPES: ZohoLeadRuleCriteriaType[] = ['message_text', 'contact_city']
const MATCH_TYPES: ZohoLeadRuleMatchType[] = ['contains', 'exact']

export type ParsedRule = {
  name: string
  criteria_type: ZohoLeadRuleCriteriaType
  match_type: ZohoLeadRuleMatchType
  case_sensitive: boolean
  keywords: string[]
  lead_source: string | null
  is_active: boolean
}

/** Shared body validation for creating/updating a `zoho_lead_rules` row
 *  — used by both `/api/zoho/rules` (POST) and `/api/zoho/rules/[id]`
 *  (PATCH). Returns `{ error }` on a bad field, else `{ row }`. */
export function parseRuleBody(
  body: Record<string, unknown>,
): { error: string } | { row: ParsedRule } {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return { error: 'name is required' }

  const criteriaType = body.criteria_type as ZohoLeadRuleCriteriaType
  if (!CRITERIA_TYPES.includes(criteriaType)) {
    return { error: `criteria_type must be one of: ${CRITERIA_TYPES.join(', ')}` }
  }

  const matchType = (body.match_type ?? 'contains') as ZohoLeadRuleMatchType
  if (!MATCH_TYPES.includes(matchType)) {
    return { error: `match_type must be one of: ${MATCH_TYPES.join(', ')}` }
  }

  const keywords = Array.isArray(body.keywords)
    ? body.keywords
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.trim())
        .filter(Boolean)
    : []
  if (keywords.length === 0) return { error: 'keywords must be a non-empty list' }

  const leadSource =
    typeof body.lead_source === 'string' && body.lead_source.trim()
      ? body.lead_source.trim()
      : null
  const caseSensitive = body.case_sensitive === true
  const isActive = body.is_active !== false

  return {
    row: {
      name,
      criteria_type: criteriaType,
      match_type: matchType,
      case_sensitive: caseSensitive,
      keywords,
      lead_source: leadSource,
      is_active: isActive,
    },
  }
}
