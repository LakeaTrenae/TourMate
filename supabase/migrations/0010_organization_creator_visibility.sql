-- Fixes an insert-then-return-representation trap discovered while
-- testing: `organizations` has an AFTER INSERT trigger
-- (handle_new_organization, 0008) that creates the creator's
-- organization_members row. Requesting the inserted row back in the same
-- statement (Supabase JS's `.insert(...).select()`, or PostgREST's
-- `Prefer: return=representation`) failed with a row-level security
-- error — confirmed reproducible: the identical insert succeeds with a
-- plain 201 and fails 403 when representation is requested in the same
-- call.
--
-- Fix: let the creator see their own org directly via `created_by`,
-- without depending on the trigger's organization_members row existing
-- yet. This is also just correct on its own merits — whoever created an
-- org should obviously be able to see it — not only a workaround.
drop policy "org readable by members" on organizations;
create policy "org readable by members" on organizations
  for select using (
    created_by = auth.uid() or is_member_of_org(id, auth.uid())
  );
