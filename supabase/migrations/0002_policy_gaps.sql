-- Fills RLS policy gaps left in 0001_init.sql.
--
-- 0001 enabled RLS on every table (correct — deny by default) but a few
-- tables were left with zero policies, which means *nobody* could read or
-- write them at all, including managers. Two of those
-- (lodging_rooms, lodging_room_occupants) are also referenced inside
-- `lodging`'s own policy via a subquery — and a subquery against an
-- RLS-locked table with no policy returns zero rows for any role, so that
-- policy was silently never matching anyone. This migration closes all of
-- that out.

-- ============================================================================
-- ORGANIZATION_MEMBERS
-- ============================================================================
-- Members can see their fellow members (needed to show a crew/roster list).
create policy "org_members readable by fellow members" on organization_members
  for select using (
    exists (select 1 from organization_members me
            where me.organization_id = organization_members.organization_id
              and me.user_id = auth.uid())
  );

-- Only owner/admin can invite, change someone's role, or remove someone —
-- this is the actual privilege-escalation boundary, so it stays tight.
create policy "org_members insertable by owner/admin" on organization_members
  for insert with check (
    exists (select 1 from organization_members me
            where me.organization_id = organization_members.organization_id
              and me.user_id = auth.uid() and me.role in ('owner', 'admin'))
  );
create policy "org_members updatable by owner/admin" on organization_members
  for update using (
    exists (select 1 from organization_members me
            where me.organization_id = organization_members.organization_id
              and me.user_id = auth.uid() and me.role in ('owner', 'admin'))
  );
-- Deletable by owner/admin, or by the member themselves (leaving the org).
create policy "org_members deletable by owner/admin or self" on organization_members
  for delete using (
    user_id = auth.uid()
    or exists (select 1 from organization_members me
               where me.organization_id = organization_members.organization_id
                 and me.user_id = auth.uid() and me.role in ('owner', 'admin'))
  );

-- ============================================================================
-- TOUR_MEMBERS
-- ============================================================================
create policy "tour_members readable by fellow tour members" on tour_members
  for select using (is_tour_member(tour_id, auth.uid()));
create policy "tour_members insertable by managers" on tour_members
  for insert with check (is_tour_manager(tour_id, auth.uid()));
create policy "tour_members updatable by managers" on tour_members
  for update using (is_tour_manager(tour_id, auth.uid()));
create policy "tour_members deletable by managers" on tour_members
  for delete using (is_tour_manager(tour_id, auth.uid()));

-- ============================================================================
-- VENUES  (org-scoped, reusable across tours for that org)
-- ============================================================================
create policy "venues readable by org members" on venues
  for select using (
    exists (select 1 from organization_members om
            where om.organization_id = venues.organization_id and om.user_id = auth.uid())
  );
create policy "venues writable by org managers" on venues
  for insert with check (
    exists (select 1 from organization_members om
            where om.organization_id = venues.organization_id and om.user_id = auth.uid()
              and om.role in ('owner', 'admin', 'manager'))
  );
create policy "venues updatable by org managers" on venues
  for update using (
    exists (select 1 from organization_members om
            where om.organization_id = venues.organization_id and om.user_id = auth.uid()
              and om.role in ('owner', 'admin', 'manager'))
  );

-- ============================================================================
-- LODGING  (0001 only had select policies — managers had no way to
-- actually create/edit lodging bookings)
-- ============================================================================
create policy "lodging writable by managers" on lodging
  for insert with check (is_tour_manager(tour_id, auth.uid()));
create policy "lodging updatable by managers" on lodging
  for update using (is_tour_manager(tour_id, auth.uid()));

-- ============================================================================
-- LODGING_ROOMS  (had zero policies — needed both directly, and so the
-- `lodging` occupant-visibility subquery can actually see into it)
-- ============================================================================
create policy "lodging_rooms readable by managers" on lodging_rooms
  for select using (
    exists (select 1 from lodging l
            where l.id = lodging_rooms.lodging_id and is_tour_manager(l.tour_id, auth.uid()))
  );
create policy "lodging_rooms readable by assigned occupant" on lodging_rooms
  for select using (
    exists (select 1 from lodging_room_occupants lro
            where lro.room_id = lodging_rooms.id and lro.user_id = auth.uid())
  );
create policy "lodging_rooms writable by managers" on lodging_rooms
  for insert with check (
    exists (select 1 from lodging l
            where l.id = lodging_rooms.lodging_id and is_tour_manager(l.tour_id, auth.uid()))
  );
create policy "lodging_rooms updatable by managers" on lodging_rooms
  for update using (
    exists (select 1 from lodging l
            where l.id = lodging_rooms.lodging_id and is_tour_manager(l.tour_id, auth.uid()))
  );

-- ============================================================================
-- LODGING_ROOM_OCCUPANTS  (same pattern as flight_passengers)
-- ============================================================================
create policy "lodging_room_occupants readable by self or manager" on lodging_room_occupants
  for select using (
    user_id = auth.uid()
    or exists (select 1 from lodging_rooms lr
                 join lodging l on l.id = lr.lodging_id
               where lr.id = lodging_room_occupants.room_id
                 and is_tour_manager(l.tour_id, auth.uid()))
  );
create policy "lodging_room_occupants writable by managers" on lodging_room_occupants
  for insert with check (
    exists (select 1 from lodging_rooms lr
              join lodging l on l.id = lr.lodging_id
            where lr.id = lodging_room_occupants.room_id
              and is_tour_manager(l.tour_id, auth.uid()))
  );
create policy "lodging_room_occupants deletable by managers" on lodging_room_occupants
  for delete using (
    exists (select 1 from lodging_rooms lr
              join lodging l on l.id = lr.lodging_id
            where lr.id = lodging_room_occupants.room_id
              and is_tour_manager(l.tour_id, auth.uid()))
  );

-- ============================================================================
-- FLIGHT_PASSENGERS  (0001 only had select — managers had no way to
-- actually assign someone to a flight)
-- ============================================================================
create policy "flight_passengers writable by managers" on flight_passengers
  for insert with check (
    exists (select 1 from flights f
            where f.id = flight_passengers.flight_id and is_tour_manager(f.tour_id, auth.uid()))
  );
create policy "flight_passengers deletable by managers" on flight_passengers
  for delete using (
    exists (select 1 from flights f
            where f.id = flight_passengers.flight_id and is_tour_manager(f.tour_id, auth.uid()))
  );

-- ============================================================================
-- GUEST_LIST_REQUESTS  (0001 had select + insert; approve/deny needs update)
-- ============================================================================
create policy "guest_list updatable by managers" on guest_list_requests
  for update using (
    exists (select 1 from tour_dates td where td.id = guest_list_requests.tour_date_id
            and is_tour_manager(td.tour_id, auth.uid()))
  );

-- ============================================================================
-- BUDGET_ITEMS  (0001 had select/insert/update; add delete for completeness)
-- ============================================================================
create policy "budget deletable by managers only" on budget_items
  for delete using (is_tour_manager(tour_id, auth.uid()));

-- ============================================================================
-- DOCUMENTS  (0001 had select + insert; managers can also update/delete)
-- ============================================================================
create policy "documents updatable by managers" on documents
  for update using (is_tour_manager(tour_id, auth.uid()));
create policy "documents deletable by managers" on documents
  for delete using (is_tour_manager(tour_id, auth.uid()));
