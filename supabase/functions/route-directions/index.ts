// route-directions — Supabase Edge Function (Deno)
//
// "Real-Time Routing Calculations" from Master Tour's feature list.
// RouteScreen.tsx previously only ever computed straight-line (Haversine)
// distance between shows — this calls Google's Routes API for a real
// driving distance/duration between each consecutive pair of tour dates
// that both have venue coordinates, and caches the result in
// route_segments (0040_setlists_flight_routing_calendar.sql) so a paid,
// rate-limited API isn't re-queried on every screen visit.
//
// Requires a GOOGLE_MAPS_API_KEY secret with the Routes API enabled —
// https://console.cloud.google.com/google/maps-apis/api-list, then:
//   npx supabase secrets set GOOGLE_MAPS_API_KEY=your-key-here
// Until that's set, this returns a clear 500 rather than a silently
// broken refresh button. The Routes API (routes.googleapis.com), not the
// older Distance Matrix API — Google's own docs mark Distance Matrix as
// legacy; Routes is the current, actively supported one.
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
  const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
      destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Routes API failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { routes?: { distanceMeters: number; duration: string }[] };
  const route = data.routes?.[0];
  if (!route) return null;
  // `duration` comes back as a serialized protobuf Duration string like
  // "5423s" — strip the trailing "s" rather than assume a numeric field.
  const seconds = parseFloat(route.duration.replace(/s$/, ""));
  return {
    distanceMiles: Math.round((route.distanceMeters / 1609.344) * 10) / 10,
    durationMinutes: Math.round(seconds / 60),
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

    const apiKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
    if (!apiKey) {
      return jsonResponse(
        { error: "GOOGLE_MAPS_API_KEY is not set — enable the Routes API at console.cloud.google.com/google/maps-apis and run `npx supabase secrets set GOOGLE_MAPS_API_KEY=...`" },
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
