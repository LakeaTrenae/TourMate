-- Passport/visa tracking, kept in its own table rather than columns on
-- `profiles` for two reasons:
--   1. `profiles` is broadly readable ("profiles readable by fellow tour
--      or org members", 0011) — passport numbers are exactly the kind of
--      PII that policy was never meant to expose, and RLS is row-level in
--      Postgres, not column-level, so bolting sensitive columns onto an
--      already-broadly-selectable row would leak them to every fellow
--      tour member, not just managers.
--   2. `profiles` is fetched via a fixed column list (PROFILE_COLUMNS in
--      auth-context.tsx) on nearly every screen via useAuth().profile —
--      rarely-read, sensitive fields don't belong bloating that shape.
--
-- Visibility: a person's own row is always theirs to read/write. A
-- manager can VIEW (not edit) a teammate's passport/visa info, but only
-- if they actually manage a tour that teammate is also on — editing
-- passport data is self-service only, so a manager can't (accidentally
-- or otherwise) alter someone else's passport number.
--
-- Not part of the tour completion lock — this is person-scoped, not
-- tour-scoped, so there's no tour completion status to enforce against.

create table passport_visa_info (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references profiles (id) on delete cascade,
  passport_number text,
  passport_country text,
  passport_expiry date,
  visa_type text,
  visa_number text,
  visa_expiry date,
  notes text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Built directly on is_tour_member/is_tour_manager against `tours`, not a
-- raw `tour_members` join — tour_members is only an OVERRIDE table
-- (org-role-only participants have no row there at all), so a raw join
-- would under-match real tour members and hide legitimate managers from
-- seeing their own crew's travel-document status.
create or replace function shares_a_managed_tour(p_target_user_id uuid, p_viewer_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from tours t
    where is_tour_member(t.id, p_target_user_id)
      and is_tour_manager(t.id, p_viewer_id)
  );
$$;

alter table passport_visa_info enable row level security;

create policy "passport_visa readable by self or managers of a shared tour" on passport_visa_info
  for select using (
    user_id = auth.uid() or shares_a_managed_tour(user_id, auth.uid())
  );
create policy "passport_visa insertable by self" on passport_visa_info
  for insert with check (user_id = auth.uid());
create policy "passport_visa updatable by self" on passport_visa_info
  for update using (user_id = auth.uid());
create policy "passport_visa deletable by self" on passport_visa_info
  for delete using (user_id = auth.uid());
