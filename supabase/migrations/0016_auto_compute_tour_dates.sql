-- tours.start_date/end_date are now derived from the tour's actual
-- schedule (tour_dates) instead of typed in by hand at tour creation.
-- Whenever a show date is added, changed, or removed, this trigger
-- recomputes start_date = earliest date, end_date = latest date. A tour
-- with no dates yet naturally lands back at (null, null) — "Dates TBD" in
-- the UI (TourListScreen already handles that case).
--
-- This is the single source of truth going forward — the "Create Tour"
-- screen no longer asks for start/end date at all, and any manual value
-- set another way gets overwritten the next time a show date changes.
-- That's intentional: the schedule IS the tour's real date range: no
-- separate value to keep in sync by hand.

create or replace function sync_tour_date_range()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_tour_id uuid := coalesce(NEW.tour_id, OLD.tour_id);
begin
  update tours
  set start_date = (select min(date) from tour_dates where tour_id = v_tour_id),
      end_date = (select max(date) from tour_dates where tour_id = v_tour_id)
  where id = v_tour_id;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

create trigger sync_tour_date_range_trigger
  after insert or update or delete on tour_dates
  for each row execute function sync_tour_date_range();