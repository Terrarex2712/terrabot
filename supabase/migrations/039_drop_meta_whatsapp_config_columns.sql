-- ============================================================
-- whatsapp_config: drop the Meta-only columns
--
-- The WhatsApp integration is now AiSensy-only (project_id/api_key/
-- webhook_shared_secret, added in 037/038) — nothing in the app reads
-- or writes phone_number_id, waba_id, access_token, verify_token,
-- registered_at, subscribed_apps_at, or last_registration_error
-- anymore. Dropping phone_number_id also drops its UNIQUE constraint
-- (whatsapp_config_phone_number_id_key) — Postgres cascades that
-- automatically since the constraint is defined on this column alone.
--
-- This is the last step of the Meta→AiSensy migration (037 added the
-- new columns additively so nothing broke mid-migration; 038 made the
-- legacy columns nullable so new AiSensy-only accounts could insert;
-- this migration finally removes them now that every code path reads
-- project_id/api_key instead).
--
-- Idempotent — DROP COLUMN IF EXISTS is safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  DROP COLUMN IF EXISTS phone_number_id,
  DROP COLUMN IF EXISTS waba_id,
  DROP COLUMN IF EXISTS access_token,
  DROP COLUMN IF EXISTS verify_token,
  DROP COLUMN IF EXISTS registered_at,
  DROP COLUMN IF EXISTS subscribed_apps_at,
  DROP COLUMN IF EXISTS last_registration_error;
