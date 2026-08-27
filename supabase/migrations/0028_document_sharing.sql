-- Wires `documents` into the existing generic sharing mechanism
-- (`resource_shares`, 0003) so "who can see this" supports picking
-- specific people or whole departments as an exception on top of the
-- managers_only/org toggle — not just those two blunt options.
--
-- IMPORTANT correctness note (not just the usual recursion concern): the
-- department-share check (`shared_with_department = department_on_tour(...)`)
-- must run through a `security definer` function, not a raw subquery
-- inlined into another table's policy. resource_shares' own SELECT
-- policy ("readable by managers or the sharee") only lets a department-
-- shared row be seen by a manager, the granter, or an exact
-- shared_with_user_id match — a plain crew member the row applies to via
-- their DEPARTMENT would get zero rows back if the check ran as them
-- directly. Wrapping it in security definer makes the internal lookup
-- run with the function's own privileges, bypassing resource_shares'
-- RLS for that internal check — which is also silently why
-- can_view_checklist/can_view_schedule_item already get this right.

create or replace function can_edit_document(p_document_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from documents d where d.id = p_document_id and is_tour_manager(d.tour_id, p_user_id)
  );
$$;

create or replace function is_document_shared_with(p_document_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from resource_shares rs
      join documents d on d.id = p_document_id
    where rs.resource_type = 'document' and rs.resource_id = p_document_id
      and (
        rs.shared_with_user_id = p_user_id
        or rs.shared_with_department = department_on_tour(d.tour_id, p_user_id)
      )
  );
$$;

drop policy "documents readable per visibility" on documents;
create policy "documents readable per visibility" on documents
  for select using (
    is_tour_manager(tour_id, auth.uid())
    or (visibility = 'org' and is_tour_member(tour_id, auth.uid()))
    or (artist_id is not null and is_on_artist_team(artist_id, auth.uid()))
    or is_document_shared_with(id, auth.uid())
  );

drop policy "resource_shares insertable by resource owner" on resource_shares;
create policy "resource_shares insertable by resource owner" on resource_shares
  for insert with check (
    granted_by = auth.uid()
    and (
      (resource_type = 'schedule_item' and can_edit_schedule_item(resource_id, auth.uid()))
      or (resource_type = 'checklist' and can_edit_checklist(resource_id, auth.uid()))
      or (resource_type = 'document' and can_edit_document(resource_id, auth.uid()))
    )
  );

drop policy "resource_shares deletable by owner or managers" on resource_shares;
create policy "resource_shares deletable by owner or managers" on resource_shares
  for delete using (
    is_tour_manager(tour_id, auth.uid())
    or (resource_type = 'schedule_item' and can_edit_schedule_item(resource_id, auth.uid()))
    or (resource_type = 'checklist' and can_edit_checklist(resource_id, auth.uid()))
    or (resource_type = 'document' and can_edit_document(resource_id, auth.uid()))
  );
