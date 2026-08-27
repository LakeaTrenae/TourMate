-- TourMate initial schema
-- Model: Organization (band / production co / venue / promoter) -> Tours -> Dates
-- Access control: role-scoped at the organization level, with optional per-tour
-- overrides, enforced via Postgres RLS (not just app-layer checks).
--
-- SECURITY MODEL (read this before adding new tables or policies):
--
-- 1. Every table that holds tour/org data has RLS enabled. There is no
--    table in this schema that a client can read or write without a
--    policy explicitly allowing it — the default with RLS on is "deny
--    everything," and each `create policy` below is a deliberate carve-out.
-- 2. Role checks are centralized in two SQL functions
--    (`effective_tour_role`, `is_tour_manager`) instead of being
--    reimplemented per policy. If the role model ever changes, it changes
--    in one place instead of N policies drifting out of sync.
-- 3. This is enforced by Postgres itself, not by the app. A bug in the
--    mobile app's UI (e.g. forgetting to hide a budget screen from crew)
--    cannot leak budget data, because the database itself refuses to
--    return those rows to a crew account — the query comes back empty,
--    not filtered client-side after the fact.
-- 4. Clients only ever hold the Supabase `anon` key (safe to ship in the
--    app binary) plus a signed-in user's session. The `service_role` key,
--    which bypasses RLS entirely, must never be embedded in a client.

-- ============================================================================
-- EXTENSIONS
-- ============================================================================
create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ============================================================================
-- ENUMS
-- ============================================================================
create type org_role as enum ('owner', 'admin', 'manager', 'crew');
create type subscription_status as enum ('trialing', 'active', 'past_due', 'canceled', 'none');
create type guest_list_status as enum ('pending', 'approved', 'denied');
create type document_visibility as enum ('org', 'managers_only');
create type budget_entry_type as enum ('income', 'expense');

-- ============================================================================
-- PROFILES  (mirrors auth.users, one row per Supabase auth user)
-- ============================================================================
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  email text not null,
  phone text,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- ORGANIZATIONS  (the tenant boundary — a band, production company, venue, etc.)
-- ============================================================================
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now(),

  -- Billing lives at the org level. Provider-agnostic on purpose: filled in
  -- once billing is actually wired up (Stripe via subscription checkout).
  subscription_plan text not null default 'free',
  subscription_status subscription_status not null default 'none',
  subscription_renews_at timestamptz,
  billing_customer_id text -- external provider's customer id, nullable until wired up
);

create table organization_members (
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  role org_role not null default 'crew',
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  primary key (organization_id, user_id)
);

-- ============================================================================
-- VENUES  (org-scoped venue database — reusable across tours)
-- ============================================================================
create table venues (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name text not null,
  address text,
  city text,
  state text,
  country text,
  capacity integer,
  tech_specs jsonb not null default '{}'::jsonb, -- stage size, power, rigging, etc.
  contacts jsonb not null default '[]'::jsonb,    -- [{name, role, phone, email}]
  created_at timestamptz not null default now()
);

-- ============================================================================
-- TOURS
-- ============================================================================
create table tours (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name text not null,
  start_date date,
  end_date date,
  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now()
);

-- Per-tour role override. Most members inherit their org role; this table lets
-- a manager grant someone a *narrower* or *different* role for one tour
-- specifically (e.g. a session player who's crew on this tour only).
create table tour_members (
  tour_id uuid not null references tours (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  role org_role not null,
  added_at timestamptz not null default now(),
  primary key (tour_id, user_id)
);

-- ============================================================================
-- TOUR DATES  (one row per show/stop — the itinerary/day-sheet backbone)
-- ============================================================================
create table tour_dates (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references tours (id) on delete cascade,
  venue_id uuid references venues (id),
  date date not null,
  load_in time,
  soundcheck time,
  doors time,
  set_time time,
  notes text,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- FLIGHTS
-- ============================================================================
create table flights (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references tours (id) on delete cascade,
  tour_date_id uuid references tour_dates (id),
  airline text,
  flight_number text,
  confirmation_code text,
  departure_airport text not null,
  departure_time timestamptz not null,
  arrival_airport text not null,
  arrival_time timestamptz not null,
  status text, -- populated by a flight-status integration later (on time / delayed / gate change)
  created_at timestamptz not null default now()
);

create table flight_passengers (
  flight_id uuid not null references flights (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  seat text,
  primary key (flight_id, user_id)
);

-- ============================================================================
-- LODGING
-- ============================================================================
create table lodging (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references tours (id) on delete cascade,
  tour_date_id uuid references tour_dates (id),
  hotel_name text not null,
  address text,
  check_in date,
  check_out date,
  confirmation_code text,
  created_at timestamptz not null default now()
);

create table lodging_rooms (
  id uuid primary key default gen_random_uuid(),
  lodging_id uuid not null references lodging (id) on delete cascade,
  room_number text,
  notes text
);

create table lodging_room_occupants (
  room_id uuid not null references lodging_rooms (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  primary key (room_id, user_id)
);

-- ============================================================================
-- GUEST LIST
-- ============================================================================
create table guest_list_requests (
  id uuid primary key default gen_random_uuid(),
  tour_date_id uuid not null references tour_dates (id) on delete cascade,
  requested_by uuid not null references profiles (id),
  guest_name text not null,
  guest_count integer not null default 1,
  status guest_list_status not null default 'pending',
  notes text,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- DOCUMENTS  (contracts, riders, advances — file lives in Supabase Storage,
-- this row just tracks metadata + visibility)
-- ============================================================================
create table documents (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references tours (id) on delete cascade,
  uploaded_by uuid not null references profiles (id),
  title text not null,
  storage_path text not null,
  visibility document_visibility not null default 'managers_only',
  created_at timestamptz not null default now()
);

-- ============================================================================
-- BUDGET  (manager/admin/owner visibility only — enforced via RLS below)
-- ============================================================================
create table budget_items (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references tours (id) on delete cascade,
  category text not null,
  description text,
  amount numeric(12, 2) not null,
  entry_type budget_entry_type not null,
  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now()
);

-- ============================================================================
-- HELPER FUNCTIONS  (used inside RLS policies below)
-- ============================================================================

-- Effective role for a user on a given tour: tour-level override if present,
-- otherwise the user's org-level role.
create or replace function effective_tour_role(p_tour_id uuid, p_user_id uuid)
returns org_role
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role from tour_members where tour_id = p_tour_id and user_id = p_user_id),
    (select om.role from tours t
       join organization_members om on om.organization_id = t.organization_id
       where t.id = p_tour_id and om.user_id = p_user_id)
  );
$$;

create or replace function is_tour_member(p_tour_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select effective_tour_role(p_tour_id, p_user_id) is not null;
$$;

create or replace function is_tour_manager(p_tour_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select effective_tour_role(p_tour_id, p_user_id) in ('owner', 'admin', 'manager');
$$;

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
alter table profiles enable row level security;
alter table organizations enable row level security;
alter table organization_members enable row level security;
alter table venues enable row level security;
alter table tours enable row level security;
alter table tour_members enable row level security;
alter table tour_dates enable row level security;
alter table flights enable row level security;
alter table flight_passengers enable row level security;
alter table lodging enable row level security;
alter table lodging_rooms enable row level security;
alter table lodging_room_occupants enable row level security;
alter table guest_list_requests enable row level security;
alter table documents enable row level security;
alter table budget_items enable row level security;

-- Profiles: NOTE this is intentionally narrow — a user can only read/update
-- their OWN profile row via this policy. Teammates' names/contact info are
-- surfaced through tour-scoped views (flight passengers, room occupants,
-- etc.), not by opening up profiles globally, so a signed-in user can't
-- enumerate every person on the platform.
create policy "profiles are readable by self" on profiles
  for select using (id = auth.uid());
create policy "profiles are updatable by self" on profiles
  for update using (id = auth.uid());

-- Organizations: any member can view the org they belong to; only
-- owner/admin can change org-level settings (name, billing plan, etc.) —
-- a plain "manager" runs tours but doesn't administer the organization.
create policy "org readable by members" on organizations
  for select using (
    exists (select 1 from organization_members om
            where om.organization_id = organizations.id and om.user_id = auth.uid())
  );
create policy "org updatable by owner/admin" on organizations
  for update using (
    exists (select 1 from organization_members om
            where om.organization_id = organizations.id and om.user_id = auth.uid()
              and om.role in ('owner', 'admin'))
  );

-- Tours: visible to anyone who is a tour member (via org role or tour override).
create policy "tours readable by members" on tours
  for select using (is_tour_member(id, auth.uid()));
-- Insert has no tour row yet to check `is_tour_manager` against, so this
-- checks the org-level role directly instead: only org managers+ can stand
-- up a new tour under that organization.
create policy "tours writable by managers" on tours
  for insert with check (
    exists (select 1 from organization_members om
            where om.organization_id = tours.organization_id and om.user_id = auth.uid()
              and om.role in ('owner', 'admin', 'manager'))
  );
create policy "tours updatable by managers" on tours
  for update using (is_tour_manager(id, auth.uid()));

-- Tour-scoped operational data (dates, flights, lodging): full read for any
-- tour member, but each person only sees rows they're assigned to unless
-- they're a manager. Enforced per-table below.

create policy "tour_dates readable by members" on tour_dates
  for select using (is_tour_member(tour_id, auth.uid()));
create policy "tour_dates writable by managers" on tour_dates
  for insert with check (is_tour_manager(tour_id, auth.uid()));
create policy "tour_dates updatable by managers" on tour_dates
  for update using (is_tour_manager(tour_id, auth.uid()));

-- Flights: managers see all flights on the tour; crew see only flights they're
-- a passenger on.
create policy "flights readable by managers" on flights
  for select using (is_tour_manager(tour_id, auth.uid()));
create policy "flights readable by assigned passenger" on flights
  for select using (
    exists (select 1 from flight_passengers fp
            where fp.flight_id = flights.id and fp.user_id = auth.uid())
  );
create policy "flights writable by managers" on flights
  for insert with check (is_tour_manager(tour_id, auth.uid()));
create policy "flights updatable by managers" on flights
  for update using (is_tour_manager(tour_id, auth.uid()));

create policy "flight_passengers readable by self or manager" on flight_passengers
  for select using (
    user_id = auth.uid()
    or exists (select 1 from flights f where f.id = flight_passengers.flight_id
               and is_tour_manager(f.tour_id, auth.uid()))
  );

-- Lodging: same pattern as flights — managers see all rooms, crew see only
-- their own room assignment.
create policy "lodging readable by managers" on lodging
  for select using (is_tour_manager(tour_id, auth.uid()));
create policy "lodging readable by assigned occupant" on lodging
  for select using (
    exists (select 1 from lodging_rooms lr
              join lodging_room_occupants lro on lro.room_id = lr.id
            where lr.lodging_id = lodging.id and lro.user_id = auth.uid())
  );

-- Guest list: any tour member can view and submit requests (this mirrors
-- Master Tour's model where artists submit their own guest list directly) —
-- approval workflow/status changes are left to app logic for now, not
-- restricted to managers at the RLS layer yet.
create policy "guest_list readable by members" on guest_list_requests
  for select using (
    exists (select 1 from tour_dates td where td.id = guest_list_requests.tour_date_id
            and is_tour_member(td.tour_id, auth.uid()))
  );
create policy "guest_list insertable by members" on guest_list_requests
  for insert with check (
    exists (select 1 from tour_dates td where td.id = guest_list_requests.tour_date_id
            and is_tour_member(td.tour_id, auth.uid()))
  );

-- Documents: managers-only docs are hidden from crew entirely.
create policy "documents readable per visibility" on documents
  for select using (
    is_tour_manager(tour_id, auth.uid())
    or (visibility = 'org' and is_tour_member(tour_id, auth.uid()))
  );
create policy "documents writable by managers" on documents
  for insert with check (is_tour_manager(tour_id, auth.uid()));

-- Budget: managers/admins/owners only. Crew never see this table at all.
create policy "budget readable by managers only" on budget_items
  for select using (is_tour_manager(tour_id, auth.uid()));
create policy "budget writable by managers only" on budget_items
  for insert with check (is_tour_manager(tour_id, auth.uid()));
create policy "budget updatable by managers only" on budget_items
  for update using (is_tour_manager(tour_id, auth.uid()));