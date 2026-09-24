-- Production budget module (Phase 3): per-week/per-show breakdown,
-- custom per-tour categories, deposit tracking, and wiring up venues'
-- already-existing-but-unused contacts/tech_specs jsonb columns with
-- real UI (confirmed via exploration: those columns have had zero UI
-- anywhere in this app since they were added).

-- ============================================================================
-- 1. budget_categories — custom, per-tour. budget_items.category (text)
-- stays exactly as it is for backward compatibility and as a free-text
-- fallback; category_id is an additional, optional structured link.
-- ============================================================================
create table budget_categories (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references tours (id) on delete cascade,
  name text not null,
  color text, -- hex, for a chip in the UI — optional, purely cosmetic
  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now(),
  unique (tour_id, name)
);

create index budget_categories_tour_id_idx on budget_categories (tour_id);

alter table budget_categories enable row level security;

-- Same flat manager-only gate as budget_items itself (0001/0002) — a
-- budget category is exactly as sensitive as the line items filed under it.
create policy "budget_categories readable by managers only" on budget_categories
  for select using (is_tour_manager(tour_id, auth.uid()));
create policy "budget_categories writable by managers only" on budget_categories
  for insert with check (is_tour_manager(tour_id, auth.uid()));
create policy "budget_categories updatable by managers only" on budget_categories
  for update using (is_tour_manager(tour_id, auth.uid()));
create policy "budget_categories deletable by managers only" on budget_categories
  for delete using (is_tour_manager(tour_id, auth.uid()));

-- Same completion-lock trigger every other tour-scoped table already has
-- (0005_tour_completion_lock.sql) — a completed/locked tour shouldn't
-- gain new budget categories any more than it should gain new line items.
create trigger lock_completed_tour before insert or update or delete on budget_categories
  for each row execute function enforce_tour_not_locked();

grant all on table public.budget_categories to anon, authenticated, service_role;

-- ============================================================================
-- 2. budget_items — per-week/per-show breakdown (tour_date_id), structured
-- category (category_id), venue linkage independent of a specific show
-- date (venue_id — e.g. a deposit paid before dates are finalized), and
-- deposit tracking (deposit_status; null means "not a deposit," an
-- ordinary line item).
-- ============================================================================
alter table budget_items
  add column tour_date_id uuid references tour_dates (id) on delete set null,
  add column category_id uuid references budget_categories (id) on delete set null,
  add column venue_id uuid references venues (id) on delete set null,
  add column deposit_status text check (deposit_status in ('pending', 'paid', 'refunded'));

create index budget_items_tour_date_id_idx on budget_items (tour_date_id);
create index budget_items_category_id_idx on budget_items (category_id);
