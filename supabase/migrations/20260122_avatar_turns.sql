-- Avatar transcript storage (separate from memory_raw / memory_summary)
-- Safe to run multiple times.

create table if not exists public.avatar_turns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid null,
  role text not null,
  content text not null,
  created_at timestamptz not null default now(),
  metadata jsonb null
);

-- Guardrails
do $$
begin
  -- role constraint (idempotent)
  if not exists (
    select 1
    from pg_constraint
    where conname = 'avatar_turns_role_check'
  ) then
    alter table public.avatar_turns
      add constraint avatar_turns_role_check
      check (role in ('user','assistant','system'));
  end if;
end $$;

-- Helpful indexes
create index if not exists avatar_turns_user_id_created_at_idx
  on public.avatar_turns (user_id, created_at desc);

create index if not exists avatar_turns_user_id_conversation_id_created_at_idx
  on public.avatar_turns (user_id, conversation_id, created_at desc);

-- RLS (client can read its own history; inserts allowed for non-service clients if ever needed)
alter table public.avatar_turns enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'avatar_turns'
      and policyname = 'avatar_turns_select_own'
  ) then
    create policy avatar_turns_select_own
      on public.avatar_turns
      for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'avatar_turns'
      and policyname = 'avatar_turns_insert_own'
  ) then
    create policy avatar_turns_insert_own
      on public.avatar_turns
      for insert
      with check (auth.uid() = user_id);
  end if;
end $$;
