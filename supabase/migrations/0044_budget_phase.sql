-- Budget items get a phase: 'rehearsal' or 'tour'. Lets a tour's budget be
-- viewed/exported as two distinct sections — pre-tour rehearsal costs
-- (space rental, rehearsal-week per diems, etc.) versus the actual run —
-- rather than one blended total. Defaults every existing and new row to
-- 'tour' so nothing already entered silently reclassifies as a rehearsal
-- cost.
create type budget_phase as enum ('rehearsal', 'tour');

alter table budget_items
  add column phase budget_phase not null default 'tour';
