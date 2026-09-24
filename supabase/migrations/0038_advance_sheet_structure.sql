-- Advance sheet rebuild (Phase 2) — replaces the 6 flat textareas with real
-- structure, modeled directly on a real touring advance sheet the user
-- provided as a reference. Grouped into:
--
--  1. Grouped label:value specs that are genuinely just a fixed set of
--     fields per section (power, stage/mix, production requirements,
--     equipment, headcounts, meal times, sign-off) — stored as jsonb
--     columns on `advances` itself, following the same precedent already
--     established by venues.tech_specs/venues.contacts (label:value blobs
--     with no need for per-row CRUD or their own RLS).
--  2. Genuine one-to-many lists that need real row-level CRUD (contacts,
--     local crew labor call, itemized hospitality, room assignments) —
--     new child tables, each mirroring checklist_items' exact "inherits
--     visibility from its parent, no department/tour_id of its own"
--     pattern: gated entirely through can_view_advance/can_edit_advance
--     via advance_id, using the two functions already defined in
--     0023_ground_transport_advancing_settlement.sql.
--
-- The daytime running order (Building Access → Breakfast → Load In →
-- Soundcheck → each act's set → Curfew) is NOT a new table — it's exactly
-- what the existing `schedule_items` table (0003_departments_and_sharing.sql)
-- already models (time-based, tour_date-scoped, department-visible). The
-- advance sheet screen reads/writes schedule_items for its own tour_date
-- directly rather than duplicating that concept.

-- ============================================================================
-- 1. Grouped spec columns on advances
-- ============================================================================
alter table advances
  add column power jsonb not null default '{}'::jsonb,               -- {lights, sound, rigging, pyro}
  add column stage_specs jsonb not null default '{}'::jsonb,         -- {requested_stage, stage_wings, upstage_black, stage_stairs, stage_risers, mix_position, total_weight_load, rigging_points}
  add column production_requirements jsonb not null default '{}'::jsonb, -- {tour_audio, tour_lighting, tour_monitors, tour_video, tour_fx_lasers, tour_barricade, tour_clear_comm, tour_drape_backdrop} — free-text values ("yes"/"no"/"tbd"/etc, matching the reference sheet's YES/?/blank cells)
  add column equipment_needs jsonb not null default '{}'::jsonb,     -- {vehicles, gases, forklift}
  add column headcounts jsonb not null default '{}'::jsonb,          -- {backstage_working_area, meet_greet, dressing_rooms, trucks_buses, backstage_entrance, medical_emts}
  add column meal_times jsonb not null default '{}'::jsonb,          -- {breakfast, lunch, dinner} — free-text time labels, not a real `time` column: real sheets say things like "TBD" or "1hr before doors"
  add column meal_notes text,                                        -- allergies / vegan-vegetarian counts
  add column sign_off jsonb not null default '{}'::jsonb;            -- {audit_cap_sold_map, haze_policy, advanced_by, tour_promo_rep}

-- ============================================================================
-- 2. advance_contacts — key contacts / vendors / venue staff, one table with
-- a category column rather than three near-identical tables. Mirrors
-- artist_contacts' exact shape (0027_artist_privacy.sql).
-- ============================================================================
create table advance_contacts (
  id uuid primary key default gen_random_uuid(),
  advance_id uuid not null references advances (id) on delete cascade,
  category text not null check (category in ('key', 'vendor', 'venue_staff')),
  name text not null,
  role text, -- "Promoter Rep & Advance", "Audio", "Building Event Mgr"...
  phone text,
  email text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 3. advance_crew_labor — local crew call, one row per role with a headcount
-- and call time (STEWARD / FORKS / STAGEHANDS / LOADERS / etc, matching the
-- reference sheet's labor-call table). Totals are computed client-side, same
-- as BudgetScreen's existing .reduce() style — no stored total column.
-- ============================================================================
create table advance_crew_labor (
  id uuid primary key default gen_random_uuid(),
  advance_id uuid not null references advances (id) on delete cascade,
  role text not null,
  call_time time,
  count integer,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 4. advance_hospitality_items — itemized rider checklist, grouped by who
-- it's for (headliner / support / production / catering / etc — free text
-- so it fits whatever acts are actually on the bill). Mirrors
-- checklist_items' fulfilled/notes shape.
-- ============================================================================
create table advance_hospitality_items (
  id uuid primary key default gen_random_uuid(),
  advance_id uuid not null references advances (id) on delete cascade,
  group_name text not null, -- "Headliner", "Support", "Production", "Catering", "SUVs", "Promoter", "Runners"...
  item text not null,
  quantity text,
  notes text,
  fulfilled boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 5. advance_room_assignments — which room/office belongs to whom (Prod
-- Office, Crew Room, each dressing room, each opener's room...).
-- ============================================================================
create table advance_room_assignments (
  id uuid primary key default gen_random_uuid(),
  advance_id uuid not null references advances (id) on delete cascade,
  room_label text not null, -- "Sexyy Red DR 1", "Crew Room", "Prod Office"...
  assigned_to text,
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 6. RLS — all four child tables inherit visibility/edit rights entirely
-- from their parent advance, exactly like checklist_items does from its
-- parent checklist.
-- ============================================================================
create index advance_contacts_advance_id_idx on advance_contacts (advance_id);
create index advance_crew_labor_advance_id_idx on advance_crew_labor (advance_id);
create index advance_hospitality_items_advance_id_idx on advance_hospitality_items (advance_id);
create index advance_room_assignments_advance_id_idx on advance_room_assignments (advance_id);

alter table advance_contacts enable row level security;
alter table advance_crew_labor enable row level security;
alter table advance_hospitality_items enable row level security;
alter table advance_room_assignments enable row level security;

create policy "advance_contacts readable per parent advance" on advance_contacts
  for select using (can_view_advance(advance_id, auth.uid()));
create policy "advance_contacts insertable per parent advance edit rights" on advance_contacts
  for insert with check (can_edit_advance(advance_id, auth.uid()));
create policy "advance_contacts updatable per parent advance edit rights" on advance_contacts
  for update using (can_edit_advance(advance_id, auth.uid()));
create policy "advance_contacts deletable per parent advance edit rights" on advance_contacts
  for delete using (can_edit_advance(advance_id, auth.uid()));

create policy "advance_crew_labor readable per parent advance" on advance_crew_labor
  for select using (can_view_advance(advance_id, auth.uid()));
create policy "advance_crew_labor insertable per parent advance edit rights" on advance_crew_labor
  for insert with check (can_edit_advance(advance_id, auth.uid()));
create policy "advance_crew_labor updatable per parent advance edit rights" on advance_crew_labor
  for update using (can_edit_advance(advance_id, auth.uid()));
create policy "advance_crew_labor deletable per parent advance edit rights" on advance_crew_labor
  for delete using (can_edit_advance(advance_id, auth.uid()));

create policy "advance_hospitality_items readable per parent advance" on advance_hospitality_items
  for select using (can_view_advance(advance_id, auth.uid()));
create policy "advance_hospitality_items insertable per parent advance edit rights" on advance_hospitality_items
  for insert with check (can_edit_advance(advance_id, auth.uid()));
create policy "advance_hospitality_items updatable per parent advance edit rights" on advance_hospitality_items
  for update using (can_edit_advance(advance_id, auth.uid()));
create policy "advance_hospitality_items deletable per parent advance edit rights" on advance_hospitality_items
  for delete using (can_edit_advance(advance_id, auth.uid()));

create policy "advance_room_assignments readable per parent advance" on advance_room_assignments
  for select using (can_view_advance(advance_id, auth.uid()));
create policy "advance_room_assignments insertable per parent advance edit rights" on advance_room_assignments
  for insert with check (can_edit_advance(advance_id, auth.uid()));
create policy "advance_room_assignments updatable per parent advance edit rights" on advance_room_assignments
  for update using (can_edit_advance(advance_id, auth.uid()));
create policy "advance_room_assignments deletable per parent advance edit rights" on advance_room_assignments
  for delete using (can_edit_advance(advance_id, auth.uid()));
