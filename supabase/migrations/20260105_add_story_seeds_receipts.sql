alter table public.story_seeds
  add column if not exists evidence_raw_ids uuid[] not null default '{}'::uuid[];

comment on column public.story_seeds.evidence_raw_ids is
  'Receipts: memory_raw.id values used as evidence for this seed. Populated on end-session.';

create index if not exists story_seeds_evidence_raw_ids_gin
  on public.story_seeds
  using gin (evidence_raw_ids);
