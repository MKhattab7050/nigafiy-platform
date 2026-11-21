-- Remove the optional AI assistant tables per owner decision (2026-11-21).
-- The platform stays 100% deterministic, local-first, and evidence-backed with no cloud LLM dependency.
-- Migration 026 is kept untouched so existing databases that already applied it upgrade cleanly.

DROP TABLE IF EXISTS assistant_messages CASCADE;
DROP TABLE IF EXISTS assistant_conversations CASCADE;
DROP TABLE IF EXISTS assistant_usage CASCADE;
DROP TABLE IF EXISTS assistant_settings CASCADE;
