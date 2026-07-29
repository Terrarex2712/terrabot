-- ============================================================
-- whatsapp_config: drop NOT NULL on the legacy Meta columns
--
-- Migration 037 added the AiSensy columns without touching the
-- original NOT NULL constraints on phone_number_id / access_token.
-- That's fine for accounts migrating an existing Meta row (they
-- already have values), but it blocks the INSERT path for an account
-- connecting for the first time via AiSensy, which never populates
-- those columns at all — caught by hand while wiring up a real
-- account: "null value in column phone_number_id violates not-null
-- constraint".
--
-- Dropping NOT NULL doesn't touch existing values, only removes the
-- requirement going forward. The UNIQUE(phone_number_id) constraint
-- already tolerates multiple NULLs (Postgres never treats two NULLs
-- as equal), so no further change is needed there.
--
-- Idempotent — dropping an already-dropped NOT NULL is a no-op.
-- ============================================================

ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL,
  ALTER COLUMN access_token DROP NOT NULL;
