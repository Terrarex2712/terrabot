-- ============================================================
-- whatsapp_config: drop webhook_shared_secret
--
-- AiSensy doesn't expose a per-webhook signing secret at the "App
-- Password" credential tier we have access to — confirmed
-- exhaustively (dashboard UI, live-captured Network tab, the read
-- API, the create API, and testing whether the Project API key
-- itself was the HMAC key against real captured deliveries). The
-- webhook route no longer verifies signatures at all, so this column
-- (added in 037, never populated with anything usable) is dead.
--
-- Idempotent — DROP COLUMN IF EXISTS is safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  DROP COLUMN IF EXISTS webhook_shared_secret;
