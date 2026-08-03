-- ============================================================
-- 041_raise_ai_reply_cap.sql — raise the auto-reply per-conversation
-- ceiling from 20 to 100000.
--
-- Still a hard ceiling (not true "unlimited") so a runaway loop /
-- bad config can't send without bound, but 100000 is high enough
-- that no real workspace will hit it. See 029_ai_reply.sql for the
-- original cap and its rationale.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_auto_reply_max_per_conversation_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_auto_reply_max_per_conversation_check
    CHECK (auto_reply_max_per_conversation BETWEEN 1 AND 100000);
