-- Optional: persistent progress logging for rebuild-summaries-v2
create table if not exists public.backfill_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'running',
  cursor text null,
  batch_size integer not null default 20,
  processed integer not null default 0,
  updated integer not null default 0,
  skipped integer not null default 0,
  errors integer not null default 0,
  scope jsonb not null default '{}'::jsonb,
  last_error text null
);

create index if not exists backfill_runs_status_idx on public.backfill_runs(status);
