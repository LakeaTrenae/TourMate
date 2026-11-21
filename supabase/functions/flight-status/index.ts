// flight-status — Supabase Edge Function (Deno)
//
// "Real-Time Flight Tracking" from Master Tour's feature list. Looks up a
// flight's live status via AviationStack's Flights API
// (https://api.aviationstack.com — field names below confirmed against
// their published response examples, not guessed) and writes the result
// onto the existing `flights` row (0040_setlists_flight_routing_calendar.sql's
// new columns).
//
// AviationStack over FlightAware's AeroAPI deliberately — its free tier
// needs no credit card on file (100 requests/month), which matters before
// this app has real paying traffic to justify a metered-billing API. The
// real limitation of that free tier: it only covers REAL-TIME flight
// data (today's flights), not historical or far-future ones — a lookup
// on a flight that isn't scheduled for today will come back empty. That's
// an acceptable tradeoff here: a flight's live status is only meaningful
// close to its actual departure day anyway, which is exactly when
// someone would realistically tap "Refresh live status." Revisit if a
// manager needs this further out; the Basic paid plan adds historical/
// future lookups with the same request shape.
//
// Requires an AVIATIONSTACK_API_KEY secret — sign up free (no card) at
// https://aviationstack.com/signup/free, then:
//   npx supabase secrets set AVIATIONSTACK_API_KEY=your-key-here
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

type AviationStackFlight = {
  flight_date: string; // YYYY-MM-DD
  flight_status: "scheduled" | "active" | "landed" | "cancelled" | "incident" | "diverted";
  departure: { scheduled: string | null; estimated: string | null; actual: string | null; delay: number | null };
  arrival: { scheduled: string | null; estimated: string | null; actual: string | null; delay: number | null };
};

// Unlike AeroAPI, AviationStack's own flight_status is already a clean,
// human-meaningful enum — no need to derive one from timestamps, just
// turn it (plus any delay minutes) into the short label the UI shows.
function describeStatus(f: AviationStackFlight): { status: string; detail: string } {
  const delay = f.departure.delay ?? f.arrival.delay;
  switch (f.flight_status) {
    case "cancelled":
      return { status: "cancelled", detail: "Cancelled" };
    case "diverted":
      return { status: "diverted", detail: "Diverted" };
    case "incident":
      return { status: "incident", detail: "Incident reported" };
    case "landed":
      return { status: "landed", detail: "Landed" };
    case "active":
      return { status: "en_route", detail: delay && delay > 5 ? `En Route — delayed ~${delay} min` : "En Route" };
    default:
      return { status: "scheduled", detail: delay && delay > 5 ? `Delayed ~${delay} min` : "On Time" };
  }
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

    const apiKey = Deno.env.get("AVIATIONSTACK_API_KEY");
    if (!apiKey) {
      return jsonResponse(
        { error: "AVIATIONSTACK_API_KEY is not set — sign up free (no card) at aviationstack.com/signup/free and run `npx supabase secrets set AVIATIONSTACK_API_KEY=...`" },
        500
      );
    }

    // flight_iata expects the airline IATA code + number with no space
    // (e.g. "DL1403") — same format flight_number is already stored in.
    const flightIata = encodeURIComponent(flight.flight_number.replace(/\s+/g, ""));
    const asRes = await fetch(
      `https://api.aviationstack.com/v1/flights?access_key=${apiKey}&flight_iata=${flightIata}`
    );
    if (!asRes.ok) {
      const body = await asRes.text();
      return jsonResponse({ error: `AviationStack lookup failed (${asRes.status}): ${body.slice(0, 300)}` }, 502);
    }
    const asData = (await asRes.json()) as { data?: AviationStackFlight[]; error?: { message: string } };
    if (asData.error) {
      return jsonResponse({ error: `AviationStack error: ${asData.error.message}` }, 502);
    }
    const flights = asData.data ?? [];
    if (flights.length === 0) {
      return jsonResponse(
        { error: `No live data for ${flight.flight_number} — the free AviationStack plan only covers flights scheduled for today, not ones further out.` },
        404
      );
    }

    // Pick whichever result's flight_date is closest to our own stored
    // departure date — the free real-time endpoint should really only
    // ever return one match (today's instance), but this stays robust if
    // it ever returns more than one.
    const targetDate = flight.departure_time.slice(0, 10);
    const best = flights.reduce((closest, f) =>
      Math.abs(new Date(f.flight_date).getTime() - new Date(targetDate).getTime()) <
      Math.abs(new Date(closest.flight_date).getTime() - new Date(targetDate).getTime())
        ? f
        : closest
    );

    const { status, detail } = describeStatus(best);

    const update = {
      status,
      status_detail: detail,
      actual_departure_time: best.departure.actual,
      actual_arrival_time: best.arrival.actual,
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
