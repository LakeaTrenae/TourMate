-- Venue photo gallery — stage shots, stage plots, whatever helps the
-- crew know what a venue actually looks like before load-in. Mirrors
-- venues' own RLS exactly (org members can view, org managers can
-- upload/delete) since a photo is just another attribute of the venue
-- record, not a separately-scoped resource.

create table venue_photos (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues (id) on delete cascade,
  storage_path text not null,
  caption text,
  uploaded_by uuid references profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index venue_photos_venue_id_idx on venue_photos (venue_id);

create or replace function venue_organization_id(p_venue_id uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select organization_id from venues where id = p_venue_id;
$$;

alter table venue_photos enable row level security;

create policy "venue_photos readable by org members" on venue_photos
  for select using (is_member_of_org(venue_organization_id(venue_id), auth.uid()));
create policy "venue_photos insertable by org managers" on venue_photos
  for insert with check (is_org_manager(venue_organization_id(venue_id), auth.uid()));
create policy "venue_photos deletable by org managers" on venue_photos
  for delete using (is_org_manager(venue_organization_id(venue_id), auth.uid()));

-- Storage: path convention <organization_id>/<venue_id>/<photo_id>-<filename>,
-- gated the same way as the metadata table above — the first path
-- segment is the organization_id, checked directly rather than joining
-- out, same style as tour-documents/tour-receipts (0013/0017).
insert into storage.buckets (id, name, public)
values ('venue-photos', 'venue-photos', false)
on conflict (id) do nothing;

create policy "venue photos readable by org members" on storage.objects
  for select using (
    bucket_id = 'venue-photos' and is_member_of_org(((string_to_array(name, '/'))[1])::uuid, auth.uid())
  );
create policy "venue photos writable by org managers" on storage.objects
  for insert with check (
    bucket_id = 'venue-photos' and is_org_manager(((string_to_array(name, '/'))[1])::uuid, auth.uid())
  );
create policy "venue photos deletable by org managers" on storage.objects
  for delete using (
    bucket_id = 'venue-photos' and is_org_manager(((string_to_array(name, '/'))[1])::uuid, auth.uid())
  );
