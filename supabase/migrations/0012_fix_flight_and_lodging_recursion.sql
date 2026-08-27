-- Fixes two more infinite-recursion RLS bugs, same root cause as 0007
-- (organization_members) but this time as CROSS-table cycles rather than
-- a single table referencing itself:
--
-- A) flights <-> flight_passengers: "flights readable by assigned
--    passenger" queries flight_passengers raw; flight_passengers' own
--    policies query flights raw right back. Evaluating either table's
--    policy chases the other's, forever. Found by actually assigning a
--    passenger to a flight in the app (AddFlightScreen) — the flight
--    itself inserted fine, but attaching a passenger recursed.
--
-- B) lodging <-> lodging_rooms <-> lodging_room_occupants: identical
--    shape, three tables deep. "lodging readable by assigned occupant"
--    queries lodging_rooms+lodging_room_occupants raw; lodging_rooms'
--    policies query lodging raw AND lodging_room_occupants raw;
--    lodging_room_occupants' policies query lodging_rooms raw. Every
--    write to any of the three would have hit this the same way.
--
-- FIX: same pattern as 0007 — wrap every cross-table lookup in a
-- `security definer` helper, so the internal read bypasses RLS entirely
-- instead of re-triggering the other table's policy.

-- ============================================================================
-- A) FLIGHTS / FLIGHT_PASSENGERS
-- ============================================================================
create or replace function is_flight_passenger(p_flight_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from flight_passengers where flight_id = p_flight_id and user_id = p_user_id
  );
$$;

create or replace function flight_tour_id(p_flight_id uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select tour_id from flights where id = p_flight_id;
$$;

drop policy "flights readable by assigned passenger" on flights;
create policy "flights readable by assigned passenger" on flights
  for select using (is_flight_passenger(id, auth.uid()));

drop policy "flight_passengers readable by self or manager" on flight_passengers;
create policy "flight_passengers readable by self or manager" on flight_passengers
  for select using (
    user_id = auth.uid() or is_tour_manager(flight_tour_id(flight_id), auth.uid())
  );

drop policy "flight_passengers writable by managers" on flight_passengers;
create policy "flight_passengers writable by managers" on flight_passengers
  for insert with check (is_tour_manager(flight_tour_id(flight_id), auth.uid()));

drop policy "flight_passengers deletable by managers" on flight_passengers;
create policy "flight_passengers deletable by managers" on flight_passengers
  for delete using (is_tour_manager(flight_tour_id(flight_id), auth.uid()));

-- ============================================================================
-- B) LODGING / LODGING_ROOMS / LODGING_ROOM_OCCUPANTS
-- ============================================================================
create or replace function lodging_tour_id(p_lodging_id uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select tour_id from lodging where id = p_lodging_id;
$$;

create or replace function room_tour_id(p_room_id uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select l.tour_id from lodging_rooms lr join lodging l on l.id = lr.lodging_id
  where lr.id = p_room_id;
$$;

create or replace function is_room_occupant(p_room_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from lodging_room_occupants where room_id = p_room_id and user_id = p_user_id
  );
$$;

create or replace function is_lodging_occupant(p_lodging_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from lodging_rooms lr
      join lodging_room_occupants lro on lro.room_id = lr.id
    where lr.lodging_id = p_lodging_id and lro.user_id = p_user_id
  );
$$;

drop policy "lodging readable by assigned occupant" on lodging;
create policy "lodging readable by assigned occupant" on lodging
  for select using (is_lodging_occupant(id, auth.uid()));

drop policy "lodging_rooms readable by managers" on lodging_rooms;
create policy "lodging_rooms readable by managers" on lodging_rooms
  for select using (is_tour_manager(lodging_tour_id(lodging_id), auth.uid()));

drop policy "lodging_rooms readable by assigned occupant" on lodging_rooms;
create policy "lodging_rooms readable by assigned occupant" on lodging_rooms
  for select using (is_room_occupant(id, auth.uid()));

drop policy "lodging_rooms writable by managers" on lodging_rooms;
create policy "lodging_rooms writable by managers" on lodging_rooms
  for insert with check (is_tour_manager(lodging_tour_id(lodging_id), auth.uid()));

drop policy "lodging_rooms updatable by managers" on lodging_rooms;
create policy "lodging_rooms updatable by managers" on lodging_rooms
  for update using (is_tour_manager(lodging_tour_id(lodging_id), auth.uid()));

drop policy "lodging_room_occupants readable by self or manager" on lodging_room_occupants;
create policy "lodging_room_occupants readable by self or manager" on lodging_room_occupants
  for select using (
    user_id = auth.uid() or is_tour_manager(room_tour_id(room_id), auth.uid())
  );

drop policy "lodging_room_occupants writable by managers" on lodging_room_occupants;
create policy "lodging_room_occupants writable by managers" on lodging_room_occupants
  for insert with check (is_tour_manager(room_tour_id(room_id), auth.uid()));

drop policy "lodging_room_occupants deletable by managers" on lodging_room_occupants;
create policy "lodging_room_occupants deletable by managers" on lodging_room_occupants
  for delete using (is_tour_manager(room_tour_id(room_id), auth.uid()));
