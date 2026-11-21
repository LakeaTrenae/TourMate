// city-photo — Supabase Edge Function (Deno)
//
// Backs the "on the road" card on Tour Dashboard — a real photo of the
// next stop's city instead of a flat banner. Looks up a photo via
// Wikipedia's public REST summary endpoint
// (https://en.wikipedia.org/api/rest_v1/page/summary/<title>) and caches
// the result in city_photos (0046_city_photos.sql), keyed by (city,
// state), since a city's photo essentially never needs refetching.
//
// Originally built against Pexels' Search API, but Pexels paused new API
// key issuance before one could be requested for this project — swapped
// to Wikipedia instead, which needs NO key or account at all (just a
// descriptive User-Agent header, per Wikimedia's API etiquette policy:
// https://meta.wikimedia.org/wiki/User-Agent_policy), so this can never
// get blocked on a provisioning pause again. Tries "<City>, <State>"
// first, then falls back to the bare city name if that article doesn't
// exist or has no photo — e.g. "Nashville, Tennessee" has one, but a
// smaller town might only resolve under its bare name.
//
// This isn't tour-scoped data (a photo of "Nashville" is the same for
// every tour passing through it), so the only authorization check is
// "is this a signed-in user of the app at all" — no tour-membership
// lookup needed, unlike route-directions/flight-status.
//
// Wikipedia images are usually CC-BY-SA — the city_photos.photographer/
// photographer_url columns (named for the Pexels era) now carry
// "Wikipedia" and a link back to the source article rather than a named
// photographer, which is a reasonable-faith attribution for a city
// skyline photo but not a substitute for the specific file's own
// Commons license page if this ever needs to be audited more strictly.
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

const WIKIPEDIA_USER_AGENT = "TourMate/1.0 (touring production management app; city-photo edge function)";

type WikipediaSummary = {
  thumbnail?: { source: string };
  originalimage?: { source: string };
  content_urls?: { desktop?: { page?: string } };
};

async function searchWikipedia(city: string, state: string) {
  const titles = state ? [`${city}, ${state}`, city] : [city];
  for (const title of titles) {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
      headers: { "User-Agent": WIKIPEDIA_USER_AGENT },
    });
    if (!res.ok) continue; // 404 for this title — try the next fallback, not a hard error

    const data = (await res.json()) as WikipediaSummary;
    const photoUrl = data.originalimage?.source ?? data.thumbnail?.source;
    if (!photoUrl) continue; // article exists but has no photo (common for a disambiguation page)

    return { photoUrl, pageUrl: data.content_urls?.desktop?.page ?? null };
  }
  return null;
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

    const result = await searchWikipedia(city, normalizedState);
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
        photographer: "Wikipedia",
        photographer_url: result.pageUrl,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "city,state" }
    );

    return jsonResponse({ photoUrl: result.photoUrl, photographer: "Wikipedia", photographerUrl: result.pageUrl });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
