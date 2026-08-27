-- Multi-artist privacy — for a bill with more than one act (support acts,
-- a festival day, a co-headline tour), each artist gets their own
-- dressing room, management contacts, and rider/hospitality documents,
-- visible only to tour management and that specific artist's own team —
-- not the general crew, and not other artists on the same bill.
--
-- Split into `artists` (public: just the name — "who's playing" is
-- normal show info everyone already knows) and `artist_contacts`
-- (private: management name/phone/email), same reasoning as splitting
-- passport_visa_info off of profiles in 0024 — RLS is row-level, not
-- column-level, so a sensitive field needs its own table to actually be
-- gated rather than riding along on a row other policies already open up.
--
-- Ownership follows the department model already used everywhere else
-- (production department, since this is explicitly a production-
-- assistant task) — but VISIBILITY of the private tables is a different
-- axis entirely: not "your department," but "you're on this specific
-- artist's team," which is why this needs new helper functions rather
-- than reusing department_on_tour for the read side.

create table artists (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references tours (id) on delete cascade,
  name text not null,
  created_by uuid references profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table artist_contacts (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references artists (id) on delete cascade,
  name text not null,
  role text, -- "Tour Manager", "Manager", "Agent"...
  phone text,
  email text,
  created_at timestamptz not null default now()
);

create table artist_team_members (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references artists (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  role text, -- "FOH Engineer", "Tour Manager"...
  added_by uuid references profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (artist_id, user_id)
);

create table dressing_rooms (
  id uuid primary key default gen_random_uuid(),
  tour_date_id uuid not null references tour_dates (id) on delete cascade,
  room_name text not null,
  artist_id uuid references artists (id) on delete set null,
  notes text,
  created_by uuid references profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Riders/hospitality docs (see document_category, 0021) can now be
-- tagged to a specific artist instead of just the blunt org/managers_only
-- visibility toggle.
alter table documents
  add column artist_id uuid references artists (id) on delete set null;

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================
create or replace function is_on_artist_team(p_artist_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from artist_team_members where artist_id = p_artist_id and user_id = p_user_id
  );
$$;

create or replace function artist_tour_id(p_artist_id uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select tour_id from artists where id = p_artist_id;
$$;

create or replace function dressing_room_tour_id(p_room_id uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select td.tour_id from dressing_rooms dr join tour_dates td on td.id = dr.tour_date_id where dr.id = p_room_id;
$$;

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
alter table artists enable row level security;
alter table artist_contacts enable row level security;
alter table artist_team_members enable row level security;
alter table dressing_rooms enable row level security;

-- ARTISTS: name/existence is normal show info, visible to the whole tour.
create policy "artists readable by tour members" on artists
  for select using (is_tour_member(tour_id, auth.uid()));
create policy "artists insertable by managers or production" on artists
  for insert with check (
    is_tour_manager(tour_id, auth.uid()) or department_on_tour(tour_id, auth.uid()) = 'production'
  );
create policy "artists updatable by managers or production" on artists
  for update using (
    is_tour_manager(tour_id, auth.uid()) or department_on_tour(tour_id, auth.uid()) = 'production'
  );
create policy "artists deletable by managers or production" on artists
  for delete using (
    is_tour_manager(tour_id, auth.uid()) or department_on_tour(tour_id, auth.uid()) = 'production'
  );

-- ARTIST_CONTACTS: the actually-private part.
create policy "artist_contacts readable by managers or team" on artist_contacts
  for select using (
    is_tour_manager(artist_tour_id(artist_id), auth.uid()) or is_on_artist_team(artist_id, auth.uid())
  );
create policy "artist_contacts writable by managers or production" on artist_contacts
  for insert with check (
    is_tour_manager(artist_tour_id(artist_id), auth.uid())
    or department_on_tour(artist_tour_id(artist_id), auth.uid()) = 'production'
  );
create policy "artist_contacts updatable by managers or production" on artist_contacts
  for update using (
    is_tour_manager(artist_tour_id(artist_id), auth.uid())
    or department_on_tour(artist_tour_id(artist_id), auth.uid()) = 'production'
  );
create policy "artist_contacts deletable by managers or production" on artist_contacts
  for delete using (
    is_tour_manager(artist_tour_id(artist_id), auth.uid())
    or department_on_tour(artist_tour_id(artist_id), auth.uid()) = 'production'
  );

-- ARTIST_TEAM_MEMBERS: who's on the team is part of "the specifics" too
-- — managers and existing teammates can see the roster, general crew
-- can't.
create policy "artist_team_members readable by managers or team" on artist_team_members
  for select using (
    is_tour_manager(artist_tour_id(artist_id), auth.uid()) or is_on_artist_team(artist_id, auth.uid())
  );
create policy "artist_team_members writable by managers or production" on artist_team_members
  for insert with check (
    is_tour_manager(artist_tour_id(artist_id), auth.uid())
    or department_on_tour(artist_tour_id(artist_id), auth.uid()) = 'production'
  );
create policy "artist_team_members deletable by managers or production" on artist_team_members
  for delete using (
    is_tour_manager(artist_tour_id(artist_id), auth.uid())
    or department_on_tour(artist_tour_id(artist_id), auth.uid()) = 'production'
  );

-- DRESSING_ROOMS: before assignment, this is a management/production
-- planning detail nobody else needs to see. Once an artist is assigned,
-- their team can see this specific room's specifics too — the actual
-- feature being asked for.
create policy "dressing_rooms readable by managers or assigned team" on dressing_rooms
  for select using (
    is_tour_manager(dressing_room_tour_id(id), auth.uid())
    or (artist_id is not null and is_on_artist_team(artist_id, auth.uid()))
  );
create policy "dressing_rooms insertable by managers or production" on dressing_rooms
  for insert with check (
    is_tour_manager((select tour_id from tour_dates where id = dressing_rooms.tour_date_id), auth.uid())
    or department_on_tour((select tour_id from tour_dates where id = dressing_rooms.tour_date_id), auth.uid()) = 'production'
  );
create policy "dressing_rooms updatable by managers or production" on dressing_rooms
  for update using (
    is_tour_manager(dressing_room_tour_id(id), auth.uid())
    or department_on_tour(dressing_room_tour_id(id), auth.uid()) = 'production'
  );
create policy "dressing_rooms deletable by managers or production" on dressing_rooms
  for delete using (
    is_tour_manager(dressing_room_tour_id(id), auth.uid())
    or department_on_tour(dressing_room_tour_id(id), auth.uid()) = 'production'
  );

-- DOCUMENTS: extend the existing visibility policy — a document tagged
-- to an artist is also visible to that artist's team regardless of the
-- managers_only/org flag, since tagging it to them is an explicit "they
-- need this," not a looser version of the existing toggle.
drop policy "documents readable per visibility" on documents;
create policy "documents readable per visibility" on documents
  for select using (
    is_tour_manager(tour_id, auth.uid())
    or (visibility = 'org' and is_tour_member(tour_id, auth.uid()))
    or (artist_id is not null and is_on_artist_team(artist_id, auth.uid()))
  );

-- ============================================================================
-- COMPLETION LOCK — extend with the four new tables (full function body
-- copied forward from 0023, not a diff).
-- ============================================================================
create or replace function enforce_tour_not_locked()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_tour_id uuid;
  v_org_id uuid;
  v_completed_at timestamptz;
  v_actor uuid := auth.uid();
begin
  if TG_TABLE_NAME = 'tours' then
    if TG_OP = 'INSERT' then
      return NEW;
    end if;
    v_tour_id := OLD.id;
    v_completed_at := OLD.completed_at;
    v_org_id := OLD.organization_id;

  elsif TG_TABLE_NAME in (
    'tour_members', 'tour_dates', 'flights', 'lodging',
    'documents', 'budget_items', 'resource_shares', 'tour_invites',
    'checklists', 'ground_transport', 'artists'
  ) then
    v_tour_id := coalesce(NEW.tour_id, OLD.tour_id);

  elsif TG_TABLE_NAME = 'flight_passengers' then
    select f.tour_id into v_tour_id
      from flights f where f.id = coalesce(NEW.flight_id, OLD.flight_id);

  elsif TG_TABLE_NAME = 'lodging_rooms' then
    select l.tour_id into v_tour_id
      from lodging l where l.id = coalesce(NEW.lodging_id, OLD.lodging_id);

  elsif TG_TABLE_NAME = 'lodging_room_occupants' then
    select l.tour_id into v_tour_id
      from lodging_rooms lr join lodging l on l.id = lr.lodging_id
      where lr.id = coalesce(NEW.room_id, OLD.room_id);

  elsif TG_TABLE_NAME in ('guest_list_requests', 'schedule_items', 'advances', 'settlements') then
    select td.tour_id into v_tour_id
      from tour_dates td where td.id = coalesce(NEW.tour_date_id, OLD.tour_date_id);

  elsif TG_TABLE_NAME = 'checklist_items' then
    select c.tour_id into v_tour_id
      from checklists c where c.id = coalesce(NEW.checklist_id, OLD.checklist_id);

  elsif TG_TABLE_NAME = 'ground_transport_passengers' then
    select ground_transport_tour_id(coalesce(NEW.ground_transport_id, OLD.ground_transport_id)) into v_tour_id;

  elsif TG_TABLE_NAME = 'dressing_rooms' then
    select td.tour_id into v_tour_id
      from tour_dates td where td.id = coalesce(NEW.tour_date_id, OLD.tour_date_id);

  elsif TG_TABLE_NAME in ('artist_contacts', 'artist_team_members') then
    select artist_tour_id(coalesce(NEW.artist_id, OLD.artist_id)) into v_tour_id;
  end if;

  if v_tour_id is null then
    if TG_OP = 'DELETE' then return OLD; end if;
    return NEW;
  end if;

  if TG_TABLE_NAME != 'tours' then
    select t.completed_at, t.organization_id into v_completed_at, v_org_id
      from tours t where t.id = v_tour_id;
  end if;

  if v_completed_at is not null
     and not (is_org_admin(v_org_id, v_actor) or is_tour_owner(v_tour_id, v_actor)) then
    raise exception 'This tour is completed and locked. Only the tour owner can make further changes.'
      using errcode = '42501';
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

create trigger lock_completed_tour before insert or update or delete on artists
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on artist_contacts
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on artist_team_members
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on dressing_rooms
  for each row execute function enforce_tour_not_locked();
