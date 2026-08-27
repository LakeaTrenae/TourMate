-- A plain tour manager could previously invite someone as 'owner' or
-- 'admin' via tour_invites — handing out the tour's ultimate authority
-- tier wasn't actually gated beyond "is some kind of manager." Granting
-- owner/admin now requires already holding owner/admin authority
-- yourself (org owner/admin, or this specific tour's owner); granting
-- manager/crew keeps the existing rule (tour manager tier, or a
-- department owner inviting into their own department).
drop policy "tour_invites insertable by managers or department owner" on tour_invites;
create policy "tour_invites insertable by managers or department owner" on tour_invites
  for insert with check (
    invited_by = auth.uid()
    and (
      (
        role in ('owner', 'admin')
        and (
          is_org_admin((select organization_id from tours where id = tour_invites.tour_id), auth.uid())
          or is_tour_owner(tour_id, auth.uid())
        )
      )
      or (
        role in ('manager', 'crew')
        and (is_tour_manager(tour_id, auth.uid()) or department_on_tour(tour_id, auth.uid()) = department)
      )
    )
  );