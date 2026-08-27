-- Two small, low-risk additions that unlock everything downstream in this
-- batch (weather, route distances, richer show info):
--
--   1. `venues` gets latitude/longitude — the table itself already has
--      full CRUD RLS (0001/0002/0007/0014), it's just never had a UI
--      built against it (AI schedule import even extracts venue name/city
--      today and stuffs them into a notes field, see ImportScheduleScreen
--      combineNotes(), for lack of anywhere real to put them). No RLS
--      changes needed here — existing row-level policies already cover
--      new columns automatically.
--
--   2. `tour_dates` gets real show-level detail: status, promoter contact,
--      deal terms. Flat columns (not jsonb) because tour_dates is already
--      an all-flat-columns table (load_in/soundcheck/doors/set_time/...)
--      and a promoter is one fixed contact per show, not a variable list
--      — unlike `venues.contacts` which genuinely is a list.

alter table venues
  add column latitude numeric(9,6),
  add column longitude numeric(9,6),
  add column geocoded_at timestamptz;

create type show_status as enum ('confirmed', 'hold', 'cancelled', 'postponed');

alter table tour_dates
  add column show_status show_status not null default 'confirmed',
  add column promoter_name text,
  add column promoter_phone text,
  add column promoter_email text,
  add column guarantee numeric(12,2),
  add column ticket_price numeric(12,2),
  add column capacity_override integer;
