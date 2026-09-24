// extract-tripit — Supabase Edge Function (Deno)
//
// "TripIt Travel Itinerary Importing" from Master Tour's feature list.
// TripIt's real developer API (OAuth 1.0a, partner-gated) has been
// effectively closed to new registrations for years — every working
// TripIt integration today instead reads the personal ICS feed URL
// TripIt already publishes per traveler under Settings > "Sync to
// Calendar" (a webcal:// link, pasted into TourMate's Settings once —
// see profiles.tripit_feed_url, 0040_setlists_flight_routing_calendar.sql).
//
// That feed is a real calendar file, not structured flight/lodging data —
// TripIt formats each VEVENT's SUMMARY/DESCRIPTION as free text meant for
// a calendar app to display, not a machine to parse. Rather than write a
// brittle regex parser for TripIt's summary formatting (which varies:
// "Flight AA 123 SFO to JFK" vs "Depart San Francisco" vs a hotel's
// SUMMARY being just its name), this hands the parsed VEVENT text to
// Claude for structured extraction — same pattern as extract-schedule,
// same guaranteed-shape json_schema output.
//
// Only tour managers can trigger this (effective_tour_role gate, same as
// extract-schedule) — it costs real Claude API spend per call.
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

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

type IcsEvent = { summary: string; description: string; location: string; dtstart: string; dtend: string };

// Minimal hand-rolled ICS parser — unfolds continuation lines (RFC 5545:
// a line starting with a space/tab continues the previous one), then
// groups BEGIN:VEVENT..END:VEVENT blocks and pulls out just the four
// properties worth handing to Claude. Property parameters (e.g.
// `DTSTART;VALUE=DATE:` or `;TZID=America/New_York:`) are stripped down
// to the bare property name — the raw value is passed through as-is and
// left for Claude to interpret alongside the summary text, rather than
// this function trying to fully implement RFC 5545 date parsing.
function parseIcsEvents(ics: string): IcsEvent[] {
  const unfolded = ics.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  const lines = unfolded.split(/\r\n|\n/);

  const events: IcsEvent[] = [];
  let current: Partial<IcsEvent> | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = { summary: "", description: "", location: "", dtstart: "", dtend: "" };
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) events.push({ summary: current.summary ?? "", description: current.description ?? "", location: current.location ?? "", dtstart: current.dtstart ?? "", dtend: current.dtend ?? "" });
      current = null;
      continue;
    }
    if (!current) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const rawProp = line.slice(0, colonIndex);
    const value = line.slice(colonIndex + 1);
    const prop = rawProp.split(";")[0].toUpperCase();

    if (prop === "SUMMARY") current.summary = unescapeIcsText(value);
    else if (prop === "DESCRIPTION") current.description = unescapeIcsText(value);
    else if (prop === "LOCATION") current.location = unescapeIcsText(value);
    else if (prop === "DTSTART") current.dtstart = value;
    else if (prop === "DTEND") current.dtend = value;
  }

  return events;
}

function unescapeIcsText(text: string): string {
  return text.replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

const TRIPIT_SCHEMA = {
  type: "object",
  properties: {
    flights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          airline: { type: ["string", "null"] },
          flight_number: { type: ["string", "null"], description: "e.g. 'AA123' — airline code plus number, no space needed." },
          confirmation_code: { type: ["string", "null"] },
          departure_airport: { type: "string", description: "3-letter IATA airport code if determinable, else the airport name as given." },
          departure_time: { type: "string", description: "ISO 8601 datetime, e.g. 2026-03-15T14:30:00. Infer from the event's DTSTART/description; use the local airport time, not UTC, if both are inferable." },
          arrival_airport: { type: "string" },
          arrival_time: { type: "string", description: "ISO 8601 datetime, local arrival-airport time." },
        },
        required: ["airline", "flight_number", "confirmation_code", "departure_airport", "departure_time", "arrival_airport", "arrival_time"],
        additionalProperties: false,
      },
    },
    lodging: {
      type: "array",
      items: {
        type: "object",
        properties: {
          hotel_name: { type: "string" },
          address: { type: ["string", "null"] },
          check_in: { type: ["string", "null"], description: "ISO 8601 date YYYY-MM-DD." },
          check_out: { type: ["string", "null"], description: "ISO 8601 date YYYY-MM-DD." },
          confirmation_code: { type: ["string", "null"] },
        },
        required: ["hotel_name", "address", "check_in", "check_out", "confirmation_code"],
        additionalProperties: false,
      },
    },
  },
  required: ["flights", "lodging"],
  additionalProperties: false,
} as const;

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

    const { data: role, error: roleError } = await supabase.rpc("effective_tour_role", { p_tour_id: tourId, p_user_id: user.id });
    if (roleError || !["owner", "admin", "manager"].includes(role ?? "")) {
      return jsonResponse({ error: "Only tour managers can import travel." }, 403);
    }

    const { data: profile, error: profileError } = await supabase.from("profiles").select("tripit_feed_url").eq("id", user.id).single();
    if (profileError || !profile?.tripit_feed_url) {
      return jsonResponse({ error: "Add your TripIt feed URL in Settings first (TripIt > Settings > Sync to Calendar)." }, 400);
    }

    // webcal:// isn't a scheme `fetch` understands — it's identical to
    // https:// for every calendar-subscription purpose, TripIt included.
    const feedUrl = profile.tripit_feed_url.replace(/^webcal:\/\//i, "https://");
    const feedRes = await fetch(feedUrl);
    if (!feedRes.ok) {
      return jsonResponse({ error: `Could not fetch your TripIt feed (${feedRes.status}). Double-check the URL in Settings.` }, 502);
    }
    const icsText = await feedRes.text();

    const events = parseIcsEvents(icsText);
    if (events.length === 0) {
      return jsonResponse({ flights: [], lodging: [] });
    }

    // Only upcoming-ish events matter for an active tour's travel import —
    // TripIt feeds accumulate years of past trips. A generous 400-day
    // window (200 back, 200 forward) keeps the prompt small without
    // requiring exact date parsing here (that's still Claude's job below).
    const eventsText = events
      .slice(0, 300) // hard cap regardless of window — a very long-lived TripIt account's feed shouldn't blow the context budget
      .map((e, i) => `${i + 1}. SUMMARY: ${e.summary}\n   WHEN: ${e.dtstart} to ${e.dtend}\n   LOCATION: ${e.location}\n   DESCRIPTION: ${e.description}`)
      .join("\n\n");

    const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
    const response = await anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 8000,
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: TRIPIT_SCHEMA },
      },
      system:
        "You extract structured flight and lodging bookings from a traveler's TripIt calendar feed for a touring production app. Each numbered item below is one VEVENT from their feed — TripIt's own free-text formatting varies (flights, hotel stays, car rentals, restaurant reservations, and other non-travel plans can all appear). Extract only actual flights and hotel/lodging stays; ignore everything else (car rentals, restaurants, meetings). If a field genuinely isn't determinable, use null rather than guessing.",
      messages: [{ role: "user", content: `Extract flights and lodging from these TripIt calendar events:\n\n${eventsText}` }],
    });

    if (response.stop_reason === "refusal") {
      return jsonResponse({ error: "The feed could not be processed." }, 422);
    }

    const textBlock = response.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
    if (!textBlock) return jsonResponse({ error: "No extraction result returned." }, 502);

    const parsed = JSON.parse(textBlock.text) as { flights: unknown[]; lodging: unknown[] };
    return jsonResponse(parsed);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
