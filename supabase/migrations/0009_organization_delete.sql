-- organizations never had a DELETE policy — another real gap, not just a
-- testing convenience. An org owner should legitimately be able to delete
-- their own organization (e.g. closing an account). Deleting an org
-- cascades to everything under it (tours -> tour_dates/flights/lodging/
-- etc, organization_members) via the ON DELETE CASCADE foreign keys
-- already in place from 0001 — no additional cleanup logic needed here.
create policy "organizations deletable by owner/admin" on organizations
  for delete using (is_org_admin(id, auth.uid()));