import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for the Zoho lead-conversion dispatch
// path. Mirrors src/lib/ai/admin-client.ts — the inbound webhook has no
// `auth.uid()`, so the dispatcher reads config/rules/contact state and
// writes back through the service role.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
