-- Seven tables were missing a DELETE policy entirely: tour_dates, flights,
-- lodging, guest_list_requests, lodging_rooms, venues, tours. With RLS on
-- and zero policies for a command, that command silently affects zero
-- rows — a DELETE against any of these returns success (204) without
-- actually deleting anything. Found by testing: deleting a duplicate
-- tour_date appeared to succeed, then the duplicate was still there.
--
-- All manager-gated except `tours` itself, which — being the most
-- destructive of the bunch — is restricted to the tour's own owner or an
-- org admin, matching the "ultimate authority" pattern already used for
-- completion-lock overrides and organization deletion.

create policy "tour_dates deletable by managers" on tour_dates
  for delete using (is_tour_manager(tour_id, auth.uid()));

create policy "flights deletable by managers" on flights
  for delete using (is_tour_manager(tour_id, auth.uid()));

create policy "lodging deletable by managers" on lodging
  for delete using (is_tour_manager(tour_id, auth.uid()));

create policy "guest_list deletable by managers" on guest_list_requests
  for delete using (
    exists (
      select 1 from tour_dates td
      where td.id = guest_list_requests.tour_date_id and is_tour_manager(td.tour_id, auth.uid())
    )
  );

create policy "lodging_rooms deletable by managers" on lodging_rooms
  for delete using (is_tour_manager(lodging_tour_id(lodging_id), auth.uid()));

create policy "venues deletable by org managers" on venues
  for delete using (is_org_manager(organization_id, auth.uid()));

create policy "tours deletable by owner or org admin" on tours
  for delete using (is_org_admin(organization_id, auth.uid()) or is_tour_owner(id, auth.uid()));