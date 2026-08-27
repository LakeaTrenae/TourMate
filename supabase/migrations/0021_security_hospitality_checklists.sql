-- Three additions, all requested together:
--
--   1. `security` as a real tour_department, so a security lead can be
--      assigned/tagged the same way production, travel, etc. already are
--      — "who is security" becomes answerable from the roster/directory
--      instead of living in someone's head.
--
--   2. `documents.category`, so contracts/riders/hospitality docs can be
--      tagged and filtered instead of being one undifferentiated pile —
--      the production assistant's rider/hospitality paperwork lives here.
--
--   3. A generic `checklists` / `checklist_items` feature — powers both
--      "venue walkthrough" and "hospitality & rider" checklists (and any
--      future one) without hardcoding either as its own table. Each
--      checklist carries a running `notes` field for exactly the "things
--      to remember to add or remove" scratchpad that was asked for,
--      separate from the itemized checkboxes.
--
-- Visibility/ownership follows the exact pattern schedule_items already
-- established in 0003 (visible_to_all OR department match OR manager OR
-- explicit resource_shares grant) — reusing that model rather than
-- inventing a new one, and reusing resource_shares itself rather than a
-- new sharing table.

-- ============================================================================
-- 1. SECURITY DEPARTMENT
-- ============================================================================
-- ALTER TYPE ... ADD VALUE can't be referenced in the same transaction it
-- runs in on older Postgres — nothing below this statement in this file
-- uses 'security' as a literal, so that's not a problem here.
alter type tour_department add value 'security';

-- ============================================================================
-- 2. DOCUMENT CATEGORIES
-- ============================================================================
create type document_category as enum (
  'general', 'contract', 'rider', 'hospitality', 'itinerary', 'other'
);

alter table documents
  add column category document_category not null default 'general';

-- ============================================================================
-- 3. CHECKLISTS
-- ============================================================================
create table checklists (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references tours (id) on delete cascade,
  -- Optional: a walkthrough checklist is often tied to a specific show
  -- date/venue; a standing hospitality checklist usually isn't. Null
  -- means "applies to the whole tour, not one date."
  tour_date_id uuid references tour_dates (id) on delete cascade,
  title text not null,
  department tour_department not null default 'general', -- who owns/edits this
  visible_to_all boolean not null default true,
  notes text, -- running scratchpad: "remember to add/remove ___"
  created_by uuid references profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table checklist_items (
  id uuid primary key default gen_random_uuid(),
  checklist_id uuid not null references checklists (id) on delete cascade,
  description text not null,
  is_checked boolean not null default false,
  checked_by uuid references profiles (id) on delete set null,
  checked_at timestamptz,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index checklists_tour_id_idx on checklists (tour_id);
create index checklist_items_checklist_id_idx on checklist_items (checklist_id);

-- ---- helper functions, mirroring can_view/can_edit_schedule_item ----
create or replace function can_view_checklist(p_checklist_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from checklists c
    where c.id = p_checklist_id
      and (
        c.visible_to_all
        or is_tour_manager(c.tour_id, p_user_id)
        or department_on_tour(c.tour_id, p_user_id) = c.department
        or exists (
          select 1 from resource_shares rs
          where rs.resource_type = 'checklist' and rs.resource_id = c.id
            and (
              rs.shared_with_user_id = p_user_id
              or rs.shared_with_department = department_on_tour(c.tour_id, p_user_id)
            )
        )
      )
  );
$$;

create or replace function can_edit_checklist(p_checklist_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from checklists c
      join tours t on t.id = c.tour_id
    where c.id = p_checklist_id
      and (
        is_org_admin(t.organization_id, p_user_id)
        or is_tour_manager(c.tour_id, p_user_id)
        or department_on_tour(c.tour_id, p_user_id) = c.department
        or exists (
          select 1 from resource_shares rs
          where rs.resource_type = 'checklist' and rs.resource_id = c.id
            and rs.permission = 'edit'
            and (
              rs.shared_with_user_id = p_user_id
              or rs.shared_with_department = department_on_tour(c.tour_id, p_user_id)
            )
        )
      )
  );
$$;

alter table checklists enable row level security;
alter table checklist_items enable row level security;

create policy "checklists readable per visibility rules" on checklists
  for select using (can_view_checklist(id, auth.uid()));
create policy "checklists insertable by owning department or managers" on checklists
  for insert with check (
    is_tour_manager(tour_id, auth.uid())
    or department_on_tour(tour_id, auth.uid()) = department
  );
create policy "checklists updatable per edit rights" on checklists
  for update using (can_edit_checklist(id, auth.uid()));
create policy "checklists deletable per edit rights" on checklists
  for delete using (can_edit_checklist(id, auth.uid()));

-- checklist_items has no department/tour_id of its own — it inherits
-- both visibility and edit rights from its parent checklist.
create policy "checklist_items readable per parent checklist" on checklist_items
  for select using (can_view_checklist(checklist_id, auth.uid()));
create policy "checklist_items insertable per parent checklist edit rights" on checklist_items
  for insert with check (can_edit_checklist(checklist_id, auth.uid()));
create policy "checklist_items updatable per parent checklist edit rights" on checklist_items
  for update using (can_edit_checklist(checklist_id, auth.uid()));
create policy "checklist_items deletable per parent checklist edit rights" on checklist_items
  for delete using (can_edit_checklist(checklist_id, auth.uid()));

-- Let resource_shares' existing insert policy cover 'checklist' too —
-- 0003 only wired the 'schedule_item' branch.
drop policy "resource_shares insertable by resource owner" on resource_shares;
create policy "resource_shares insertable by resource owner" on resource_shares
  for insert with check (
    granted_by = auth.uid()
    and (
      (resource_type = 'schedule_item' and can_edit_schedule_item(resource_id, auth.uid()))
      or (resource_type = 'checklist' and can_edit_checklist(resource_id, auth.uid()))
    )
  );
drop policy "resource_shares deletable by owner or managers" on resource_shares;
create policy "resource_shares deletable by owner or managers" on resource_shares
  for delete using (
    is_tour_manager(tour_id, auth.uid())
    or (resource_type = 'schedule_item' and can_edit_schedule_item(resource_id, auth.uid()))
    or (resource_type = 'checklist' and can_edit_checklist(resource_id, auth.uid()))
  );

-- ---- fold checklists/checklist_items into the completion lock (0005) ----
create or replace function enforce_tour_not_locked()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_tour_id uuid;
  v_org_id uuid;
  v_completed_at timestamptz;
  v_actor uuid := auth.uid();
begin
  if TG_TABLE_NAME = 'tours' then
    if TG_OP = 'INSERT' then
      return NEW;
    end if;
    v_tour_id := OLD.id;
    v_completed_at := OLD.completed_at;
    v_org_id := OLD.organization_id;

  elsif TG_TABLE_NAME in (
    'tour_members', 'tour_dates', 'flights', 'lodging',
    'documents', 'budget_items', 'resource_shares', 'tour_invites',
    'checklists'
  ) then
    v_tour_id := coalesce(NEW.tour_id, OLD.tour_id);

  elsif TG_TABLE_NAME = 'flight_passengers' then
    select f.tour_id into v_tour_id
      from flights f where f.id = coalesce(NEW.flight_id, OLD.flight_id);

  elsif TG_TABLE_NAME = 'lodging_rooms' then
    select l.tour_id into v_tour_id
      from lodging l where l.id = coalesce(NEW.lodging_id, OLD.lodging_id);

  elsif TG_TABLE_NAME = 'lodging_room_occupants' then
    select l.tour_id into v_tour_id
      from lodging_rooms lr join lodging l on l.id = lr.lodging_id
      where lr.id = coalesce(NEW.room_id, OLD.room_id);

  elsif TG_TABLE_NAME in ('guest_list_requests', 'schedule_items') then
    select td.tour_id into v_tour_id
      from tour_dates td where td.id = coalesce(NEW.tour_date_id, OLD.tour_date_id);

  elsif TG_TABLE_NAME = 'checklist_items' then
    select c.tour_id into v_tour_id
      from checklists c where c.id = coalesce(NEW.checklist_id, OLD.checklist_id);
  end if;

  if v_tour_id is null then
    if TG_OP = 'DELETE' then return OLD; end if;
    return NEW;
  end if;

  if TG_TABLE_NAME != 'tours' then
    select t.completed_at, t.organization_id into v_completed_at, v_org_id
      from tours t where t.id = v_tour_id;
  end if;

  if v_completed_at is not null
     and not (is_org_admin(v_org_id, v_actor) or is_tour_owner(v_tour_id, v_actor)) then
    raise exception 'This tour is completed and locked. Only the tour owner can make further changes.'
      using errcode = '42501';
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

create trigger lock_completed_tour before insert or update or delete on checklists
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on checklist_items
  for each row execute function enforce_tour_not_locked();
