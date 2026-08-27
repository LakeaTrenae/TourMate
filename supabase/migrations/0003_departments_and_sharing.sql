-- Adds granular, department-owned data + configurable sharing on top of the
-- coarse owner/admin/manager/crew tiers from 0001.
--
-- MODEL:
--   - `role` (org_role, from 0001) = access TIER: how much you see by
--     default. owner/admin/manager all see everything on a tour; crew see
--     only what's assigned/shared to them.
--   - `department` (new, tour_department) = your DOMAIN: what you're
--     actually allowed to EDIT. A tour manager and a production manager
--     are both "manager" tier (same broad view), but only the person in
--     the `production` department can edit production's own items.
--   - `resource_shares` = the explicit, ownable exception list. Whoever can
--     already edit a resource can grant `view` or `edit` to a specific
--     person or to an entire department — this is the backing table for
--     a "choose who can see this" UI control, not just a fixed rule.

-- ============================================================================
-- ENUMS
-- ============================================================================
create type tour_department as enum (
  'production', 'travel', 'artist_relations', 'finance', 'tour_management', 'general'
);
create type share_permission as enum ('view', 'edit');

-- ============================================================================
-- TOUR_MEMBERS: add department (a person's owned domain on this tour)
-- ============================================================================
alter table tour_members
  add column department tour_department not null default 'general';

-- ============================================================================
-- SCHEDULE_ITEMS
-- Granular per-date entries (soundcheck, load-in, meet & greet, press, ...) —
-- more specific than the top-level tour_dates day sheet, each owned by a
-- department and independently shareable.
-- ============================================================================
create table schedule_items (
  id uuid primary key default gen_random_uuid(),
  tour_date_id uuid not null references tour_dates (id) on delete cascade,
  department tour_department not null default 'general', -- who owns/edits this item
  title text not null,
  start_time time,
  end_time time,
  location text,
  notes text,
  visible_to_all boolean not null default true, -- default: whole tour can view
  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now()
);

-- ============================================================================
-- RESOURCE_SHARES
-- Generic ACL exception table. `resource_type` + `resource_id` point at any
-- shareable row (schedule_items today; budget_items/documents can adopt the
-- same pattern later without a new table). Share target is either one
-- specific person OR one whole department, never both.
-- ============================================================================
create table resource_shares (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references tours (id) on delete cascade,
  resource_type text not null,
  resource_id uuid not null,
  shared_with_user_id uuid references profiles (id),
  shared_with_department tour_department,
  permission share_permission not null default 'view',
  granted_by uuid not null references profiles (id),
  created_at timestamptz not null default now(),
  constraint resource_shares_single_target check (
    (shared_with_user_id is not null and shared_with_department is null)
    or (shared_with_user_id is null and shared_with_department is not null)
  )
);

create index resource_shares_lookup on resource_shares (resource_type, resource_id);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- A person's department on a given tour. Defaults to 'general' if they
-- have no explicit tour_members row (e.g. org-role-only participants).
create or replace function department_on_tour(p_tour_id uuid, p_user_id uuid)
returns tour_department
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select department from tour_members where tour_id = p_tour_id and user_id = p_user_id),
    'general'::tour_department
  );
$$;

-- Org owner/admin = ultimate override, independent of tour-level roles.
create or replace function is_org_admin(p_org_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from organization_members om
    where om.organization_id = p_org_id and om.user_id = p_user_id
      and om.role in ('owner', 'admin')
  );
$$;

create or replace function can_view_schedule_item(p_item_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from schedule_items si
      join tour_dates td on td.id = si.tour_date_id
    where si.id = p_item_id
      and (
        si.visible_to_all
        or is_tour_manager(td.tour_id, p_user_id)
        or department_on_tour(td.tour_id, p_user_id) = si.department
        or exists (
          select 1 from resource_shares rs
          where rs.resource_type = 'schedule_item' and rs.resource_id = si.id
            and (
              rs.shared_with_user_id = p_user_id
              or rs.shared_with_department = department_on_tour(td.tour_id, p_user_id)
            )
        )
      )
  );
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
-- ROW LEVEL SECURITY
-- ============================================================================
alter table schedule_items enable row level security;
alter table resource_shares enable row level security;

-- SCHEDULE_ITEMS: view follows can_view_schedule_item (tier OR department OR
-- explicit share OR default-open). Write follows can_edit_schedule_item
-- (owning department OR org admin OR explicit edit share) — a manager
-- outside the owning department can read but this policy will not let them
-- through on insert/update/delete.
create policy "schedule_items readable per visibility rules" on schedule_items
  for select using (can_view_schedule_item(id, auth.uid()));

create policy "schedule_items insertable by owning department or managers" on schedule_items
  for insert with check (
    is_tour_manager((select tour_id from tour_dates where id = schedule_items.tour_date_id), auth.uid())
    or department_on_tour((select tour_id from tour_dates where id = schedule_items.tour_date_id), auth.uid()) = department
  );

create policy "schedule_items updatable per edit rights" on schedule_items
  for update using (can_edit_schedule_item(id, auth.uid()));

create policy "schedule_items deletable per edit rights" on schedule_items
  for delete using (can_edit_schedule_item(id, auth.uid()));

-- RESOURCE_SHARES: tour managers can see all shares on their tour (needed
-- to audit who's been granted what); the person a resource was shared with
-- can see that they have it; only someone who can already EDIT a resource
-- can create a new share for it — you can't hand out access you don't have.
create policy "resource_shares readable by managers or the sharee" on resource_shares
  for select using (
    is_tour_manager(tour_id, auth.uid())
    or granted_by = auth.uid()
    or shared_with_user_id = auth.uid()
  );

create policy "resource_shares insertable by resource owner" on resource_shares
  for insert with check (
    granted_by = auth.uid()
    and (
      (resource_type = 'schedule_item' and can_edit_schedule_item(resource_id, auth.uid()))
      -- add one branch per resource type as more tables adopt sharing
    )
  );

create policy "resource_shares deletable by owner or managers" on resource_shares
  for delete using (
    is_tour_manager(tour_id, auth.uid())
    or (resource_type = 'schedule_item' and can_edit_schedule_item(resource_id, auth.uid()))
  );