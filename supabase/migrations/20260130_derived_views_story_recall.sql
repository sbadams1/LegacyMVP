-- 2026-01-30: derived_views + story_recall (retrieval surfaces)
-- NOTE: This is intentionally minimal. Add RLS policies consistent with your project conventions.

create table if not exists public.derived_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  view_key text not null,
  label text not null default '',
  summary text not null default '',
  status text not null default 'inferred',
  confidence real not null default 0.5,
  scope_json jsonb not null default '{}'::jsonb,
  stance_json jsonb not null default '{}'::jsonb,
  evidence_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, view_key)
);

create index if not exists derived_views_user_id_idx on public.derived_views (user_id);
create index if not exists derived_views_view_key_idx on public.derived_views (view_key);

create table if not exists public.story_recall (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  story_seed_id uuid not null,
  title text not null default '',
  synopsis text not null default '',
  keywords text[] not null default '{}'::text[],
  evidence_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, story_seed_id)
);

create index if not exists story_recall_user_id_idx on public.story_recall (user_id);
create index if not exists story_recall_title_idx on public.story_recall (title);
