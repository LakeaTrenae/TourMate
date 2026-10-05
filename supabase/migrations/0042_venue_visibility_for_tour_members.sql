-- Fixes a real, pre-existing visibility gap found while testing the
-- Route screen live: venues/venue_photos have only ever been readable by
-- ORG members (is_member_of_org), but this app's actual invite flow
-- (tour_invites -> tour_members, AddTourMemberScreen/InviteMemberScreen)
-- never creates an organization_members row — confirmed directly against
-- live data. That means anyone invited to a TOUR rather than the org
-- itself (the overwhelming majority of real users: managers, crew,
-- everyone who isn't literally the org creator) has never been able to
-- see venue names, addresses, coordinates, tech specs, contacts, or
-- photos for ANY show — Route, Show Detail, weather, advancing, all of
-- it silently rendering "No venue set" instead of a real error, which is
-- exactly why this went unnoticed rather than throwing something obvious.
--
-- Fix: readable by org members OR by anyone who's a member of some tour
-- under that org (is_tour_member — the same per-tour membership check
-- every other tour-scoped table already uses). Write/insert/delete
-- policies are deliberately UNCHANGED and stay is_org_manager-gated —
-- venues are a shared, reusable-across-tours resource, so editing one
-- should stay an org-level action, not something any single tour's
-- manager can do unilaterally. Only read access is being widened here.
drop policy "venues readable by org members" on venues;
create policy "venues readable by org or tour members" on venues
  for select using (
    is_member_of_org(organization_id, auth.uid())
    or exists (select 1 from tours t where t.organization_id = venues.organization_id and is_tour_member(t.id, auth.uid()))
  );

drop policy "venue_photos readable by org members" on venue_photos;
create policy "venue_photos readable by org or tour members" on venue_photos
  for select using (
    is_member_of_org(venue_organization_id(venue_id), auth.uid())
    or exists (
      select 1 from tours t
      where t.organization_id = venue_organization_id(venue_id) and is_tour_member(t.id, auth.uid())
    )
  );

drop policy "venue photos readable by org members" on storage.objects;
create policy "venue photos readable by org or tour members" on storage.objects
  for select using (
    bucket_id = 'venue-photos'
    and (
      is_member_of_org(((string_to_array(name, '/'))[1])::uuid, auth.uid())
      or exists (
        select 1 from tours t
        where t.organization_id = ((string_to_array(name, '/'))[1])::uuid and is_tour_member(t.id, auth.uid())
      )
    )
  );
