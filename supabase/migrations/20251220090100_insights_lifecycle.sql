-- 1) Status enum (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'insight_status') THEN
    CREATE TYPE insight_status AS ENUM ('emerging', 'active', 'cooling', 'archived');
  END IF;
END$$;

-- 2) Add lifecycle columns to memory_insights (idempotent)
ALTER TABLE public.memory_insights
  ADD COLUMN IF NOT EXISTS insight_key text,
  ADD COLUMN IF NOT EXISTS originating_seed_keys jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS evidence_raw_ids jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS supporting_sessions integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS context_domains jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS confidence_score double precision DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS status insight_status DEFAULT 'emerging',
  ADD COLUMN IF NOT EXISTS first_detected_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_reinforced_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_presented_at timestamptz,
  ADD COLUMN IF NOT EXISTS contradiction_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- 3) Make insight_key required going forward (optional; do later when backfilled)
-- ALTER TABLE public.memory_insights ALTER COLUMN insight_key SET NOT NULL;

-- 4) Helpful uniqueness: one living row per user per insight_key
-- If you already have duplicates, run a cleanup/backfill first.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='uniq_memory_insights_user_key'
  ) THEN
    CREATE UNIQUE INDEX uniq_memory_insights_user_key
      ON public.memory_insights (user_id, insight_key);
  END IF;
END$$;

-- 5) Query performance: show "active" / "cooling" insights quickly
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_memory_insights_user_status'
  ) THEN
    CREATE INDEX idx_memory_insights_user_status
      ON public.memory_insights (user_id, status);
  END IF;
END$$;

-- 6) Optional: extend story_seeds so your pipeline can support the rules cleanly
ALTER TABLE public.story_seeds
  ADD COLUMN IF NOT EXISTS seed_key text,
  ADD COLUMN IF NOT EXISTS seed_label text,
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS occurrence_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS context_domains jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS source_raw_ids jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS confidence_score double precision DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS promotion_blocked boolean DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_story_seeds_user_last_seen'
  ) THEN
    CREATE INDEX idx_story_seeds_user_last_seen
      ON public.story_seeds (user_id, last_seen_at);
  END IF;
END$$;
