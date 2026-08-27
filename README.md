# TourMate

Tour management app for touring bands, crew, and production teams —
itinerary/day sheets, travel (flights + lodging), guest lists, documents,
and budgeting, with role-based access so managers see everything and crew
only see what's relevant to them.

Built to expand beyond a single band's tour into a multi-tenant platform
(bands, production companies, eventually venues/promoters), with billing
per organization down the line.

## Structure

```
TourMate/
├── mobile/            Expo (React Native + TypeScript) app — the app-store product
└── supabase/
    └── migrations/     Postgres schema + RLS policies
```

## Stack

- **Mobile app**: Expo (React Native, TypeScript). One codebase → iOS App
  Store + Google Play via EAS Build/Submit.
- **Backend**: Supabase — Postgres, Auth, Storage, Realtime. Access control
  is enforced with Postgres Row-Level Security, not just app-layer checks
  (see `supabase/migrations/0001_init.sql`).
- **Billing** (not wired up yet): organization-level subscription fields
  exist in the schema (`organizations.subscription_*`) but are
  provider-agnostic until billing is actually built.

## Data model — the short version

`organizations` is the tenant boundary (a band, a production company,
eventually a venue or promoter). Members join an org with a role
(`owner` / `admin` / `manager` / `crew`). `tours` belong to an org;
`tour_members` lets a manager override someone's role for a single tour
(narrower or different than their org-wide role).

Every operational table (`tour_dates`, `flights`, `lodging`,
`guest_list_requests`, `documents`, `budget_items`) is scoped to a tour and
locked down with RLS:

- **Managers** (`owner`/`admin`/`manager`) see everything on their tours.
- **Crew** see only their own flight, their own room, and non-manager-only
  documents — never the budget.

## Next steps

1. Create a Supabase project, run the migration in `supabase/migrations/`.
2. Wire up Supabase Auth + client in `mobile/`.
3. Build the core screens: tour list → tour detail (day sheet, travel,
   people) scoped by the signed-in user's effective role.
4. Billing: provision Stripe via subscription checkout once there's a
   reason to charge for an org (more than one active tour, seat limits, etc.).