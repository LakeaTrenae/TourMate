-- Per-user billing rearchitecture — replaces org-level seat-based billing
-- (0034/0035/0036) with Master Tour's real model: crew/view-only access is
-- free and unlimited forever; anyone who needs edit/planning-tier access
-- (owner/admin/manager) pays their OWN individual subscription, which
-- follows them across every org and tour they belong to — not scoped to
-- one org. $74.99/mo, or $64.99/mo billed annually ($779.88/yr), 7-day
-- trial, no card required.
--
-- LOCK MODEL CHANGE: the old org-level "hard lock" (effective_tour_role
-- returns null for EVERYONE on a locked org's tours) is replaced by a
-- per-user "soft demote" — a specific person whose own subscription has
-- lapsed just falls back to 'crew' (free, view-only) for every tour they
-- touch, while their real stored role and everyone else's access are
-- completely unaffected. This mirrors Master Tour's actual behavior
-- ("Access Only" is always free) and what was explicitly decided for this
-- app: a lapsed manager loses manager access, not tour access entirely.
--
-- organizations' billing columns (subscription_status, trial_ends_at,
-- stripe_subscription_id, subscription_interval, stripe_price_id,
-- billing_customer_id, trial_warning_sent_at, subscription_renews_at) are
-- deliberately left in place, unused, rather than dropped — a destructive
-- column drop has no upside here and forecloses an easy rollback.

-- ============================================================================
-- 1. New billing columns on profiles (mirrors what organizations had)
-- ============================================================================
alter table profiles
  add column subscription_status subscription_status not null default 'trialing',
  add column trial_ends_at timestamptz,
  add column stripe_customer_id text,
  add column stripe_subscription_id text,
  add column subscription_interval text check (subscription_interval in ('monthly', 'annual')),
  add column stripe_price_id text,
  add column trial_warning_sent_at timestamptz;

-- Grandfather every existing user into a fresh 7-day trial as of this
-- migration — nobody who's already signed up should find themselves
-- retroactively "expired" the instant this ships.
update profiles set trial_ends_at = now() + interval '7 days' where trial_ends_at is null;

-- ============================================================================
-- 2. Trial clock on signup — full body copied forward from 0006_profile_names.sql
-- per this schema's established CREATE OR REPLACE convention; only the
-- trial_ends_at value on the insert is new.
-- ============================================================================
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  inv record;
  v_first_name text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'first_name', '')), '');
  v_last_name text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'last_name', '')), '');
begin
  insert into public.profiles (id, full_name, first_name, last_name, email, trial_ends_at)
  values (
    new.id,
    trim(both ' ' from (coalesce(v_first_name, '') || ' ' || coalesce(v_last_name, ''))),
    v_first_name,
    v_last_name,
    new.email,
    now() + interval '7 days'
  );

  for inv in
    select * from tour_invites where email = new.email and status = 'pending'
  loop
    insert into tour_members (tour_id, user_id, role, department)
    values (inv.tour_id, new.id, inv.role, inv.department)
    on conflict (tour_id, user_id) do nothing;

    update tour_invites set status = 'accepted', accepted_by = new.id where id = inv.id;
  end loop;

  return new;
end;
$$;

-- ============================================================================
-- 3. Per-user lock predicate, replacing org_billing_active
-- ============================================================================
create or replace function user_billing_active(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select case p.subscription_status
       when 'active'   then true
       when 'trialing' then p.trial_ends_at is not null and p.trial_ends_at > now()
       else false -- past_due, canceled, none
     end
     from profiles p where p.id = p_user_id),
    false
  );
$$;

-- ============================================================================
-- 4. effective_tour_role — soft-demote instead of org-wide hard lock
-- ============================================================================
-- Same chokepoint as before (is_tour_member/is_tour_manager wrap this, and
-- together they're referenced by ~123 policies) — only the OUTCOME changes.
-- Previously: org locked -> null for everyone. Now: this specific user's
-- own billing lapsed -> they get 'crew' instead of their real role. Crew
-- was never billing-gated and stays that way (always free, per Master
-- Tour's real model) — everyone else on the same tour is untouched.
create or replace function effective_tour_role(p_tour_id uuid, p_user_id uuid)
returns org_role
language sql
stable
security definer
set search_path = public
as $$
  select case
    when real_role is null then null
    when real_role = 'crew' then 'crew'
    when user_billing_active(p_user_id) then real_role
    else 'crew'
  end
  from (
    select coalesce(
      (select role from tour_members where tour_id = p_tour_id and user_id = p_user_id),
      (select om.role from tours t
         join organization_members om on om.organization_id = t.organization_id
         where t.id = p_tour_id and om.user_id = p_user_id)
    ) as real_role
  ) x;
$$;

-- department_on_tour reverts to its pre-billing (0003) behavior — no
-- billing gate at all. Department is a view-scoping concept (checklist/
-- schedule-item visibility), not an edit permission, and crew — who are
-- always free under this model — need it to resolve correctly regardless
-- of anyone's subscription state.
create or replace function department_on_tour(p_tour_id uuid, p_user_id uuid)
returns tour_department
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select department from tour_members where tour_id = p_tour_id and user_id = p_user_id),
    'general'::tour_department
  );
$$;

-- ============================================================================
-- 5. Individually-patched policies — swap the org-level check for the
-- acting user's own billing status. Same 7 policies 0034 touched.
-- ============================================================================
drop policy "venues writable by org managers" on venues;
create policy "venues writable by org managers" on venues
  for insert with check (is_org_manager(organization_id, auth.uid()) and user_billing_active(auth.uid()));

drop policy "venues updatable by org managers" on venues;
create policy "venues updatable by org managers" on venues
  for update using (is_org_manager(organization_id, auth.uid()) and user_billing_active(auth.uid()));

drop policy "tours writable by managers" on tours;
create policy "tours writable by managers" on tours
  for insert with check (is_org_manager(organization_id, auth.uid()) and user_billing_active(auth.uid()));

drop policy "venue_photos insertable by org managers" on venue_photos;
create policy "venue_photos insertable by org managers" on venue_photos
  for insert with check (
    is_org_manager(venue_organization_id(venue_id), auth.uid())
    and user_billing_active(auth.uid())
  );

drop policy "venue_photos deletable by org managers" on venue_photos;
create policy "venue_photos deletable by org managers" on venue_photos
  for delete using (
    is_org_manager(venue_organization_id(venue_id), auth.uid())
    and user_billing_active(auth.uid())
  );

drop policy "venue photos writable by org managers" on storage.objects;
create policy "venue photos writable by org managers" on storage.objects
  for insert with check (
    bucket_id = 'venue-photos'
    and is_org_manager(((string_to_array(name, '/'))[1])::uuid, auth.uid())
    and user_billing_active(auth.uid())
  );

drop policy "venue photos deletable by org managers" on storage.objects;
create policy "venue photos deletable by org managers" on storage.objects
  for delete using (
    bucket_id = 'venue-photos'
    and is_org_manager(((string_to_array(name, '/'))[1])::uuid, auth.uid())
    and user_billing_active(auth.uid())
  );

-- ============================================================================
-- 6. Retire org-level billing helpers that no longer have a caller
-- ============================================================================
-- Safe to drop: compute_org_seat_count and my_organizations_billing_status
-- were only ever called from the org-seat billing screens/functions being
-- replaced in this same release (BillingScreen, sync-org-seats,
-- create-checkout-session, TourListScreen's locked-org banner) — all of
-- which are being rewritten in this change. org_billing_active has no
-- remaining callers once the policies above are repointed.
drop function if exists compute_org_seat_count(uuid);
drop function if exists my_organizations_billing_status();
drop function if exists org_billing_active(uuid);

-- ============================================================================
-- 7. New self-service billing-status RPC for the client
-- ============================================================================
-- Trivial by design — a profile is always self-readable, so this needs no
-- security-definer bypass logic beyond returning the caller's own row.
-- Replaces my_organizations_billing_status() for the "should I show an
-- upgrade prompt" UI check (see TourListScreen).
create or replace function my_billing_status()
returns table (subscription_status subscription_status, trial_ends_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select p.subscription_status, p.trial_ends_at
  from profiles p
  where p.id = auth.uid();
$$;
