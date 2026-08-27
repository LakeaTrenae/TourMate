-- Receipt attachments on budget entries. Simpler than the documents
-- bucket (0013): budget is always manager-only, no two-tier visibility to
-- reconcile, so read/write/delete can all use the same path-prefix check
-- (first path segment = tour_id) rather than joining out to a metadata
-- table.

insert into storage.buckets (id, name, public)
values ('tour-receipts', 'tour-receipts', false)
on conflict (id) do nothing;

alter table budget_items
  add column receipt_path text;

create policy "tour receipts readable by managers" on storage.objects
  for select using (
    bucket_id = 'tour-receipts'
    and is_tour_manager(((string_to_array(name, '/'))[1])::uuid, auth.uid())
  );

create policy "tour receipts writable by managers" on storage.objects
  for insert with check (
    bucket_id = 'tour-receipts'
    and is_tour_manager(((string_to_array(name, '/'))[1])::uuid, auth.uid())
  );

create policy "tour receipts deletable by managers" on storage.objects
  for delete using (
    bucket_id = 'tour-receipts'
    and is_tour_manager(((string_to_array(name, '/'))[1])::uuid, auth.uid())
  );
