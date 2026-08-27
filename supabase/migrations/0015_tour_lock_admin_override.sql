-- The completion-lock override (0005) let the org owner/admin or the
-- tour's OWNER edit a completed tour, but not a tour-level ADMIN (someone
-- with tour_members.role = 'admin' for this tour specifically, without
-- also being an org owner/admin). That's an inconsistency: org-level
-- already treats owner and admin as equivalent for this kind of
-- override (is_org_admin checks both). Tour-level should too.

create or replace function is_tour_owner_or_admin(p_tour_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select effective_tour_role(p_tour_id, p_user_id) in ('owner', 'admin');
$$;

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
    if TG_OP = 'DELETE' then return OLD; end if;
    return NEW;
  end if;

  if TG_TABLE_NAME != 'tours' then
    select t.completed_at, t.organization_id into v_completed_at, v_org_id
      from tours t where t.id = v_tour_id;
  end if;

  if v_completed_at is not null
     and not (is_org_admin(v_org_id, v_actor) or is_tour_owner_or_admin(v_tour_id, v_actor)) then
    raise exception 'This tour is completed and locked. Only the tour owner/admin can make further changes.'
      using errcode = '42501';
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;
