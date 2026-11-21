// city-photo — Supabase Edge Function (Deno)
//
// Backs the "on the road" card on Tour Dashboard — a real photo of the
// next stop's city instead of a flat banner. Looks up a landscape photo
// via Pexels' Search API (https://www.pexels.com/api/documentation/)
// and caches the result in city_photos (0046_city_photos.sql), keyed by
// (city, state), since a city's photo essentially never needs
// refetching — no point re-querying Pexels every time someone opens the
// same tour's dashboard.
//
// Pexels over Unsplash deliberately — Pexels' free tier (200 requests/
// hour, 20,000/month) needs no credit card and is far more generous than
// Unsplash's demo-tier 50/hour, which matters before this app has real
// paying traffic to justify anything metered. Same "pick the free option
// first" call already made for routing (OpenRouteService) and flight
// tracking (AviationStack).
//
// Requires a PEXELS_API_KEY secret — sign up free (no card) at
// https://www.pexels.com/api/, then:
//   npx supabase secrets set PEXELS_API_KEY=your-key-here
// Until that's set, this returns a clear 500 rather than a silently
// missing photo.
//
// This isn't tour-scoped data (a photo of "Nashville" is the same for
// every tour passing through it), so the only authorization check is
// "is this a signed-in user of the app at all" — no tour-membership
// lookup needed, unlike route-directions/flight-status.
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

// A city's skyline doesn't change — this just bounds how long a bad/
// placeholder result could stick around rather than reflecting any real
// need to refresh.
const CACHE_MAX_AGE_DAYS = 180;

type PexelsPhoto = {
  url: string;
  photographer: string;
  src: { large2x: string; large: string };
};

async function searchPexels(apiKey: string, city: string, state: string) {
  const query = state ? `${city}, ${state}` : city;
  const res = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`,
    { headers: { Authorization: apiKey } }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Pexels failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { photos?: PexelsPhoto[] };
  const photo = data.photos?.[0];
  if (!photo) return null;
  return {
    photoUrl: photo.src.large2x ?? photo.src.large,
    photographer: photo.photographer,
    photographerUrl: photo.url,
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

    const { city, state } = await req.json();
    if (!city) return jsonResponse({ error: "city is required" }, 400);
    const normalizedState = (state ?? "").trim();

    const cutoff = new Date(Date.now() - CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: cached } = await admin
      .from("city_photos")
      .select("photo_url, photographer, photographer_url, fetched_at")
      .eq("city", city)
      .eq("state", normalizedState)
      .maybeSingle();

    if (cached && cached.fetched_at > cutoff) {
      return jsonResponse({
        photoUrl: cached.photo_url,
        photographer: cached.photographer,
        photographerUrl: cached.photographer_url,
      });
    }

    const apiKey = Deno.env.get("PEXELS_API_KEY");
    if (!apiKey) {
      return jsonResponse(
        { error: "PEXELS_API_KEY is not set — sign up free (no card) at pexels.com/api and run `npx supabase secrets set PEXELS_API_KEY=...`" },
        500
      );
    }

    const result = await searchPexels(apiKey, city, normalizedState);
    if (!result) {
      // No crash, no stale cache write — just "nothing found," which the
      // client already handles by not rendering the card at all.
      return jsonResponse({ photoUrl: null });
    }

    await admin.from("city_photos").upsert(
      {
        city,
        state: normalizedState,
        photo_url: result.photoUrl,
        photographer: result.photographer,
        photographer_url: result.photographerUrl,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "city,state" }
    );

    return jsonResponse({ photoUrl: result.photoUrl, photographer: result.photographer, photographerUrl: result.photographerUrl });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
