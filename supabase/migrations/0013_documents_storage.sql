-- Real file storage for tour documents (contracts, riders, advances).
-- Until now `documents` was metadata-only — a title and a visibility flag
-- with nowhere for an actual file to live. This wires up Supabase Storage
-- properly, with access control that mirrors the `documents` table's own
-- visibility rule rather than being a separate, looser system.
--
-- Path convention: every object is stored at `<tour_id>/<document_id>-<filename>`.
-- The upload flow (AddDocumentScreen) inserts the `documents` row FIRST
-- (with a client-generated id — same pattern as lib/ids.ts, and for the
-- same reason: avoids the insert+representation trigger issue) with a
-- precomputed storage_path, THEN uploads the file to that exact path
-- second. That ordering matters: it means the WRITE policy below can be a
-- simple path-prefix check (the tour_id folder), while the READ policy
-- can be the precise, visibility-aware one — checked against the actual
-- `documents` row, not just "some manager of some tour."

insert into storage.buckets (id, name, public)
values ('tour-documents', 'tour-documents', false)
on conflict (id) do nothing;

-- Read: mirrors "documents readable per visibility" from 0001_init.sql
-- exactly — managers see everything, everyone else only sees 'org'
-- visibility docs. A crew member can't fetch a 'managers_only' file even
-- with a guessed/leaked URL, because this check runs on every read, not
-- just when the metadata row is listed.
create policy "tour documents readable per visibility" on storage.objects
  for select using (
    bucket_id = 'tour-documents'
    and exists (
      select 1 from documents d
      where d.storage_path = storage.objects.name
        and (
          is_tour_manager(d.tour_id, auth.uid())
          or (d.visibility = 'org' and is_tour_member(d.tour_id, auth.uid()))
        )
    )
  );

-- Write/delete: path-prefix based (the first path segment is the tour_id)
-- rather than joining to `documents`, since the metadata row is created
-- immediately before the upload — at upload time it already exists, but
-- keeping this check independent of that ordering is more robust than
-- depending on it.
create policy "tour documents writable by managers" on storage.objects
  for insert with check (
    bucket_id = 'tour-documents'
    and is_tour_manager(((string_to_array(name, '/'))[1])::uuid, auth.uid())
  );

create policy "tour documents deletable by managers" on storage.objects
  for delete using (
    bucket_id = 'tour-documents'
    and is_tour_manager(((string_to_array(name, '/'))[1])::uuid, auth.uid())
  );