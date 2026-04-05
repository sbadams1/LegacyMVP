-- 0001_create_fact_candidates.sql

begin;

-- 1) Core table: fact candidates (raw, receipt-backed, allowed to conflict/duplicate)
create table if not exists public.fact_candidates (
  id uuid primary key default gen_random_uuid(),

  -- who/where
  user_id uuid not null,
  conversation_id uuid not null,

  -- optional: if you have a stable raw message/turn identifier, store it here
  -- keep flexible (text) to avoid coupling to a specific schema/type.
  turn_ref text null,

  -- the "guess" from extraction (may be non-canonical)
  fact_key_guess text not null,

  -- canonical key after canonicalization (nullable until you run that step)
  fact_key_canonical text null,

  -- the extracted value (raw)
  value_json jsonb not null,

  -- receipt: what exactly was said and enough metadata to trace it back
  source_quote text not null,
  source_meta jsonb not null default '{}'::jsonb,

  -- model/heuristics metadata (optional but very useful for debugging)
  confidence double precision null,
  extractor_version text null,
  model_meta jsonb not null default '{}'::jsonb,

  -- classification flags
  polarity text not null default 'stated',         -- stated | negated | hypothetical | unknown
  temporal_hint text not null default 'unknown',   -- permanent | long_term | situational | unknown

  -- lifecycle state inside candidate pipeline
  status text not null default 'captured',         -- captured | canonicalized | rejected | promoted | superseded

  extracted_at timestamptz not null default now(),

  -- basic sanity checks
  constraint fact_candidates_confidence_range
    check (confidence is null or (confidence >= 0 and confidence <= 1)),

  constraint fact_candidates_polarity_allowed
    check (polarity in ('stated','negated','hypothetical','unknown')),

  constraint fact_candidates_temporal_allowed
    check (temporal_hint in ('permanent','long_term','situational','unknown')),

  constraint fact_candidates_status_allowed
    check (status in ('captured','canonicalized','rejected','promoted','superseded'))
);

comment on table public.fact_candidates is
  'Raw, receipt-backed extracted facts. May be duplicate/conflicting. Promotion to durable memory happens elsewhere.';

comment on column public.fact_candidates.source_meta is
  'Traceability metadata (e.g., raw_id, message_index, speaker, created_at, etc.).';

-- 2) Indices for your common access patterns

-- Fast: all candidates for a conversation (most recent first)
create index if not exists fact_candidates_user_convo_time_idx
  on public.fact_candidates (user_id, conversation_id, extracted_at desc);

-- Fast: fetch by canonical key for a user (used in promotion/conflict checks)
create index if not exists fact_candidates_user_canonical_key_idx
  on public.fact_candidates (user_id, fact_key_canonical);

-- Fast: fetch by guessed key (useful before canonicalization is complete)
create index if not exists fact_candidates_user_guess_key_idx
  on public.fact_candidates (user_id, fact_key_guess);

-- Fast: lifecycle sweeps (e.g., find captured candidates not yet canonicalized)
create index if not exists fact_candidates_status_time_idx
  on public.fact_candidates (status, extracted_at desc);

-- Optional: JSON searches (only add if you actually query JSON paths often)
-- create index if not exists fact_candidates_value_gin_idx
--   on public.fact_candidates using gin (value_json);

-- 3) (Optional but recommended) Row-level security scaffolding
-- If your project uses RLS on user-owned tables, enable and add a basic policy.

alter table public.fact_candidates enable row level security;

-- Assumes you use auth.uid() as the user_id.
-- Adjust if you have a different ownership model.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'fact_candidates'
      and policyname = 'fact_candidates_select_own'
  ) then
    create policy fact_candidates_select_own
      on public.fact_candidates
      for select
      using (user_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'fact_candidates'
      and policyname = 'fact_candidates_insert_own'
  ) then
    create policy fact_candidates_insert_own
      on public.fact_candidates
      for insert
      with check (user_id = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'fact_candidates'
      and policyname = 'fact_candidates_update_own'
  ) then
    create policy fact_candidates_update_own
      on public.fact_candidates
      for update
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  end if;
end $$;

commit;
