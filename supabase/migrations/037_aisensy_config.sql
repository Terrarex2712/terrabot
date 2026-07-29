-- ============================================================
-- whatsapp_config: add AiSensy credential columns
--
-- Additive only — the Meta columns (phone_number_id, waba_id,
-- access_token, verify_token, registered_at, subscribed_apps_at,
-- last_registration_error) are left in place for now so every route
-- that hasn't been migrated to AiSensy yet keeps working. They're
-- dropped in a later migration once the whole WhatsApp integration
-- (settings UI, send path, webhook, templates) has moved over.
--
-- `api_key` and `webhook_shared_secret` are encrypted at rest with
-- the same encrypt()/decrypt() helpers already used for
-- whatsapp_config.access_token (src/lib/whatsapp/encryption.ts).
--
-- Nullable: existing rows (Meta-configured accounts) have none of
-- these until the account owner reconnects via the new settings UI.
--
-- project_id is UNIQUE for the same reason phone_number_id was
-- (migration 013): the webhook route resolves the owning account by
-- looking up a single config row for whatever identifier is in the
-- inbound payload — two accounts sharing one AiSensy project would
-- make that lookup ambiguous and silently drop messages.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS project_id TEXT,
  ADD COLUMN IF NOT EXISTS api_key TEXT,
  ADD COLUMN IF NOT EXISTS webhook_shared_secret TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_project_id_key'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_project_id_key UNIQUE (project_id);
  END IF;
END $$;
