#!/usr/bin/env bash
# Spins up a throwaway manager account, an org, a tour, and a crew account
# invited into it — the same scenario used to smoke-test the role/
# department/sharing model end-to-end. Prints both accounts' credentials
# at the end so you can sign into the app as either one.
#
# Safe to run repeatedly — every run uses fresh, timestamped emails, so it
# never collides with a previous run. Nothing here is meant to be
# long-lived: treat whatever it creates as disposable, and re-run this
# instead of hand-crafting test data again.
#
# Usage: ./scripts/seed-test-tour.sh
# Requires: mobile/.env populated (EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../mobile/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — copy mobile/.env.example to mobile/.env first." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

SUPABASE_URL="${EXPO_PUBLIC_SUPABASE_URL:?not set in mobile/.env}"
ANON_KEY="${EXPO_PUBLIC_SUPABASE_ANON_KEY:?not set in mobile/.env}"
STAMP=$(date +%s)
PASSWORD="TestPassword123!"

json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
uuid() { python3 -c "import uuid; print(uuid.uuid4())"; }

echo "== Creating manager account =="
MGR_EMAIL="manager.${STAMP}@tourmate-dev-test.io"
MGR_RESPONSE=$(curl -s -X POST "$SUPABASE_URL/auth/v1/signup" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d "{\"email\":\"$MGR_EMAIL\",\"password\":\"$PASSWORD\",\"data\":{\"first_name\":\"Morgan\",\"last_name\":\"Manager\"}}")
MGR_TOKEN=$(echo "$MGR_RESPONSE" | json "['access_token']")
MGR_ID=$(echo "$MGR_RESPONSE" | json "['user']['id']")
echo "  $MGR_EMAIL / $PASSWORD"

echo "== Creating crew account =="
CREW_EMAIL="crew.${STAMP}@tourmate-dev-test.io"
curl -s -X POST "$SUPABASE_URL/auth/v1/signup" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d "{\"email\":\"$CREW_EMAIL\",\"password\":\"$PASSWORD\",\"data\":{\"first_name\":\"Casey\",\"last_name\":\"Crew\"}}" \
  > /dev/null
echo "  $CREW_EMAIL / $PASSWORD"

echo "== Creating organization =="
# Deliberately NOT using Prefer: return=representation here — organizations
# has an AFTER INSERT trigger (handle_new_organization) that creates the
# owner's organization_members row, and requesting the inserted row back
# in the same statement trips a real RLS/RETURNING interaction (confirmed:
# same insert succeeds with a plain 201 and fails 403 with representation
# requested). Insert, then fetch separately by the unique slug instead.
ORG_SLUG="seed-test-org-${STAMP}"
curl -s -o /dev/null -w "" -X POST "$SUPABASE_URL/rest/v1/organizations" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MGR_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Seed Test Org\",\"slug\":\"$ORG_SLUG\",\"created_by\":\"$MGR_ID\"}"
ORG_ID=$(curl -s "$SUPABASE_URL/rest/v1/organizations?slug=eq.$ORG_SLUG&select=id" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MGR_TOKEN" | json "[0]['id']")
echo "  org id: $ORG_ID"

echo "== Creating tour =="
# Same trigger/representation issue as organizations (see note above) —
# tours carries the completion-lock trigger from 0005. Client-generated id
# instead of reading it back, matching the fix applied in the app itself
# (mobile/lib/ids.ts).
TOUR_ID=$(uuid)
curl -s -o /dev/null -X POST "$SUPABASE_URL/rest/v1/tours" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MGR_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"$TOUR_ID\",\"organization_id\":\"$ORG_ID\",\"name\":\"Seed Test Tour\",\"start_date\":\"2026-09-10\",\"end_date\":\"2026-10-15\",\"created_by\":\"$MGR_ID\"}"
echo "  tour id: $TOUR_ID"

echo "== Inviting crew account (department: production) =="
curl -s -X POST "$SUPABASE_URL/rest/v1/tour_invites" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $MGR_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"tour_id\":\"$TOUR_ID\",\"full_name\":\"Casey Crew\",\"email\":\"$CREW_EMAIL\",\"role\":\"crew\",\"department\":\"production\",\"invited_by\":\"$MGR_ID\"}" \
  > /dev/null

echo
echo "Done. Sign into the app as either account:"
echo "  Manager: $MGR_EMAIL / $PASSWORD"
echo "  Crew:    $CREW_EMAIL / $PASSWORD  (crew · production on \"Seed Test Tour\")"
echo
echo "To tear this down: sign in as the manager and delete the org from the"
echo "app once org management UI exists, or via the API:"
echo "  curl -X DELETE \"$SUPABASE_URL/rest/v1/organizations?id=eq.$ORG_ID\" \\"
echo "    -H \"apikey: $ANON_KEY\" -H \"Authorization: Bearer \$MGR_TOKEN\""