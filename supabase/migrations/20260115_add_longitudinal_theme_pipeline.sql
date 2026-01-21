-- 20260115_add_longitudinal_theme_pipeline.sql
-- Cached theme extraction + durable clustering tables (no bloat in memory_summary)

create table if not exists public.summary_themes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  summary_id uuid not null references public.memory_summary(id) on delete cascade,
  summary_fingerprint text not null,
  extractor_version text not null default 'v1',
  themes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, summary_id, extractor_version)
);

create index if not exists idx_summary_themes_user_summary
  on public.summary_themes(user_id, summary_id);

create index if not exists idx_summary_themes_user_updated
  on public.summary_themes(user_id, updated_at desc);

create table if not exists public.theme_clusters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cluster_label text not null,
  cluster_vector jsonb null,
  domains text[] not null default '{}'::text[],
  strength double precision not null default 0,
  occurrence_count int not null default 0,
  first_seen_at timestamptz null,
  last_seen_at timestamptz null,
  cluster_version text not null default 'v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_theme_clusters_user_strength
  on public.theme_clusters(user_id, strength desc);

create index if not exists idx_theme_clusters_user_last_seen
  on public.theme_clusters(user_id, last_seen_at desc);

create table if not exists public.cluster_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cluster_id uuid not null references public.theme_clusters(id) on delete cascade,
  summary_theme_id uuid not null references public.summary_themes(id) on delete cascade,
  theme_index int not null,
  theme_label text not null,
  weight double precision not null default 0.0,
  receipts jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique(cluster_id, summary_theme_id, theme_index)
);

create index if not exists idx_cluster_members_user_cluster
  on public.cluster_members(user_id, cluster_id);

create index if not exists idx_cluster_members_user_created
  on public.cluster_members(user_id, created_at desc);

-- Optional: fast receipt linking from insights to summaries
create table if not exists public.insight_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  insight_id uuid not null references public.memory_insights(id) on delete cascade,
  summary_id uuid not null references public.memory_summary(id) on delete cascade,
  cluster_id uuid null references public.theme_clusters(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(insight_id, summary_id)
);

create index if not exists idx_insight_sources_user_insight
  on public.insight_sources(user_id, insight_id);
