-- Ensure the unique constraint exists (required for ON CONFLICT upsert)
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'story_recall_user_seed_unique'
  ) then
    alter table public.story_recall
      add constraint story_recall_user_seed_unique unique (user_id, story_seed_id);
  end if;
end $$;

-- (Optional but recommended) same pattern for derived_views if you upsert there too
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'derived_views_user_key_unique'
  ) then
    alter table public.derived_views
      add constraint derived_views_user_key_unique unique (user_id, view_key);
  end if;
end $$;

-- If you use RLS in this project, add policies. If you do not use RLS, skip this whole block.
alter table public.story_recall enable row level security;

drop policy if exists story_recall_select_own on public.story_recall;
create policy story_recall_select_own
on public.story_recall
for select
using (auth.uid() = user_id);

drop policy if exists story_recall_insert_own on public.story_recall;
create policy story_recall_insert_own
on public.story_recall
for insert
with check (auth.uid() = user_id);

drop policy if exists story_recall_update_own on public.story_recall;
create policy story_recall_update_own
on public.story_recall
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists story_recall_delete_own on public.story_recall;
create policy story_recall_delete_own
on public.story_recall
for delete
using (auth.uid() = user_id);
