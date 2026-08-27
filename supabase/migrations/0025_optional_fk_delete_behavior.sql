-- Found while cleaning up test data: deleting a venue (or cascading
-- through an organization delete, which cascades to venues via
-- venues.organization_id) fails with a hard FK violation if any
-- tour_dates row still references it via venue_id — that FK had no
-- ON DELETE behavior specified in 0001_init.sql, so Postgres defaults to
-- RESTRICT. This was a latent gap since day one; it only surfaced now
-- because tour_dates.venue_id was never actually populated by any screen
-- until this batch's AddTourDateScreen/ImportScheduleScreen work wired
-- venues in for the first time.
--
-- Same shape, same latent gap, same fix: flights.tour_date_id,
-- lodging.tour_date_id, and ground_transport.tour_date_id are all
-- optional FKs to tour_dates with no ON DELETE behavior either — not
-- actively populated by any screen yet, but deleting a tour_date should
-- never be blocked by (or silently corrupt) an optional cross-reference
-- on a sibling record. ON DELETE SET NULL everywhere: the record itself
-- (the flight, the hotel stay, the transport leg, the show date) is what
-- matters and stays; a dangling "which date/venue" reference just clears
-- instead of blocking deletion, same reasoning as 0019's creator-column
-- fix.
--
-- Written as a dynamic DO block, same as 0019, since none of these
-- constraints were named explicitly in the migrations that created them.

do $$
declare
  cols record;
  fk record;
begin
  for cols in
    select * from (values
      ('tour_dates', 'venue_id', 'venues'),
      ('flights', 'tour_date_id', 'tour_dates'),
      ('lodging', 'tour_date_id', 'tour_dates'),
      ('ground_transport', 'tour_date_id', 'tour_dates')
    ) as t(tbl, col, ref_tbl)
  loop
    for fk in
      select conname
      from pg_constraint
      where contype = 'f'
        and conrelid = cols.tbl::regclass
        and (select attname from pg_attribute where attrelid = conrelid and attnum = conkey[1]) = cols.col
    loop
      execute format('alter table %I drop constraint %I', cols.tbl, fk.conname);
    end loop;

    execute format(
      'alter table %I add constraint %I foreign key (%I) references %I (id) on delete set null',
      cols.tbl, cols.tbl || '_' || cols.col || '_fkey', cols.col, cols.ref_tbl
    );
  end loop;
end $$;
