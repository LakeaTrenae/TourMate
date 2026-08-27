-- Tour completion lock.
--
-- Once a tour is marked completed, every table that belongs to it becomes
-- read-only for everyone except:
--   - that specific tour's owner (tour_members.role = 'owner' for this
--     tour, via is_tour_owner — the same "go-to person" concept from
--     0004), or
--   - an org owner/admin (via is_org_admin), as the standing override.
--
-- Implemented as a BEFORE trigger, not by editing the ~15 existing RLS
-- write policies. Reasoning: RLS policies answer "can this role touch
-- this table at all" — completion status is an orthogonal question ("is
-- THIS SPECIFIC tour currently locked"), and enforcing it as a trigger
-- means there's exactly one place this rule lives, applied uniformly,
-- rather than a copy of the same check pasted into every policy (and
-- silently missing one, the way 0001 originally missed policies on
-- venues/tour_members/etc.).

-- ============================================================================
-- TOURS: add the completion marker.
-- Nullable timestamp, not a boolean — null means active/upcoming, a value
-- means completed (and records *when*, useful for a tour history view).
-- ============================================================================
alter table tours
  add column completed_at timestamptz;

-- ============================================================================
-- LOCK-ENFORCEMENT TRIGGER
-- ============================================================================
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
  -- Resolve which tour this write belongs to. Different tables reach
  -- "their" tour_id differently (direct column vs. one or two joins up).
  if TG_TABLE_NAME = 'tours' then
    if TG_OP = 'INSERT' then
      return NEW; -- a brand-new tour can't already be locked
    end if;
    v_tour_id := OLD.id;
    v_completed_at := OLD.completed_at;
    v_org_id := OLD.organization_id;

  elsif TG_TABLE_NAME in (
    'tour_members', 'tour_dates', 'flights', 'lodging',
    'documents', 'budget_items', 'resource_shares', 'tour_invites'
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
  end if;

  if v_tour_id is null then
    -- Couldn't resolve a tour for this row (shouldn't happen — FK
    -- constraints guarantee the parent exists). Fail OPEN here rather
    -- than block a legitimate write over a lookup bug; referential
    -- integrity is still guaranteed independently by the FKs.
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
      using errcode = '42501'; -- insufficient_privilege
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

-- Attach to every tour-scoped table. (Deliberately NOT attached to
-- `venues` or `organizations`/`organization_members` — those are
-- org-level, reused across tours, and shouldn't lock just because one
-- tour using them wrapped up.)
create trigger lock_completed_tour before insert or update or delete on tours
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on tour_members
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on tour_dates
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on flights
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on flight_passengers
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on lodging
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on lodging_rooms
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on lodging_room_occupants
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on guest_list_requests
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on documents
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on budget_items
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on schedule_items
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on resource_shares
  for each row execute function enforce_tour_not_locked();
create trigger lock_completed_tour before insert or update or delete on tour_invites
  for each row execute function enforce_tour_not_locked();

-- Note: marking a tour completed in the first place (setting completed_at)
-- still goes through the existing "tours updatable by managers" RLS policy
-- from 0001 — any manager-tier person can complete a tour. REOPENING one
-- (clearing completed_at) or editing anything after completion is what's
-- restricted to the tour owner / org admin above. If you'd rather only the
-- owner be able to mark a tour completed in the first place too, that's a
-- one-line change to the RLS policy on `tours` — say the word.
