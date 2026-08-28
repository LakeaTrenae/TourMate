-- Stripe seat-based subscription billing.
--
-- organizations.subscription_plan/subscription_status/subscription_renews_at/
-- billing_customer_id already existed (0001_init.sql) as provider-agnostic
-- placeholders — reused as-is, not renamed. This migration adds the
-- Stripe-specific columns, the trial clock, the hard-lock enforcement
-- (layered into the existing RLS helper chokepoints rather than touching
-- every policy individually), and a live seat-count RPC.
--
-- SEAT DEFINITION: distinct users across all of an organization's tours'
-- tour_members rows — NOT organization_members (which today only ever
-- contains the org creator; there is no "invite to org directly" flow).
--
-- LOCK MODEL: hard lock. An org with no active trial and no active paid
-- subscription loses access to its tour-scoped operational data entirely,
-- enforced at the Postgres level (not just hidden in the UI) — matching
-- this schema's stated security model (0001_init.sql header).

-- ============================================================================
-- 1. New columns on organizations
-- ============================================================================
alter table organizations
  add column trial_ends_at timestamptz,
  add column stripe_subscription_id text,
  add column subscription_interval text check (subscription_interval in ('monthly', 'annual')),
  add column stripe_price_id text;

-- New orgs start on a trial by default (previously defaulted to 'none',
-- which under org_billing_active below would mean "locked from the
-- moment of creation" — handle_new_organization sets the actual clock).
alter table organizations alter column subscription_status set default 'trialing';

-- BACKWARD COMPATIBILITY: every org that already exists predates billing
-- entirely and has subscription_status='none'/trial_ends_at=null — under
-- org_billing_active (below) that reads as "locked," which would hard-lock
-- every pre-existing org the instant this migration runs. Grandfather them
-- into a 30-day trial (deliberately longer than the standard 7-day trial
-- new orgs get from handle_new_organization) so nothing already in use
-- breaks unannounced; the org owner still needs to actually subscribe
-- before that window closes.
update organizations
  set subscription_status = 'trialing', trial_ends_at = now() + interval '30 days'
  where subscription_status = 'none' and trial_ends_at is null;

-- ============================================================================
-- 2. Trial clock on org creation
-- ============================================================================
-- Full body copied forward from 0008_org_creation_and_existing_user_invites.sql,
-- per this schema's established CREATE OR REPLACE convention — only the
-- trial_ends_at line is new.
create or replace function handle_new_organization()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into organization_members (organization_id, user_id, role, joined_at)
  values (new.id, new.created_by, 'owner', now());

  update organizations
    set trial_ends_at = now() + interval '7 days'
    where id = new.id;

  return new;
end;
$$;

-- ============================================================================
-- 3. Lock enforcement — layered into the existing chokepoint helpers
-- ============================================================================
-- org_billing_active is the actual lock predicate. 'trialing' counts as
-- active access only while trial_ends_at is still in the future — checked
-- live rather than relying on a cron job to flip the stored status at the
-- exact expiry instant.
create or replace function org_billing_active(p_org_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select case o.subscription_status
       when 'active'   then true
       when 'trialing' then o.trial_ends_at is not null and o.trial_ends_at > now()
       else false -- past_due, canceled, none
     end
     from organizations o where o.id = p_org_id),
    false
  );
$$;

-- effective_tour_role is THE chokepoint (verified by reading every helper
-- and counting policy call sites, not just grep) — is_tour_member and
-- is_tour_manager are both one-line wrappers around it, and together the
-- three account for ~119 policy references across every tour-scoped
-- table in this schema. Patching this one function locks all of them
-- with zero edits to any individual policy.
--
-- Deliberately NOT touched: is_member_of_org / is_org_admin / is_org_manager
-- (0007_fix_organization_members_recursion.sql) — those gate organizations'
-- and organization_members' OWN policies. If billing-lock logic were baked
-- into those instead, a locked org's own row (and the ability to know who
-- its owner is) would become unreadable the moment it locks, which is a
-- dead end for ever rendering a "subscribe to continue" screen at all.
create or replace function effective_tour_role(p_tour_id uuid, p_user_id uuid)
returns org_role
language sql
stable
security definer
set search_path = public
as $$
  select case
    when org_billing_active((select organization_id from tours where id = p_tour_id))
    then coalesce(
      (select role from tour_members where tour_id = p_tour_id and user_id = p_user_id),
      (select om.role from tours t
         join organization_members om on om.organization_id = t.organization_id
         where t.id = p_tour_id and om.user_id = p_user_id)
    )
    else null
  end;
$$;

-- department_on_tour gates the "owning department" bypass branches used by
-- schedule_items/checklists/advances/tour_invites — patched the same way
-- so those close too, without touching each of those policies directly.
create or replace function department_on_tour(p_tour_id uuid, p_user_id uuid)
returns tour_department
language sql
stable
security definer
set search_path = public
as $$
  select case
    when org_billing_active((select organization_id from tours where id = p_tour_id))
    then coalesce(
      (select department from tour_members where tour_id = p_tour_id and user_id = p_user_id),
      'general'::tour_department
    )
    else null
  end;
$$;

-- The handful of org-scoped-but-operational policies that route through
-- is_org_manager directly (not through effective_tour_role, so the patch
-- above doesn't reach them) — individually edited, full body copied
-- forward. Confirmed by reading 0007 and 0026 directly: this is the
-- complete list of is_org_manager-gated write policies outside
-- organizations/organization_members themselves.
drop policy "venues writable by org managers" on venues;
create policy "venues writable by org managers" on venues
  for insert with check (is_org_manager(organization_id, auth.uid()) and org_billing_active(organization_id));

drop policy "venues updatable by org managers" on venues;
create policy "venues updatable by org managers" on venues
  for update using (is_org_manager(organization_id, auth.uid()) and org_billing_active(organization_id));

drop policy "tours writable by managers" on tours;
create policy "tours writable by managers" on tours
  for insert with check (is_org_manager(organization_id, auth.uid()) and org_billing_active(organization_id));

drop policy "venue_photos insertable by org managers" on venue_photos;
create policy "venue_photos insertable by org managers" on venue_photos
  for insert with check (
    is_org_manager(venue_organization_id(venue_id), auth.uid())
    and org_billing_active(venue_organization_id(venue_id))
  );

drop policy "venue_photos deletable by org managers" on venue_photos;
create policy "venue_photos deletable by org managers" on venue_photos
  for delete using (
    is_org_manager(venue_organization_id(venue_id), auth.uid())
    and org_billing_active(venue_organization_id(venue_id))
  );

drop policy "venue photos writable by org managers" on storage.objects;
create policy "venue photos writable by org managers" on storage.objects
  for insert with check (
    bucket_id = 'venue-photos'
    and is_org_manager(((string_to_array(name, '/'))[1])::uuid, auth.uid())
    and org_billing_active(((string_to_array(name, '/'))[1])::uuid)
  );

drop policy "venue photos deletable by org managers" on storage.objects;
create policy "venue photos deletable by org managers" on storage.objects
  for delete using (
    bucket_id = 'venue-photos'
    and is_org_manager(((string_to_array(name, '/'))[1])::uuid, auth.uid())
    and org_billing_active(((string_to_array(name, '/'))[1])::uuid)
  );

-- KNOWN, DELIBERATE GAPS (documented, not an oversight — see plan): raw
-- `user_id = auth.uid()` policies with no role-helper involvement stay
-- readable after lockout — flights/lodging/ground_transport_passengers'
-- "assigned self" branches, passport_visa_info/emergency_contact_info
-- (personal data, arguably correct to leave accessible regardless of org
-- billing status), and profiles' fellow-member directory read. None of
-- these let a locked org create new operational data or see anything
-- beyond a single row a member was already personally attached to before
-- lockout. Revisit only if "hard lock" must mean literally zero residual
-- read access.

-- ============================================================================
-- 4. Live seat count
-- ============================================================================
-- "Seat" = distinct users across every tour under this org, not literal
-- organization_members rows (which today only ever contains the org
-- creator). No cached column — computed live everywhere it's needed
-- (BillingScreen, create-checkout-session) since the client call sites
-- that could keep a cache fresh don't cover the majority case (a brand
-- new signup's handle_new_user trigger attaching a pending invite with
-- no screen open to resync from).
create or replace function compute_org_seat_count(p_org_id uuid)
returns integer
language sql stable security definer set search_path = public
as $$
  select case when is_member_of_org(p_org_id, auth.uid())
    then (
      select count(distinct tm.user_id)::int
      from tour_members tm
      join tours t on t.id = tm.tour_id
      where t.organization_id = p_org_id
    )
    else null
  end;
$$;
