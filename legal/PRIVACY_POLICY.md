# TourMate Privacy Policy

> **⚠️ DRAFT — NOT LEGAL ADVICE.** This document was drafted by an AI assistant as a starting point, grounded in what the TourMate app actually collects and how it actually works as of the date below. It is **not** a substitute for review by a qualified attorney. Have a lawyer review this before publishing it or relying on it, especially for the state-law and business-entity sections, which contain placeholders only you can fill in accurately.

**Last updated:** [DATE — fill in when published]
**Contact:** [YOUR CONTACT EMAIL — fill in]

## 1. Who this applies to

This Privacy Policy covers TourMate, a touring and production management app for bands, crews, production companies, and the venues/promoters they work with. If you use TourMate — as a tour manager, crew member, artist, or anyone else invited onto a tour — this policy explains what information the app collects about you, why, and who can see it.

## 2. What we collect

TourMate is built around organizations and tours, and most of what it stores is the operational information a touring production genuinely needs to run:

- **Account & profile information**: your name, email, phone number, and (optionally) a profile photo.
- **Tour and schedule data**: show dates, venues, load-in/soundcheck/set times, guest lists, checklists, advances, and settlements — the day-to-day logistics of a tour.
- **Travel information**: flight details, ground transportation, and lodging/room assignments for the tours you're on.
- **Sensitive personal information you or your tour manager choose to add**:
  - Passport and visa details (for international touring)
  - Emergency contact information
  - These are stored separately from your general profile, with access limited to you and the managers of a tour you're actually on.
- **Financial information**: budget entries, receipts, and settlement figures for the tours you have access to (visible only to tour managers, not general crew).
- **Documents and files** you or others upload — riders, contracts, itineraries, receipts, venue photos.
- **Messages and notifications**: push notification tokens (so we can send you tour-related alerts), and an internal activity log of certain sensitive actions (visible only to tour managers) for accountability.
- **Billing information**, for organizations that subscribe: your organization's subscription status, seat count, and billing history. **We do not collect or store your payment card details ourselves** — that's handled entirely by our payment processor, Stripe (see §4).

We do not ask for, and have no interest in collecting, information unrelated to running a tour or production.

## 3. Why we collect it

Everything above exists to run the app's actual features — scheduling, travel coordination, guest lists, financial tracking, and team communication for a touring production. We don't use your information for advertising, and we don't build behavioral profiles of you for any purpose beyond making the app work.

## 4. Who we share it with

**We do not sell your personal information, ever, to anyone, for any purpose.**

TourMate uses a small number of third-party services to actually run the app. Each one only receives the specific data it needs to perform its function:

- **Supabase** — our database, authentication, and file storage provider. All app data passes through Supabase's infrastructure.
- **Stripe** — our payment processor, for organizations that subscribe to a paid plan. Stripe handles all payment card data directly; we never see or store your card number.
- **Anthropic (Claude API)** — powers optional AI-assisted features (e.g. suggesting document titles/categories, extracting show dates from an uploaded routing sheet). Only the specific file or text you choose to run through these features is sent to Anthropic for that one request.
- **Expo** — delivers push notifications to your device.
- **Open-Meteo and OpenStreetMap** — provide weather forecasts and map data for venues, using only venue location data (not your personal information).

We do not share your data with data brokers, advertisers, or any other third party beyond what's listed here.

## 5. Who can see your data inside the app

TourMate's access model is enforced by the database itself, not just hidden in the app's screens — meaning even a bug in the app's interface can't leak data someone isn't authorized to see. In general:

- Tour and schedule information is visible to the people actually on that tour, scoped by department where relevant (e.g. a security-department crew member sees security-relevant items, not necessarily finance details).
- Budget and settlement figures are visible only to tour managers, never general crew.
- Passport/visa and emergency contact information is visible only to you and the managers of a tour you're on — never to other crew members.
- Artist-specific information (management contacts, riders) is visible only to tour management and that artist's own assigned team.
- Anyone with edit access to a piece of content can additionally choose to share it with specific people or departments beyond the defaults above.

## 6. Data retention and deletion

You can permanently delete your account at any time from within the app (Settings → Delete Account). This immediately and irreversibly deletes your authentication credentials and personal profile. Historical tour records you contributed to (schedules, documents, budget entries) remain in place for the rest of the team, but your name is disassociated from them — the tour's history survives; the record of "you specifically did this" does not.

If you leave a tour or organization without deleting your account entirely, your access to that tour's data is revoked, but your account and any personal data tied only to you (passport/visa, emergency contact) remains under your control.

## 7. Your rights

Depending on where you live, you may have rights under laws like the California Consumer Privacy Act (CCPA) or similar state privacy laws, generally including the right to:

- Know what personal information we hold about you
- Request deletion of your personal information (see §6 — you can do this yourself, in-app, at any time)
- Opt out of the sale of your personal information — moot here, since **we never sell personal information** in the first place

[TODO: confirm exactly which state/international privacy laws apply to your business and update this section accordingly — this varies by where your users and business are located, and a lawyer should confirm the applicable list.]

## 8. Children's privacy

TourMate is a professional tool for touring/production teams and is not directed at, or intended for use by, children. We do not knowingly collect information from anyone under 18.

## 9. Security

Access to your data is enforced at the database level via row-level security policies scoped to your specific organization, tour, and role — not just by hiding buttons in the app's interface. Two-factor authentication is available and recommended for all accounts.

## 10. Changes to this policy

We'll update the "Last updated" date at the top of this page if this policy changes in a material way.

## 11. Contact

Questions about this policy or your data: [YOUR CONTACT EMAIL — fill in]
