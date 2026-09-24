-- Closing the remaining gaps against Master Tour's real "Professional"
-- feature list (confirmed against the user's own screenshots of it):
--   1. Set List and Performance Management — new feature, mirrors
--      checklists/checklist_items exactly (same visibility model, same
--      resource_shares wiring).
--   2. Real-Time Flight Tracking with FlightAware — new columns on
--      `flights` for the richer live-status data an AeroAPI lookup
--      returns (flights.status already existed as a placeholder for
--      exactly this, per its own 0001_init.sql comment).
--   3. Real-Time Routing Calculations — a small cache table so the
--      Google Directions API (paid, rate-limited) isn't re-queried on
--      every RouteScreen render; only the edge function (service_role)
--      writes to it.
--   4. Calendar Subscriptions — a stable per-user token so a calendar
--      app can GET a live .ics feed with no login session, the same way
--      TripIt's own "Sync to Calendar" feed works.
--   5. TripIt Travel Itinerary Importing — TripIt's real developer API
--      has been effectively closed to new registrations for years; every
--      working integration today reads the personal ICS feed URL TripIt
--      already publishes per traveler instead, so that's what this reads
--      too (profiles.tripit_feed_url, pasted in once).
--
-- Every new table below ships its Data API grants inline — Supabase is
-- discontinuing automatic grants for new public-schema tables starting
-- October 30 (see 0039's header) — matching the exact privilege set
-- every existing table already has.

-- ============================================================================
-- 1. SETLISTS — mirrors checklists/checklist_items (0021) almost verbatim:
-- same visible_to_all/department visibility model, same optional
-- tour_date_id (null = the act's standing setlist; set = a night-specific
-- override), same resource_shares wiring for "specific people/departments".
-- ============================================================================
create table setlists (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references tours (id) on delete cascade,
  artist_id uuid references artists (id) on delete cascade, -- null = the tour's own setlist (e.g. a house band), not tied to one billed act
  tour_date_id uuid references tour_dates (id) on delete cascade, -- null = standing setlist; set = overrides it for one specific show
  name text not null default 'Set List',
  template text not null default 'standard' check (template in ('standard', 'large_print', 'compact')),
  department tour_department not null default 'artist_relations',
  visible_to_all boolean not null default true,
  notes text,
  updated_by uuid references profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now()
);

create table setlist_items (
  id uuid primary key default gen_random_uuid(),
  setlist_id uuid not null references setlists (id) on delete cascade,
  title text not null, -- a song title, or a stage cue like "ENCORE BREAK" / "COSTUME CHANGE"
  notes text, -- key, segue, tech cue, run time...
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index setlists_tour_id_idx on setlists (tour_id);
create index setlist_items_setlist_id_idx on setlist_items (setlist_id);

create or replace function can_view_setlist(p_setlist_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from setlists s
    where s.id = p_setlist_id
      and (
        s.visible_to_all
        or is_tour_manager(s.tour_id, p_user_id)
        or department_on_tour(s.tour_id, p_user_id) = s.department
        or exists (
          select 1 from resource_shares rs
          where rs.resource_type = 'setlist' and rs.resource_id = s.id
            and (
              rs.shared_with_user_id = p_user_id
              or rs.shared_with_department = department_on_tour(s.tour_id, p_user_id)
            )
        )
      )
  );
$$;

create or replace function can_edit_setlist(p_setlist_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from setlists s
      join tours t on t.id = s.tour_id
    where s.id = p_setlist_id
      and (
        is_org_admin(t.organization_id, p_user_id)
        or is_tour_manager(s.tour_id, p_user_id)
        or department_on_tour(s.tour_id, p_user_id) = s.department
        or exists (
          select 1 from resource_shares rs
          where rs.resource_type = 'setlist' and rs.resource_id = s.id
            and rs.permission = 'edit'
            and (
              rs.shared_with_user_id = p_user_id
              or rs.shared_with_department = department_on_tour(s.tour_id, p_user_id)
            )
        )
      )
  );
$$;

alter table setlists enable row level security;
alter table setlist_items enable row level security;

create policy "setlists readable per visibility rules" on setlists
  for select using (can_view_setlist(id, auth.uid()));
create policy "setlists insertable by owning department or managers" on setlists
  for insert with check (
    is_tour_manager(tour_id, auth.uid())
    or department_on_tour(tour_id, auth.uid()) = department
  );
create policy "setlists updatable per edit rights" on setlists
  for update using (can_edit_setlist(id, auth.uid()));
create policy "setlists deletable per edit rights" on setlists
  for delete using (can_edit_setlist(id, auth.uid()));

create policy "setlist_items readable per parent setlist" on setlist_items
  for select using (can_view_setlist(setlist_id, auth.uid()));
create policy "setlist_items insertable per parent setlist edit rights" on setlist_items
  for insert with check (can_edit_setlist(setlist_id, auth.uid()));
create policy "setlist_items updatable per parent setlist edit rights" on setlist_items
  for update using (can_edit_setlist(setlist_id, auth.uid()));
create policy "setlist_items deletable per parent setlist edit rights" on setlist_items
  for delete using (can_edit_setlist(setlist_id, auth.uid()));

-- Extend resource_shares' insert/delete policies with the 'setlist' branch
-- (same append-one-branch pattern as every prior resource type).
drop policy "resource_shares insertable by resource owner" on resource_shares;
create policy "resource_shares insertable by resource owner" on resource_shares
  for insert with check (
    granted_by = auth.uid()
    and (
      (resource_type = 'schedule_item' and can_edit_schedule_item(resource_id, auth.uid()))
      or (resource_type = 'checklist' and can_edit_checklist(resource_id, auth.uid()))
      or (resource_type = 'document' and can_edit_document(resource_id, auth.uid()))
      or (resource_type = 'advance' and can_edit_advance(resource_id, auth.uid()))
      or (resource_type = 'setlist' and can_edit_setlist(resource_id, auth.uid()))
    )
  );

drop policy "resource_shares deletable by owner or managers" on resource_shares;
create policy "resource_shares deletable by owner or managers" on resource_shares
  for delete using (
    is_tour_manager(tour_id, auth.uid())
    or (resource_type = 'schedule_item' and can_edit_schedule_item(resource_id, auth.uid()))
    or (resource_type = 'checklist' and can_edit_checklist(resource_id, auth.uid()))
    or (resource_type = 'document' and can_edit_document(resource_id, auth.uid()))
    or (resource_type = 'advance' and can_edit_advance(resource_id, auth.uid()))
    or (resource_type = 'setlist' and can_edit_setlist(resource_id, auth.uid()))
  );

grant all on table public.setlists to anon, authenticated, service_role;
grant all on table public.setlist_items to anon, authenticated, service_role;

-- ============================================================================
-- 2. FLIGHT TRACKING — richer live-status columns for the FlightAware
-- AeroAPI integration (flights.status already existed as a placeholder).
-- All nullable/best-effort: a flight with no FLIGHTAWARE_API_KEY configured
-- yet just keeps showing manually-entered times, same as today.
-- ============================================================================
alter table flights
  add column actual_departure_time timestamptz,
  add column actual_arrival_time timestamptz,
  add column departure_gate text,
  add column arrival_gate text,
  add column departure_terminal text,
  add column arrival_terminal text,
  add column status_detail text, -- human-readable: "Delayed 45 min", "Landed", "Cancelled"
  add column status_checked_at timestamptz;

-- ============================================================================
-- 3. ROUTING CACHE — real driving distance/duration between two show dates
-- (Google Directions API), cached because it's a paid, rate-limited call
-- that shouldn't re-fire on every RouteScreen render. Only the edge
-- function (service_role, bypasses RLS) writes here — clients only read.
-- ============================================================================
create table route_segments (
  id uuid primary key default gen_random_uuid(),
  from_tour_date_id uuid not null references tour_dates (id) on delete cascade,
  to_tour_date_id uuid not null references tour_dates (id) on delete cascade,
  distance_miles numeric(8, 1),
  duration_minutes integer,
  computed_at timestamptz not null default now(),
  unique (from_tour_date_id, to_tour_date_id)
);

create index route_segments_from_idx on route_segments (from_tour_date_id);

alter table route_segments enable row level security;

-- Readable by anyone who could read the tour_dates it connects (same
-- membership check tour_dates itself relies on — a segment is only ever
-- meaningful to someone who's already allowed to see both dates it joins).
create policy "route_segments readable by tour members" on route_segments
  for select using (
    exists (
      select 1 from tour_dates td
      where td.id = route_segments.from_tour_date_id
        and effective_tour_role(td.tour_id, auth.uid()) is not null
    )
  );

grant all on table public.route_segments to anon, authenticated, service_role;

-- ============================================================================
-- 4 & 5. CALENDAR SUBSCRIPTIONS + TRIPIT IMPORT — both live on profiles.
-- calendar_feed_token is a stable per-user secret used INSTEAD OF a
-- Supabase JWT in the feed URL (a calendar app has no way to send an
-- Authorization header) — the calendar-feed edge function looks the
-- caller up by this token rather than by auth.getUser(). tripit_feed_url
-- is just the personal ICS feed URL TripIt already publishes per
-- traveler, pasted in once via Settings.
-- ============================================================================
alter table profiles
  add column calendar_feed_token uuid not null default gen_random_uuid(),
  add column tripit_feed_url text;

-- Lets a signed-in user rotate their own feed token (e.g. if a link ever
-- leaked) without needing a support request.
create or replace function rotate_my_calendar_feed_token()
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  new_token uuid := gen_random_uuid();
begin
  update profiles set calendar_feed_token = new_token where id = auth.uid();
  return new_token;
end;
$$;
