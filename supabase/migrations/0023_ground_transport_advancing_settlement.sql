-- Deepens the show/tour-day model with three new feature tables plus a
-- storage bucket for calendar exports. Every cross-table RLS lookup below
-- goes through a security-definer helper from the start — the project has
-- hit the raw-subquery recursion bug three times already (organization_
-- members self-reference; flights<->flight_passengers; lodging<->lodging_
-- rooms<->lodging_room_occupants), so new tables get it right on day one
-- instead of needing a follow-up fix migration like 0012's.

-- ============================================================================
-- GROUND TRANSPORT (mirrors flights/flight_passengers exactly — including
-- a full delete policy on the passengers table, which flight_passengers
-- itself is still missing; not carrying that gap forward here)
-- ============================================================================
create table ground_transport (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references tours (id) on delete cascade,
  tour_date_id uuid references tour_dates (id),
  vehicle_type text,           -- bus, sprinter, van, car...
  company text,
  driver_name text,
  driver_phone text,
  pickup_location text not null,
  pickup_time timestamptz not null,
  dropoff_location text not null,
  dropoff_time timestamptz not null,
  confirmation_code text,
  notes text,
  created_at timestamptz not null default now()
);

create table ground_transport_passengers (
  ground_transport_id uuid not null references ground_transport (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  seat text,
  primary key (ground_transport_id, user_id)
);

create or replace function ground_transport_tour_id(p_id uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select tour_id from ground_transport where id = p_id;
$$;

create or replace function is_ground_transport_passenger(p_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from ground_transport_passengers where ground_transport_id = p_id and user_id = p_user_id
  );
$$;

alter table ground_transport enable row level security;
alter table ground_transport_passengers enable row level security;

create policy "ground_transport readable by managers" on ground_transport
  for select using (is_tour_manager(tour_id, auth.uid()));
create policy "ground_transport readable by assigned passenger" on ground_transport
  for select using (is_ground_transport_passenger(id, auth.uid()));
create policy "ground_transport writable by managers" on ground_transport
  for insert with check (is_tour_manager(tour_id, auth.uid()));
create policy "ground_transport updatable by managers" on ground_transport
  for update using (is_tour_manager(tour_id, auth.uid()));
create policy "ground_transport deletable by managers" on ground_transport
  for delete using (is_tour_manager(tour_id, auth.uid()));

create policy "ground_transport_passengers readable by self or manager" on ground_transport_passengers
  for select using (
    user_id = auth.uid() or is_tour_manager(ground_transport_tour_id(ground_transport_id), auth.uid())
  );
create policy "ground_transport_passengers writable by managers" on ground_transport_passengers
  for insert with check (is_tour_manager(ground_transport_tour_id(ground_transport_id), auth.uid()));
create policy "ground_transport_passengers deletable by managers" on ground_transport_passengers
  for delete using (is_tour_manager(ground_transport_tour_id(ground_transport_id), auth.uid()));

-- ============================================================================
-- ADVANCING — one structured advance sheet per show date, fixed named
-- sections (not a generic checklist item list — advance sheets need
-- specific categories, not an arbitrary to-do list). Visibility/edit
-- rights mirror can_view/can_edit_schedule_item's exact pattern (0003).
-- No resource_shares wiring in this pass — cheap to add later if needed,
-- not needed yet.
-- ============================================================================
create type advance_status as enum ('not_started', 'in_progress', 'confirmed');

create table advances (
  id uuid primary key default gen_random_uuid(),
  tour_date_id uuid not null references tour_dates (id) on delete cascade,
  department tour_department not null default 'tour_management',
  status advance_status not null default 'not_started',
  visible_to_all boolean not null default true,
  power_notes text,
  hospitality_notes text,
  schedule_notes text,
  parking_notes text,
  security_notes text,
  other_notes text,
  updated_by uuid references profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now(),
  unique (tour_date_id)
);

create or replace function can_view_advance(p_advance_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from advances a join tour_dates td on td.id = a.tour_date_id
    where a.id = p_advance_id
      and (
        a.visible_to_all
        or is_tour_manager(td.tour_id, p_user_id)
        or department_on_tour(td.tour_id, p_user_id) = a.department
      )
  );
$$;

create or replace function can_edit_advance(p_advance_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from advances a
      join tour_dates td on td.id = a.tour_date_id
      join tours t on t.id = td.tour_id
    where a.id = p_advance_id
      and (
        is_org_admin(t.organization_id, p_user_id)
        or is_tour_manager(td.tour_id, p_user_id)
        or department_on_tour(td.tour_id, p_user_id) = a.department
      )
  );
$$;

alter table advances enable row level security;

create policy "advances readable per visibility rules" on advances
  for select using (can_view_advance(id, auth.uid()));
create policy "advances insertable by owning department or managers" on advances
  for insert with check (
    is_tour_manager((select tour_id from tour_dates where id = advances.tour_date_id), auth.uid())
    or department_on_tour((select tour_id from tour_dates where id = advances.tour_date_id), auth.uid()) = department
  );
create policy "advances updatable per edit rights" on advances
  for update using (can_edit_advance(id, auth.uid()));
create policy "advances deletable per edit rights" on advances
  for delete using (can_edit_advance(id, auth.uid()));

-- ============================================================================
-- SETTLEMENTS — flat manager-only visibility, mirroring budget_items
-- exactly (0001) rather than a department-nuanced model: settlement
-- numbers are inherently a finance/manager-tier concern the same way
-- budget already is, not one department's editable domain the way a
-- checklist or advance section naturally is.
-- ============================================================================
create table settlements (
  id uuid primary key default gen_random_uuid(),
  tour_date_id uuid not null references tour_dates (id) on delete cascade,
  guarantee numeric(12,2),
  ticket_count integer,
  ticket_price numeric(12,2),
  expenses numeric(12,2),
  net_to_artist numeric(12,2),
  notes text,
  settled_by uuid references profiles (id) on delete set null,
  settled_at timestamptz,
  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now(),
  unique (tour_date_id)
);

alter table settlements enable row level security;

create policy "settlements readable by managers only" on settlements
  for select using (
    exists (select 1 from tour_dates td where td.id = settlements.tour_date_id and is_tour_manager(td.tour_id, auth.uid()))
  );
create policy "settlements writable by managers only" on settlements
  for insert with check (
    is_tour_manager((select tour_id from tour_dates where id = settlements.tour_date_id), auth.uid())
  );
create policy "settlements updatable by managers only" on settlements
  for update using (
    exists (select 1 from tour_dates td where td.id = settlements.tour_date_id and is_tour_manager(td.tour_id, auth.uid()))
  );
create policy "settlements deletable by managers only" on settlements
  for delete using (
    exists (select 1 from tour_dates td where td.id = settlements.tour_date_id and is_tour_manager(td.tour_id, auth.uid()))
  );

-- ============================================================================
-- TOUR-EXPORTS storage bucket — ICS calendar export. Generate-and-open-
-- immediately, no backing metadata table (nothing to list later). Gated
-- by is_tour_member, not is_tour_manager, since exporting is just
-- re-delivering a person's own already-RLS-filtered schedule view as a
-- file, not a new visibility grant.
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('tour-exports', 'tour-exports', false)
on conflict (id) do nothing;

create policy "tour exports readable by tour members" on storage.objects
  for select using (
    bucket_id = 'tour-exports' and is_tour_member(((string_to_array(name, '/'))[1])::uuid, auth.uid())
  );
create policy "tour exports writable by tour members" on storage.objects
  for insert with check (
    bucket_id = 'tour-exports' and is_tour_member(((string_to_array(name, '/'))[1])::uuid, auth.uid())
  );
create policy "tour exports deletable by tour members" on storage.objects
  for delete using (
    bucket_id = 'tour-exports' and is_tour_member(((string_to_array(name, '/'))[1])::uuid, auth.uid())
  );

-- ============================================================================
-- COMPLETION LOCK — extend enforce_tour_not_locked() with the three new
-- tour-scoped tables (full function body copied forward from 0021, not a
-- diff — CREATE OR REPLACE needs the whole thing every time).
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
    'checklists', 'ground_transport'
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

create trigger lock_completed_tour before insert or update or delete on ground_transport
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on ground_transport_passengers
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on advances
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on settlements
  for each row execute function enforce_tour_not_locked();
