// route-directions — Supabase Edge Function (Deno)
//
// "Real-Time Routing Calculations" from Master Tour's feature list.
// RouteScreen.tsx previously only ever computed straight-line (Haversine)
// distance between shows — this calls OpenRouteService's Directions API
// for a real driving distance/duration between each consecutive pair of
// tour dates that both have venue coordinates, and caches the result in
// route_segments (0040_setlists_flight_routing_calendar.sql) so a
// rate-limited API isn't re-queried on every screen visit.
//
// OpenRouteService (openrouteservice.org, backed by Heidelberg University's
// HeiGIT) over Google's Routes API deliberately — its free tier needs no
// credit card on file at all (2,000 directions requests/day, 40/min),
// which matters before this app has real paying traffic to justify
// Google's billing-account requirement. Revisit if usage ever outgrows
// that cap; Google's Routes API remains a drop-in swap at that point
// (same cache table/shape, just a different computeRoute()).
//
// Requires an OPENROUTESERVICE_API_KEY secret — sign up free (no card) at
// https://openrouteservice.org/dev/#/signup, then:
//   npx supabase secrets set OPENROUTESERVICE_API_KEY=your-key-here
// Until that's set, this returns a clear 500 rather than a silently
// broken refresh button.
//
// Any tour member can trigger this (mirrors RouteScreen's own visibility
// — the route view has never been manager-gated), verified the same way
// every other authenticated function here does: is_tour_member/
// effective_tour_role under the CALLER's own JWT, not a service-role
// bypass, so RLS is still the real gate on who can even see this tour's
// dates in the first place.
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

// Cached segments older than this are treated as stale and recomputed —
// a driving route between two fixed venues essentially never changes,
// but this bounds how long a bad/one-off API response could stick around.
const CACHE_MAX_AGE_DAYS = 30;

type TourDateRow = { id: string; date: string; venue: { latitude: number | null; longitude: number | null } | null };

async function computeRoute(apiKey: string, from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
  // OpenRouteService takes coordinates as [lng, lat] (GeoJSON order, not
  // [lat, lng]) — easy to get backwards and silently route somewhere
  // wrong rather than error, so this is called out explicitly here.
  const res = await fetch("https://api.openrouteservice.org/v2/directions/driving-car", {
    method: "POST",
    headers: {
      // No "Bearer " prefix — OpenRouteService takes the raw key as the
      // entire Authorization header value.
      Authorization: apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      coordinates: [
        [from.lng, from.lat],
        [to.lng, to.lat],
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouteService failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { routes?: { summary: { distance: number; duration: number } }[] };
  const route = data.routes?.[0];
  if (!route) return null;
  return {
    distanceMiles: Math.round((route.summary.distance / 1609.344) * 10) / 10,
    durationMinutes: Math.round(route.summary.duration / 60),
  };
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

    const { tourId } = await req.json();
    if (!tourId) return jsonResponse({ error: "tourId is required" }, 400);

    // Caller-scoped select — RLS ("tours readable by members") is the
    // real authorization check; an empty result for a real tour id means
    // this caller isn't actually on it.
    const { data: dates, error: datesError } = await supabase
      .from("tour_dates")
      .select("id, date, venue:venues(latitude, longitude)")
      .eq("tour_id", tourId)
      .order("date", { ascending: true });
    if (datesError) return jsonResponse({ error: datesError.message }, 500);

    const rows = (dates ?? []) as unknown as TourDateRow[];
    const withCoords = rows.filter((r) => r.venue?.latitude != null && r.venue?.longitude != null);

    if (withCoords.length < 2) {
      return jsonResponse({ segments: [] });
    }

    const apiKey = Deno.env.get("OPENROUTESERVICE_API_KEY");
    if (!apiKey) {
      return jsonResponse(
        { error: "OPENROUTESERVICE_API_KEY is not set — sign up free (no card) at openrouteservice.org/dev/#/signup and run `npx supabase secrets set OPENROUTESERVICE_API_KEY=...`" },
        500
      );
    }

    const cutoff = new Date(Date.now() - CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const segments: { from_tour_date_id: string; to_tour_date_id: string; distance_miles: number; duration_minutes: number }[] = [];

    for (let i = 0; i < withCoords.length - 1; i++) {
      const from = withCoords[i];
      const to = withCoords[i + 1];

      const { data: cached } = await admin
        .from("route_segments")
        .select("distance_miles, duration_minutes, computed_at")
        .eq("from_tour_date_id", from.id)
        .eq("to_tour_date_id", to.id)
        .maybeSingle();

      if (cached && cached.computed_at > cutoff) {
        segments.push({
          from_tour_date_id: from.id,
          to_tour_date_id: to.id,
          distance_miles: cached.distance_miles,
          duration_minutes: cached.duration_minutes,
        });
        continue;
      }

      const result = await computeRoute(
        apiKey,
        { lat: from.venue!.latitude!, lng: from.venue!.longitude! },
        { lat: to.venue!.latitude!, lng: to.venue!.longitude! }
      );
      if (!result) continue;

      await admin.from("route_segments").upsert(
        {
          from_tour_date_id: from.id,
          to_tour_date_id: to.id,
          distance_miles: result.distanceMiles,
          duration_minutes: result.durationMinutes,
          computed_at: new Date().toISOString(),
        },
        { onConflict: "from_tour_date_id,to_tour_date_id" }
      );
      segments.push({
        from_tour_date_id: from.id,
        to_tour_date_id: to.id,
        distance_miles: result.distanceMiles,
        duration_minutes: result.durationMinutes,
      });
    }

    return jsonResponse({ segments });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
