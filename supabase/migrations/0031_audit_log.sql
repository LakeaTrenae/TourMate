-- Who changed what, when — for the sensitive tables where that actually
-- matters: financial data (budget, settlements), access changes
-- (tour_member removal, artist_contact add/remove, resource sharing).
-- Scoped deliberately, not a blanket log of every table — matches this
-- codebase's established style of hand-written, purpose-built triggers/
-- functions over generic mechanisms (confirmed: no existing audit/
-- activity-log table or generic jsonb-diff trigger exists anywhere in
-- the prior 29 migrations).
--
-- Written by the client via lib/auditLog.ts, right after the real
-- mutation succeeds — not a trigger. The real mutation is already
-- RLS-gated; this just records that it happened. If the log write itself
-- fails, that's swallowed client-side (best-effort, non-blocking) rather
-- than rolling back or blocking the action that already succeeded.

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references tours (id) on delete cascade,
  actor_id uuid references profiles (id) on delete set null,
  action text not null,          -- 'create' | 'update' | 'delete' | 'share' | 'unshare' | 'approve' | 'deny'
  resource_type text not null,   -- 'budget_item' | 'settlement' | 'tour_member' | 'artist_contact' | 'resource_share'
  -- tour_members has a composite primary key (tour_id, user_id), no
  -- surrogate id column — for that resource_type, resource_id stores the
  -- affected user_id; this row's own tour_id column completes the
  -- identity, so the pair (tour_id, resource_id) still uniquely points
  -- at the tour_members row that was affected.
  resource_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_tour_lookup on audit_log (tour_id, created_at desc);

alter table audit_log enable row level security;

create policy "audit_log readable by managers" on audit_log
  for select using (is_tour_manager(tour_id, auth.uid()));

-- The actor must actually BE a manager on this tour, not just claim to
-- be auth.uid() — every action this log covers is itself manager/
-- production-gated at the real mutation's own RLS layer already, so this
-- closes the one gap where a client could otherwise forge a log row for
-- an action it was never allowed to take in the first place.
create policy "audit_log insertable by managers" on audit_log
  for insert with check (actor_id = auth.uid() and is_tour_manager(tour_id, auth.uid()));

-- Append-only, deliberately: no update or delete policy at all, and no
-- completion-lock trigger — a log entry records something that already
-- happened and was already gated; the log itself isn't lockable.
