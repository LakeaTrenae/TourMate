// calendar-feed — Supabase Edge Function (Deno)
//
// "Calendar Subscriptions" from Master Tour's feature list: a real
// webcal:// URL a calendar app polls periodically and stays synced to
// forever, unlike TourExportScreen's existing one-time .ics file share.
//
// A calendar app has no way to send a Supabase JWT (no login flow at
// all), so identity here comes from `?token=`, matched against
// profiles.calendar_feed_token (0040_setlists_flight_routing_calendar.sql)
// — a stable per-user secret the user gets from Settings and pastes into
// their calendar app once. Same "no real caller session" shape as
// stripe-webhook/billing-daily-checks, hence verify_jwt = false and a
// service_role client for the whole request.
//
// ICS generation is duplicated from lib/ics.ts's buildTourIcs rather than
// shared across the mobile/Deno runtime boundary — same small-helper-
// duplication precedent as sendPushToUsers in the other functions here.
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toIcsDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  return `${y}${m}${d}`;
}

function escapeIcsText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
}

function foldLine(line: string): string {
  if (line.length <= 75) return line;
  let result = line.slice(0, 75);
  let rest = line.slice(75);
  while (rest.length > 0) {
    result += `\r\n ${rest.slice(0, 74)}`;
    rest = rest.slice(74);
  }
  return result;
}

type ShowRow = {
  id: string;
  date: string;
  load_in: string | null;
  doors: string | null;
  set_time: string | null;
  tour: { name: string } | null;
  venue: { name: string; city: string | null } | null;
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return new Response("Missing ?token=", { status: 400 });
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id")
    .eq("calendar_feed_token", token)
    .maybeSingle();
  if (profileError || !profile) {
    return new Response("Invalid or revoked calendar feed token", { status: 404 });
  }

  // Every tour this person belongs to, via either membership path (same
  // dual-source union TourListScreen's own query relies on RLS for) —
  // here there's no RLS to lean on (service_role bypasses it), so both
  // sources are unioned explicitly.
  const [orgToursRes, tourMemberToursRes] = await Promise.all([
    admin
      .from("organization_members")
      .select("organization:organizations(tours(id))")
      .eq("user_id", profile.id),
    admin.from("tour_members").select("tour_id").eq("user_id", profile.id),
  ]);

  const tourIds = new Set<string>();
  for (const row of (orgToursRes.data ?? []) as unknown as { organization: { tours: { id: string }[] } | null }[]) {
    for (const t of row.organization?.tours ?? []) tourIds.add(t.id);
  }
  for (const row of (tourMemberToursRes.data ?? []) as { tour_id: string }[]) tourIds.add(row.tour_id);

  let shows: ShowRow[] = [];
  if (tourIds.size > 0) {
    const { data } = await admin
      .from("tour_dates")
      .select("id, date, load_in, doors, set_time, tour:tours(name), venue:venues(name, city)")
      .in("tour_id", Array.from(tourIds))
      .order("date", { ascending: true });
    shows = (data ?? []) as unknown as ShowRow[];
  }

  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TourMate//Calendar Subscription//EN",
    "CALSCALE:GREGORIAN",
    // Tells a subscribing calendar app how often to re-poll — without
    // this most clients default to a much longer interval (sometimes a
    // full day), which would defeat the point of a "live" subscription.
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];

  for (const show of shows) {
    const tourName = show.tour?.name ?? "Tour";
    const summaryParts = [show.venue?.name, show.venue?.city].filter(Boolean);
    const summary = summaryParts.length > 0 ? summaryParts.join(", ") : tourName;
    const descriptionParts = [
      show.load_in ? `Load-in: ${show.load_in}` : null,
      show.doors ? `Doors: ${show.doors}` : null,
      show.set_time ? `Set: ${show.set_time}` : null,
    ].filter(Boolean);

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${show.id}@tourmate`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${toIcsDate(show.date)}`);
    lines.push(foldLine(`SUMMARY:${escapeIcsText(`${tourName} — ${summary}`)}`));
    if (descriptionParts.length > 0) {
      lines.push(foldLine(`DESCRIPTION:${escapeIcsText(descriptionParts.join("\\n"))}`));
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  return new Response(lines.join("\r\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="tourmate.ics"',
      "Cache-Control": "no-cache",
    },
  });
});
