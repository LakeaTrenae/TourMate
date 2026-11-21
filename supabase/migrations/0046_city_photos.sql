-- City photo cache for the "on the road" card on Tour Dashboard — a
-- real photo of the next stop's city, not sensitive/tour-scoped data (a
-- photo of "Nashville" is the same for every tour that passes through
-- it), so this is readable by any signed-in user rather than gated by
-- tour membership. Writes only ever come from the city-photo edge
-- function (service role), which also owns refreshing a stale entry.
-- `state` defaults to '' rather than allowing null — Postgres treats
-- every NULL as distinct for uniqueness purposes, which would let the
-- same city with an unknown state get cached under multiple rows.
create table city_photos (
  id uuid primary key default gen_random_uuid(),
  city text not null,
  state text not null default '',
  photo_url text not null,
  photographer text,
  photographer_url text,
  fetched_at timestamptz not null default now(),
  unique (city, state)
);

alter table city_photos enable row level security;

create policy "city_photos readable by signed-in users" on city_photos
  for select using (auth.uid() is not null);

grant all on table public.city_photos to anon, authenticated, service_role;
