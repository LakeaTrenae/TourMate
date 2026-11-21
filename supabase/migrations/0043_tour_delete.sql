-- Tours never had a DELETE policy — 0001_init.sql gave `tours` select,
-- insert, and update policies, but deleting a tour was never wired up on
-- either end (no RLS policy, no UI). Renaming and marking a tour
-- complete/reopening already work today through the existing "tours
-- updatable by managers" policy + the completion-lock trigger
-- (0005_tour_completion_lock.sql) — this migration only adds the missing
-- delete path.
--
-- Scoped to the tour's OWNER specifically (narrower than the
-- owner/admin/manager tier the update policy allows) because deleting a
-- tour cascades its entire schedule, budget, lodging, travel, and guest
-- data via `on delete cascade` with no undo — reusing is_tour_owner()
-- (0004_tour_admin_roster_directory.sql), the same security-definer
-- helper the completion-lock override already trusts for this exact
-- "most destructive tour-level action" tier.
create policy "tours deletable by owner" on tours
  for delete using (is_tour_owner(id, auth.uid()));
