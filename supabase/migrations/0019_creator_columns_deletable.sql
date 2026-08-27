-- Deleting a user account currently fails with a foreign-key violation if
-- they've ever created a tour/org, uploaded a document, logged a budget
-- entry, requested a guest, or sent an invite — every "*_by" creator
-- column referencing profiles was left NOT NULL with no ON DELETE action
-- (Postgres defaults to RESTRICT). That's not an edge case limited to org
-- owners — it would have broken account deletion for nearly any real
-- user. Fixed by making these columns nullable with ON DELETE SET NULL:
-- deleting the account preserves the historical record (the tour, the
-- document, the expense) but its "who created this" reference clears
-- rather than blocking the deletion outright.
--
-- Written as a dynamic DO block rather than named ALTER TABLE ... DROP
-- CONSTRAINT statements because the original migrations never named
-- these constraints explicitly — this finds whatever Postgres
-- auto-generated instead of guessing the name.

do $$
declare
  cols record;
  fk record;
begin
  for cols in
    select * from (values
      ('organizations', 'created_by'),
      ('tours', 'created_by'),
      ('guest_list_requests', 'requested_by'),
      ('documents', 'uploaded_by'),
      ('budget_items', 'created_by'),
      ('tour_invites', 'invited_by')
    ) as t(tbl, col)
  loop
    execute format('alter table %I alter column %I drop not null', cols.tbl, cols.col);

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
      'alter table %I add constraint %I foreign key (%I) references profiles (id) on delete set null',
      cols.tbl, cols.tbl || '_' || cols.col || '_fkey', cols.col
    );
  end loop;
end $$;