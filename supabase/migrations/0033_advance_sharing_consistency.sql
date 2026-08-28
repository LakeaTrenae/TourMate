-- Wires resource_shares into `advances` so it can offer the same
-- 3-option "who can see it" model (Managers + owning department /
-- Everyone on the tour / Specific people or departments) that Documents
-- has (0028) and that Checklists already had from day one (0021's
-- can_view_checklist already includes a resource_shares check) — 0023's
-- own comment explicitly deferred this wiring for advances as "cheap to
-- add later," this is that later.
--
-- can_edit_advance is unchanged and reused as-is — only the view check
-- and resource_shares' own insert/delete policies need the new branch.

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
        or exists (
          select 1 from resource_shares rs
          where rs.resource_type = 'advance' and rs.resource_id = a.id
            and (
              rs.shared_with_user_id = p_user_id
              or rs.shared_with_department = department_on_tour(td.tour_id, p_user_id)
            )
        )
      )
  );
$$;

drop policy "resource_shares insertable by resource owner" on resource_shares;
create policy "resource_shares insertable by resource owner" on resource_shares
  for insert with check (
    granted_by = auth.uid()
    and (
      (resource_type = 'schedule_item' and can_edit_schedule_item(resource_id, auth.uid()))
      or (resource_type = 'checklist' and can_edit_checklist(resource_id, auth.uid()))
      or (resource_type = 'document' and can_edit_document(resource_id, auth.uid()))
      or (resource_type = 'advance' and can_edit_advance(resource_id, auth.uid()))
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
  );
