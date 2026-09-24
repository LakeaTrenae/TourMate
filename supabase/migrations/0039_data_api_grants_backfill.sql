-- Data API grant backfill — Supabase is discontinuing automatic Data API
-- grants for newly-created public-schema tables starting October 30 (per
-- their notice). Existing tables keep their current grants with no action
-- needed, but that's exactly the trap: 0038_advance_sheet_structure.sql's
-- four new tables got their grants automatically at apply-time, which
-- means a FRESH environment created from these migrations after October
-- 30 (a new project, a preview branch, or a local `supabase db reset`)
-- would silently create those same tables with NO Data API grants at all
-- — a permission-denied error PostgREST would throw with no obvious cause.
--
-- Rather than edit 0038 after the fact (this schema's own convention is
-- append-only migrations, never rewriting a shipped one), this file makes
-- the grant explicit going forward. Matches the exact privilege set every
-- other table in this schema already has (confirmed live: `grant all` to
-- anon/authenticated/service_role) — RLS remains the actual gate on every
-- one of these tables regardless of what the grant allows.
grant all on table public.advance_contacts to anon, authenticated, service_role;
grant all on table public.advance_crew_labor to anon, authenticated, service_role;
grant all on table public.advance_hospitality_items to anon, authenticated, service_role;
grant all on table public.advance_room_assignments to anon, authenticated, service_role;
