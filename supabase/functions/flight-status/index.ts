// flight-status — Supabase Edge Function (Deno)
//
// "Real-Time Flight Tracking with FlightAware" from Master Tour's feature
// list. Looks up a flight's live status via FlightAware's AeroAPI
// (https://aeroapi.flightaware.com — field names below confirmed against
// their published OpenAPI spec, not guessed) and writes the result onto
// the existing `flights` row (0040_setlists_flight_routing_calendar.sql's
// new columns).
//
// Requires a FLIGHTAWARE_API_KEY secret — sign up for AeroAPI at
// https://www.flightaware.com/commercial/aeroapi/ (paid, usage-based —
// there's no free tier) and run:
//   npx supabase secrets set FLIGHTAWARE_API_KEY=your-key-here
// Until that's set, this function returns a clear 500 explaining exactly
// that, rather than a flight silently never updating.
//
// Auth is two-stage, same escalation pattern as billing's edge functions:
// the flight lookup happens under the CALLER's own JWT first, so
// "flights readable by managers"/"flights readable by assigned passenger"
// (0001_init.sql) does the real authorization check — if that select
// returns nothing, the caller genuinely can't see this flight, full stop.
// Only the actual UPDATE afterward needs service_role, since a passenger
// (as opposed to a manager) has read-only RLS access to `flights` and
// this refresh should work for both.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type AeroApiFlight = {
  ident: string;
  scheduled_out: string | null;
  estimated_out: string | null;
  actual_out: string | null;
  estimated_in: string | null;
  actual_in: string | null;
  departure_delay: number | null; // seconds
  cancelled: boolean;
  diverted: boolean;
};

// AeroAPI has no single free-text "status" field on a flight object (its
// schema only exposes cancelled/diverted plus the actual/estimated
// timestamps) — this derives the same kind of human summary Master Tour
// shows from those, rather than inventing a field that doesn't exist.
function deriveStatus(f: AeroApiFlight): { status: string; detail: string } {
  if (f.cancelled) return { status: "cancelled", detail: "Cancelled" };
  if (f.diverted) return { status: "diverted", detail: "Diverted" };
  if (f.actual_in) return { status: "landed", detail: "Landed" };
  if (f.actual_out) return { status: "en_route", detail: "En Route" };
  if (f.departure_delay && f.departure_delay > 300) {
    return { status: "delayed", detail: `Delayed ~${Math.round(f.departure_delay / 60)} min` };
  }
  return { status: "scheduled", detail: "On Time" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) return jsonResponse({ error: "Not authenticated" }, 401);

    const { flightId } = await req.json();
    if (!flightId) return jsonResponse({ error: "flightId is required" }, 400);

    // Caller-scoped select — RLS is the real authorization check here.
    const { data: flight, error: flightError } = await supabase
      .from("flights")
      .select("id, flight_number, departure_time")
      .eq("id", flightId)
      .single();
    if (flightError || !flight) return jsonResponse({ error: "Flight not found, or you don't have access to it." }, 404);
    if (!flight.flight_number) return jsonResponse({ error: "This flight has no flight number set." }, 400);

    const apiKey = Deno.env.get("FLIGHTAWARE_API_KEY");
    if (!apiKey) {
      return jsonResponse(
        { error: "FLIGHTAWARE_API_KEY is not set — sign up for AeroAPI at flightaware.com/commercial/aeroapi and run `npx supabase secrets set FLIGHTAWARE_API_KEY=...`" },
        500
      );
    }

    // Query a ±2 day window around the stored departure time — AeroAPI
    // returns every recent/scheduled flight under this ident, and a
    // flight number alone (e.g. "AA123") isn't unique across dates.
    const departure = new Date(flight.departure_time);
    const start = new Date(departure.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(departure.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const ident = encodeURIComponent(flight.flight_number.replace(/\s+/g, ""));

    const aeroRes = await fetch(
      `https://aeroapi.flightaware.com/aeroapi/flights/${ident}?start=${start}&end=${end}&max_pages=1`,
      { headers: { "x-apikey": apiKey, Accept: "application/json" } }
    );
    if (!aeroRes.ok) {
      const body = await aeroRes.text();
      return jsonResponse({ error: `FlightAware lookup failed (${aeroRes.status}): ${body.slice(0, 300)}` }, 502);
    }
    const aeroData = (await aeroRes.json()) as { flights?: AeroApiFlight[] };
    const flights = aeroData.flights ?? [];
    if (flights.length === 0) {
      return jsonResponse({ error: `No FlightAware data found for ${flight.flight_number} near this date.` }, 404);
    }

    // Pick whichever result's scheduled departure is closest to our own
    // stored time — the ident-only query can return more than one date.
    const target = departure.getTime();
    const best = flights.reduce((closest, f) => {
      const t = f.scheduled_out ? new Date(f.scheduled_out).getTime() : Infinity;
      const closestT = closest.scheduled_out ? new Date(closest.scheduled_out).getTime() : Infinity;
      return Math.abs(t - target) < Math.abs(closestT - target) ? f : closest;
    });

    const { status, detail } = deriveStatus(best);

    const update = {
      status,
      status_detail: detail,
      actual_departure_time: best.actual_out,
      actual_arrival_time: best.actual_in,
      status_checked_at: new Date().toISOString(),
    };
    const { error: updateError } = await admin.from("flights").update(update).eq("id", flightId);
    if (updateError) return jsonResponse({ error: updateError.message }, 500);

    return jsonResponse({ ...update });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
