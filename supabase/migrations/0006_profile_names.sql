-- Splits profile naming into legal name (first/last, captured at signup)
-- vs. preferred name (set later, during profile completion — what
-- everyone else on a tour actually sees in the directory/schedule/etc).

alter table profiles
  add column first_name text,
  add column last_name text,
  add column preferred_name text;

-- Best-effort backfill for any rows that predate this migration (split the
-- old single full_name field on the first space). New signups populate
-- first_name/last_name directly instead (see handle_new_user below).
update profiles
set first_name = nullif(split_part(full_name, ' ', 1), ''),
    last_name = nullif(trim(substring(full_name from position(' ' in full_name) + 1)), '')
where first_name is null;

-- display_name is what the rest of the app should actually render —
-- preferred name if the person set one, else their first name, else
-- whatever full_name has. Computed automatically (STORED generated
-- column) so this fallback logic lives in exactly one place instead of
-- being reimplemented in every screen that shows a person's name.
alter table profiles
  add column display_name text generated always as (
    coalesce(nullif(preferred_name, ''), nullif(first_name, ''), full_name)
  ) stored;

-- Redefine signup to capture first_name/last_name from auth metadata
-- (see AuthScreen.tsx) instead of a single free-text full_name.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  inv record;
  v_first_name text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'first_name', '')), '');
  v_last_name text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'last_name', '')), '');
begin
  insert into public.profiles (id, full_name, first_name, last_name, email)
  values (
    new.id,
    trim(both ' ' from (coalesce(v_first_name, '') || ' ' || coalesce(v_last_name, ''))),
    v_first_name,
    v_last_name,
    new.email
  );

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
