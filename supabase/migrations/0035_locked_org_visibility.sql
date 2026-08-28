-- Fixes a real gap found via live REST testing of 0034's lock, not a
-- theoretical one: TourListScreen's "🔒 Billing needed" banner was
-- designed to query organization_members (self) joined to organizations
-- — both deliberately left unpatched by 0034 so a locked org's own row
-- stays readable. But organization_members ONLY EVER contains the org
-- creator (confirmed earlier, and re-confirmed here) — a crew member
-- invited via tour_invites/tour_members never gets an organization_members
-- row at all. And tour_members itself IS gated by the 0034 patch
-- (effective_tour_role/is_tour_member), so once an org locks, a
-- crew-only member has literally no readable table left that tells them
-- why their tours just vanished — the exact "silently vanishes, no
-- explanation" UX the lock banner was built to prevent.
--
-- Fix: a dedicated, deliberately-NOT-billing-gated RPC that reports every
-- org a user belongs to (via organization_members OR tour_members) along
-- with its billing status — its whole purpose is to inform a locked-out
-- user about the lock, so it must keep working precisely when
-- org_billing_active is false.
create or replace function my_organizations_billing_status()
returns table (organization_id uuid, organization_name text, subscription_status subscription_status, trial_ends_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select distinct o.id, o.name, o.subscription_status, o.trial_ends_at
  from organizations o
  where o.id in (
    select organization_id from organization_members where user_id = auth.uid()
    union
    select t.organization_id from tour_members tm join tours t on t.id = tm.tour_id where tm.user_id = auth.uid()
  );
$$;
