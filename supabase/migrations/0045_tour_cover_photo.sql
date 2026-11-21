-- One cover photo per tour (not a gallery — venues already have that via
-- venue_photos/0026) so Tour List can show a real photo behind the tour
-- name instead of a flat card. No new RLS needed on `tours` itself —
-- "tours updatable by managers" (0001_init.sql) already covers writing
-- this column, and it's already in the completion-lock trigger's table
-- list (0005_tour_completion_lock.sql).
alter table tours
  add column cover_photo_path text;

-- Storage: path convention <tour_id>/<photo_id>-<filename>, same style as
-- venue-photos (0026) — the first path segment is the tour_id, checked
-- directly. Readable by any tour member (crew included — this is just
-- visual flair, not sensitive data); writable/deletable by managers only.
insert into storage.buckets (id, name, public)
values ('tour-covers', 'tour-covers', false)
on conflict (id) do nothing;

create policy "tour covers readable by tour members" on storage.objects
  for select using (
    bucket_id = 'tour-covers' and is_tour_member(((string_to_array(name, '/'))[1])::uuid, auth.uid())
  );
create policy "tour covers writable by tour managers" on storage.objects
  for insert with check (
    bucket_id = 'tour-covers' and is_tour_manager(((string_to_array(name, '/'))[1])::uuid, auth.uid())
  );
create policy "tour covers deletable by tour managers" on storage.objects
  for delete using (
    bucket_id = 'tour-covers' and is_tour_manager(((string_to_array(name, '/'))[1])::uuid, auth.uid())
  );
