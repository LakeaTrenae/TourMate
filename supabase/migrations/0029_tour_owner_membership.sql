-- The tour creator never got an explicit tour_members row — they only
-- ever had tour access via the org-level role fallback in
-- effective_tour_role (0001: "coalesce(tour_members.role,
-- organization_members.role)"). That's enough for every RLS check to
-- pass, but it means the creator never actually shows up in the tour's
-- own roster: not in fetchTourRoster (used everywhere someone gets
-- picked from a list — flight/ground-transport passengers, artist team
-- members, document-sharing checkboxes, lodging occupants...), not in
-- Directory, not in ManageTeam. "Once people get added to the tour
-- everyone's name should populate" — the tour creator is the one person
-- who was never actually "added."
--
-- This also fixes a real, separate latent bug: is_tour_owner (used for
-- the completion-lock override — "only the tour owner can make further
-- changes" once a tour is locked) resolves through the same fallback.
-- An org admin/manager (not owner) who creates a tour was never actually
-- that tour's "owner" by this definition — only their ORG-level role
-- mattered, so they could get locked out of their own tour once it
-- completed. Explicitly making the creator that tour's owner via
-- tour_members (which effective_tour_role prioritizes over the org
-- fallback) matches the "one tour-level go-to admin with total control"
-- design this app has had from the start.
--
-- security definer for the same reason handle_new_organization (0008)
-- is: tour_members' own insert policy requires is_tour_manager, which is
-- impossible to satisfy for a brand-new tour that has no members yet.
create or replace function handle_new_tour()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.created_by is not null then
    insert into tour_members (tour_id, user_id, role, department)
    values (new.id, new.created_by, 'owner', 'general')
    on conflict (tour_id, user_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger on_tour_created
  after insert on tours
  for each row execute function handle_new_tour();

-- Backfill: any tour created before this migration is still missing its
-- creator's tour_members row.
insert into tour_members (tour_id, user_id, role, department)
select t.id, t.created_by, 'owner', 'general'
from tours t
where t.created_by is not null
  and not exists (
    select 1 from tour_members tm where tm.tour_id = t.id and tm.user_id = t.created_by
  )
on conflict (tour_id, user_id) do nothing;
