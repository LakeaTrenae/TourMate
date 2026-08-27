-- Fixes "infinite recursion detected in policy for relation
-- organization_members" (Postgres error 42P17).
--
-- ROOT CAUSE: organization_members' own RLS policies (from 0002) contain a
-- subquery that selects from organization_members itself:
--
--   create policy "org_members readable by fellow members" on organization_members
--     for select using (
--       exists (select 1 from organization_members me where ...)
--     );
--
-- Evaluating that policy requires running the inner SELECT, which is
-- itself subject to RLS on organization_members — which means evaluating
-- the same policy again, forever. This is different from the helper
-- functions used everywhere else in this schema (is_tour_manager,
-- effective_tour_role, is_org_admin, etc.): those are `security definer`,
-- so their internal queries run as the function owner and bypass RLS
-- entirely rather than re-triggering policy evaluation. The bug was that
-- 0002 used a raw inline subquery instead of a security-definer function
-- for organization_members' own policies — plus a handful of other
-- policies elsewhere (organizations, tours, venues, profiles) that also
-- queried organization_members directly instead of going through
-- is_org_admin. Anything that touched organization_members via a raw
-- subquery inherited the same failure the moment it hit the broken
-- policy underneath.
--
-- FIX: two more security-definer helpers (is_member_of_org for "any
-- role," is_org_manager for "owner/admin/manager tier," alongside the
-- existing is_org_admin for "owner/admin only"), and every affected
-- policy rewritten to call them instead of subquerying
-- organization_members directly.

create or replace function is_member_of_org(p_org_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from organization_members
    where organization_id = p_org_id and user_id = p_user_id
  );
$$;

create or replace function is_org_manager(p_org_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from organization_members
    where organization_id = p_org_id and user_id = p_user_id
      and role in ('owner', 'admin', 'manager')
  );
$$;

-- ============================================================================
-- ORGANIZATION_MEMBERS — the actual source of the recursion.
-- ============================================================================
drop policy "org_members readable by fellow members" on organization_members;
create policy "org_members readable by fellow members" on organization_members
  for select using (is_member_of_org(organization_id, auth.uid()));

drop policy "org_members insertable by owner/admin" on organization_members;
create policy "org_members insertable by owner/admin" on organization_members
  for insert with check (is_org_admin(organization_id, auth.uid()));

drop policy "org_members updatable by owner/admin" on organization_members;
create policy "org_members updatable by owner/admin" on organization_members
  for update using (is_org_admin(organization_id, auth.uid()));

drop policy "org_members deletable by owner/admin or self" on organization_members;
create policy "org_members deletable by owner/admin or self" on organization_members
  for delete using (
    user_id = auth.uid() or is_org_admin(organization_id, auth.uid())
  );

-- ============================================================================
-- ORGANIZATIONS — read this table's own policies didn't self-recurse, but
-- they queried the broken organization_members raw, so they still failed.
-- ============================================================================
drop policy "org readable by members" on organizations;
create policy "org readable by members" on organizations
  for select using (is_member_of_org(id, auth.uid()));

drop policy "org updatable by owner/admin" on organizations;
create policy "org updatable by owner/admin" on organizations
  for update using (is_org_admin(id, auth.uid()));

-- ============================================================================
-- TOURS — the insert policy checked org role directly instead of via
-- is_org_manager (which didn't exist yet when 0001 was written).
-- ============================================================================
drop policy "tours writable by managers" on tours;
create policy "tours writable by managers" on tours
  for insert with check (is_org_manager(organization_id, auth.uid()));

-- ============================================================================
-- VENUES — same issue, same fix.
-- ============================================================================
drop policy "venues readable by org members" on venues;
create policy "venues readable by org members" on venues
  for select using (is_member_of_org(organization_id, auth.uid()));

drop policy "venues writable by org managers" on venues;
create policy "venues writable by org managers" on venues
  for insert with check (is_org_manager(organization_id, auth.uid()));

drop policy "venues updatable by org managers" on venues;
create policy "venues updatable by org managers" on venues
  for update using (is_org_manager(organization_id, auth.uid()));

-- ============================================================================
-- PROFILES — the "fellow org member" half of this policy joined
-- organization_members to itself raw; rewritten to use is_member_of_org.
-- The "fellow tour member" half (tour_members self-join) is untouched —
-- tour_members' own policies were already security-definer-based and never
-- had this bug.
-- ============================================================================
drop policy "profiles readable by fellow tour or org members" on profiles;
create policy "profiles readable by fellow tour or org members" on profiles
  for select using (
    exists (
      select 1 from tour_members tm1
        join tour_members tm2 on tm1.tour_id = tm2.tour_id
      where tm1.user_id = auth.uid() and tm2.user_id = profiles.id
    )
    or exists (
      select 1 from organization_members om
      where om.user_id = profiles.id and is_member_of_org(om.organization_id, auth.uid())
    )
  );
