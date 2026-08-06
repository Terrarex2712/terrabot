-- ============================================================
-- 042_zoho_lead_sync.sql — manual, criteria-based Contact → Zoho CRM
-- Lead sync (bring-your-own Zoho credentials).
--
-- Design notes
--   - `zoho_configs` is account-scoped and UNIQUE(account_id), same
--     shape family as `ai_configs` (029_ai_reply.sql): BYO OAuth
--     credentials, AES-256-GCM-encrypted at rest via the same
--     `encrypt()`/`decrypt()` helper already used for the AI provider
--     key and the AiSensy WhatsApp token. `client_id` isn't secret per
--     Zoho's own model, so it's stored plain; `client_secret` and
--     `refresh_token` are encrypted.
--   - `data_center` picks the Zoho accounts/API host family
--     (accounts.zoho.{dc} / www.zohoapis.{dc}) — credentials generated
--     on one Zoho data center only work against that DC's hosts.
--   - `is_active` is the master switch for the sync (mirrors
--     `ai_configs.is_active`). `last_org_name`/`last_connected_at` cache
--     the last successful "Test connection" result for the settings UI.
--   - `zoho_lead_rules` holds the account's own, manually authored
--     match rules (many per account). Rules are OR'd together by the
--     dispatch engine — any one active match converts the contact.
--   - `contacts.zoho_lead_id` doubles as both the Zoho record reference
--     AND the "already converted" flag (non-null = already synced) —
--     no separate boolean needed. `contacts.city` is added for the
--     `contact_city` rule type; nothing currently populates it (no
--     capture pipeline exists yet), so those rules won't match until a
--     future feature fills it in — that's an accepted, documented gap,
--     not a bug.
--
-- RLS
--   Settings-class, mirroring `ai_configs`: any member (viewer+) may
--   read; only admin+ may create/update/delete. The sync dispatch runs
--   under the service-role client (triggered from the webhook, which has
--   no auth.uid()), so these policies guard dashboard access only.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS zoho_lead_id text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS zoho_lead_synced_at timestamptz;

-- ============================================================
-- BYO Zoho CRM credentials, one row per account.
-- ============================================================
CREATE TABLE IF NOT EXISTS zoho_configs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  data_center        text NOT NULL DEFAULT 'in'
                        CHECK (data_center IN ('com', 'eu', 'in', 'com.cn', 'com.au', 'jp', 'ca')),
  client_id          text NOT NULL,
  client_secret      text NOT NULL,   -- AES-256-GCM-encrypted
  refresh_token      text NOT NULL,   -- AES-256-GCM-encrypted
  is_active          boolean NOT NULL DEFAULT false,
  last_org_name      text,
  last_connected_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE zoho_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS zoho_configs_select ON zoho_configs;
CREATE POLICY zoho_configs_select ON zoho_configs FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS zoho_configs_insert ON zoho_configs;
CREATE POLICY zoho_configs_insert ON zoho_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS zoho_configs_update ON zoho_configs;
CREATE POLICY zoho_configs_update ON zoho_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS zoho_configs_delete ON zoho_configs;
CREATE POLICY zoho_configs_delete ON zoho_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_zoho_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zoho_configs_updated_at ON zoho_configs;
CREATE TRIGGER zoho_configs_updated_at
  BEFORE UPDATE ON zoho_configs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_zoho_configs_updated_at();

-- ============================================================
-- User-defined lead-conversion rules, many per account.
-- ============================================================
CREATE TABLE IF NOT EXISTS zoho_lead_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name            text NOT NULL,
  criteria_type   text NOT NULL CHECK (criteria_type IN ('message_text', 'contact_city')),
  match_type      text NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains', 'exact')),
  case_sensitive  boolean NOT NULL DEFAULT false,
  keywords        text[] NOT NULL DEFAULT '{}',
  lead_source     text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_zoho_lead_rules_account
  ON zoho_lead_rules (account_id);

ALTER TABLE zoho_lead_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS zoho_lead_rules_select ON zoho_lead_rules;
CREATE POLICY zoho_lead_rules_select ON zoho_lead_rules FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS zoho_lead_rules_insert ON zoho_lead_rules;
CREATE POLICY zoho_lead_rules_insert ON zoho_lead_rules FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS zoho_lead_rules_update ON zoho_lead_rules;
CREATE POLICY zoho_lead_rules_update ON zoho_lead_rules FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS zoho_lead_rules_delete ON zoho_lead_rules;
CREATE POLICY zoho_lead_rules_delete ON zoho_lead_rules FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_zoho_lead_rules_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zoho_lead_rules_updated_at ON zoho_lead_rules;
CREATE TRIGGER zoho_lead_rules_updated_at
  BEFORE UPDATE ON zoho_lead_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.update_zoho_lead_rules_updated_at();
