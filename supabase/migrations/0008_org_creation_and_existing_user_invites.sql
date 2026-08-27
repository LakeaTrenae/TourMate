-- Two gaps found by actually trying to use the app end-to-end:
--
-- 1. `organizations` never had an INSERT policy (0001 only wrote select/
--    update). With RLS on, no policy means no INSERT is possible for
--    anyone — there was literally no way to create the first organization
--    in the app. Fixed by allowing an authenticated user to insert an org
--    with themselves as `created_by`, then auto-adding them as its
--    `owner` via trigger — mirroring the same bootstrapping pattern
--    already used for auth.users -> profiles (handle_new_user).
--
-- 2. `tour_invites` only auto-attached someone on a FUTURE signup
--    (handle_new_user checks tour_invites for a matching pending email).
--    If the invitee already has a TourMate account, that invite would
--    just sit pending forever — the matching trigger only fires once, at
--    account creation. Fixed with a second trigger that checks for an
--    existing profile immediately when the invite itself is created.

-- ============================================================================
-- 1. Organization creation + auto-owner
-- ============================================================================
create policy "organizations insertable by creator" on organizations
  for insert with check (created_by = auth.uid());

create or replace function handle_new_organization()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- security definer because organization_members' own insert policy
  -- requires is_org_admin — which is impossible to satisfy for a
  -- brand-new org that has no members yet. This trigger is the one
  -- legitimate way that first membership row gets created.
  insert into organization_members (organization_id, user_id, role, joined_at)
  values (new.id, new.created_by, 'owner', now());
  return new;
end;
$$;

create trigger on_organization_created
  after insert on organizations
  for each row execute function handle_new_organization();

-- ============================================================================
-- 2. Invite an existing user immediately, not just future signups
-- ============================================================================
create or replace function handle_new_invite()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_existing_user_id uuid;
begin
  select id into v_existing_user_id from profiles where email = new.email;

  if v_existing_user_id is not null then
    insert into tour_members (tour_id, user_id, role, department)
    values (new.tour_id, v_existing_user_id, new.role, new.department)
    on conflict (tour_id, user_id) do nothing;

    update tour_invites set status = 'accepted', accepted_by = v_existing_user_id
      where id = new.id;
  end if;

  return new;
end;
$$;

create trigger on_invite_created
  after insert on tour_invites
  for each row execute function handle_new_invite();
