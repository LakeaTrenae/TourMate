-- Emergency contact (next-of-kin) info per person — separate from
-- passport_visa_info (0024) even though the shape rhymes, since it's
-- semantically distinct data (identity documents vs. who to call), and
-- keeping them separate preserves the "one purpose per table" pattern
-- that migration established. Same reasoning for the split from
-- `profiles` too: profiles is broadly readable by fellow tour/org
-- members (RLS is row-level, not column-level, so a sensitive column
-- there would leak to everyone, not just managers), and profiles is
-- fetched via a fixed column list on nearly every screen so a
-- rarely-read field like this shouldn't bloat that shape.
--
-- Reuses shares_a_managed_tour (0024) as-is — no new helper needed.
-- Self can read/write; a manager who shares a tour with this person can
-- only VIEW, never edit someone else's emergency contact.

create table emergency_contact_info (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references profiles (id) on delete cascade,
  contact_name text,
  relationship text,
  phone text,
  alternate_phone text,
  notes text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table emergency_contact_info enable row level security;

create policy "emergency_contact readable by self or managers of a shared tour" on emergency_contact_info
  for select using (
    user_id = auth.uid() or shares_a_managed_tour(user_id, auth.uid())
  );
create policy "emergency_contact insertable by self" on emergency_contact_info
  for insert with check (user_id = auth.uid());
create policy "emergency_contact updatable by self" on emergency_contact_info
  for update using (user_id = auth.uid());
create policy "emergency_contact deletable by self" on emergency_contact_info
  for delete using (user_id = auth.uid());

-- No trigger at all (not even completion-lock — person-scoped, not
-- tour-scoped) — same as passport_visa_info, so the client screen can
-- freely use .upsert(...).select().single() without the RETURNING/RLS
-- interaction documented in lib/ids.ts.
