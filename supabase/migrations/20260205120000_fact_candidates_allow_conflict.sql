-- Allow VIP-lane conflict statuses in fact_candidates.status
-- Existing constraint list (as of 2026-02) omits 'conflict' / 'locked_conflict'
-- which are written by the VIP lane in turn_core.ts.

ALTER TABLE public.fact_candidates
  DROP CONSTRAINT IF EXISTS fact_candidates_status_allowed;

ALTER TABLE public.fact_candidates
  ADD CONSTRAINT fact_candidates_status_allowed
  CHECK (
    status = ANY (
      ARRAY[
        'captured'::text,
        'canonicalized'::text,
        'rejected'::text,
        'promoted'::text,
        'superseded'::text,
        'conflict'::text,
        'locked_conflict'::text
      ]
    )
  );