-- Three additions, all driven by the same request: make each tour its own
-- self-contained network with one true go-to admin, a way to build the
-- roster by name/contact before people even have accounts, and a directory
-- so tour members can actually find and reach each other.

-- ============================================================================
-- 1. TOUR OWNER OVERRIDE — close a gap from 0003.
--
-- can_edit_schedule_item only let ORG owner/admin bypass department
-- restrictions. But the "go-to person for this tour" is a *tour-level*
-- owner (tour_members.role = 'owner'), who may not be the org owner at
-- all (e.g. the tour manager on one specific tour, while the org account
-- belongs to management/label). This makes that role total for the tour
-- it applies to, matching "one admin who can control the entirety of
-- that tour."
-- ============================================================================
create or replace function is_tour_owner(p_tour_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select effective_tour_role(p_tour_id, p_user_id) = 'owner';
$$;

create or replace function can_edit_schedule_item(p_item_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from schedule_items si
      join tour_dates td on td.id = si.tour_date_id
      join tours t on t.id = td.tour_id
    where si.id = p_item_id
      and (
        is_org_admin(t.organization_id, p_user_id)
        or is_tour_owner(td.tour_id, p_user_id)
        or department_on_tour(td.tour_id, p_user_id) = si.department
        or exists (
          select 1 from resource_shares rs
          where rs.resource_type = 'schedule_item' and rs.resource_id = si.id
            and rs.permission = 'edit'
            and (
              rs.shared_with_user_id = p_user_id
              or rs.shared_with_department = department_on_tour(td.tour_id, p_user_id)
            )
        )
      )
  );
$$;

-- ============================================================================
-- 2. TOUR_INVITES — assign roles by name + contact before someone has an
-- account. A tour manager (or a department owner, inviting into their own
-- department only) fills in name/email/phone/role/department; when that
-- person signs up with a matching email, they're auto-attached to the tour
-- with exactly that role/department (see handle_new_user below).
-- ============================================================================
create type invite_status as enum ('pending', 'accepted', 'revoked');

create table tour_invites (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references tours (id) on delete cascade,
  full_name text not null,
  email text not null,
  phone text,
  role org_role not null default 'crew',
  department tour_department not null default 'general',
  status invite_status not null default 'pending',
  invited_by uuid not null references profiles (id),
  accepted_by uuid references profiles (id),
  created_at timestamptz not null default now()
);

create index tour_invites_email_lookup on tour_invites (email) where status = 'pending';

alter table tour_invites enable row level security;

-- Anyone who could already edit that department's data can add more people
-- to it (the production manager can bring on more production people); a
-- tour manager/owner can invite into any department.
create policy "tour_invites readable by managers or department owner" on tour_invites
  for select using (
    is_tour_manager(tour_id, auth.uid())
    or department_on_tour(tour_id, auth.uid()) = department
  );
create policy "tour_invites insertable by managers or department owner" on tour_invites
  for insert with check (
    invited_by = auth.uid()
    and (
      is_tour_manager(tour_id, auth.uid())
      or department_on_tour(tour_id, auth.uid()) = department
    )
  );
create policy "tour_invites updatable by managers or department owner" on tour_invites
  for update using (
    is_tour_manager(tour_id, auth.uid())
    or department_on_tour(tour_id, auth.uid()) = department
  );
create policy "tour_invites deletable by managers or department owner" on tour_invites
  for delete using (
    is_tour_manager(tour_id, auth.uid())
    or department_on_tour(tour_id, auth.uid()) = department
  );

-- ============================================================================
-- Auth wiring: auto-create a profile on signup, and auto-accept any
-- pending invite that matches the new user's email.
--
-- This runs SECURITY DEFINER because it needs to write into `profiles`
-- (which otherwise has no INSERT policy at all — on purpose, so a client
-- can never insert an arbitrary profile row) and into `tour_members` on
-- the new user's behalf. That's the correct, narrow use of a privilege
-- escalation here: it only ever runs as a direct consequence of Supabase
-- Auth creating a new `auth.users` row, never callable directly by a
-- client.
-- ============================================================================
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  inv record;
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email), new.email);

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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================================
-- 3. DIRECTORY — let tour members actually find and contact each other.
--
-- 0001 deliberately locked `profiles` to self-only so a signed-in user
-- couldn't enumerate every person on the platform. This adds a scoped
-- exception: you can see the profile (name, phone, email, avatar) of
-- anyone you actually share a tour or an organization with — not global,
-- just "people you're actually working with." RLS policies of the same
-- command (select) are OR'd together, so this stacks on top of the
-- existing self-only policy rather than replacing it.
-- ============================================================================
create policy "profiles readable by fellow tour or org members" on profiles
  for select using (
    exists (
      select 1 from tour_members tm1
        join tour_members tm2 on tm1.tour_id = tm2.tour_id
      where tm1.user_id = auth.uid() and tm2.user_id = profiles.id
    )
    or exists (
      select 1 from organization_members om1
        join organization_members om2 on om1.organization_id = om2.organization_id
      where om1.user_id = auth.uid() and om2.user_id = profiles.id
    )
  );