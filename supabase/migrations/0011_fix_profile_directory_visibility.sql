-- Fixes profiles being invisible in the People/roster directory in a very
-- common real case: a tour's manager often has no *explicit* tour_members
-- row for it at all (they access it via organization_members fallback —
-- see effective_tour_role), and a crew member added purely via
-- tour_invites has no organization_members row either (only tour_members).
-- The 0004/0007 policy joined tour_members to itself directly on both
-- sides, which only catches two people who BOTH happen to have explicit
-- tour_members rows — missing exactly the manager-viewing-crew case
-- exercised by scripts/seed-test-tour.sh.
--
-- Fix: use the same effective-role-aware helper (is_tour_member) the rest
-- of the schema already relies on, applied per-tour via a new
-- share_a_tour() helper, instead of a raw self-join.

create or replace function share_a_tour(p_user_a uuid, p_user_b uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  -- Scans all tours checking both people's effective membership. Fine at
  -- current scale; if this ever becomes a hot path worth optimizing, the
  -- natural next step is scoping the scan to tours either person has an
  -- explicit tour_members/organization_members row in, rather than every
  -- tour in the database.
  select exists (
    select 1 from tours t
    where is_tour_member(t.id, p_user_a) and is_tour_member(t.id, p_user_b)
  );
$$;

drop policy "profiles readable by fellow tour or org members" on profiles;
create policy "profiles readable by fellow tour or org members" on profiles
  for select using (
    share_a_tour(auth.uid(), profiles.id)
    or exists (
      select 1 from organization_members om
      where om.user_id = profiles.id and is_member_of_org(om.organization_id, auth.uid())
    )
  );
