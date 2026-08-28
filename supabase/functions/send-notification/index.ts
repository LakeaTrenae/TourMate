// send-notification — Supabase Edge Function (Deno)
//
// Dispatches a push notification to one or more tour members via Expo's
// push service. No third-party service beyond Expo's own (free) push
// API, and no secret needed for the sending side — Expo's push
// notification service doesn't require an API key to POST to.
//
// Authorization is the one thing here that has no precedent in
// extract-schedule/delete-account: those two only ever act on data the
// caller's own JWT already gates via RLS. A push send has no RLS
// backstop of its own — nothing stops a client from asking "send this
// notification to user X" for an arbitrary X. So this function verifies,
// under the caller's OWN JWT-scoped client (their real RLS applies),
// that the caller is themselves a member of `tourId`, and that every
// requested target is ALSO a member of that same tour — bounding the
// abuse surface to "already on this tour together," not "any guessable
// UUID." (This works as a plain SELECT because "tour_members readable by
// fellow tour members" is a whole-tour policy, not per-row: once you're
// confirmed a member of a tour, you can already see its full roster.)
//
// Only after that check passes does this switch to a service_role client
// (same escalation pattern as delete-account) to read push_tokens for
// the targets — push_tokens' own RLS is self-only, deliberately, so this
// is the one legitimate place that gets bypassed.
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

// Expo recommends batching at most 100 messages per push request.
const EXPO_PUSH_BATCH_SIZE = 100;

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

    const { tourId, targetUserIds, title, body, data } = await req.json();
    if (!tourId || !Array.isArray(targetUserIds) || targetUserIds.length === 0 || !title || !body) {
      return jsonResponse({ error: "Missing tourId, targetUserIds, title, or body" }, 400);
    }

    // Caller must be on this tour.
    const { data: isMember, error: memberError } = await supabase.rpc("is_tour_member", {
      p_tour_id: tourId,
      p_user_id: user.id,
    });
    if (memberError || !isMember) {
      return jsonResponse({ error: "Not a member of this tour." }, 403);
    }

    // Every target must be on this tour too — a plain SELECT under the
    // caller's own JWT, relying on tour_members' existing "readable by
    // fellow tour members" policy (whole-roster, not per-row) rather than
    // a new RPC.
    const { data: memberRows, error: rosterError } = await supabase
      .from("tour_members")
      .select("user_id")
      .eq("tour_id", tourId)
      .in("user_id", targetUserIds);
    if (rosterError) return jsonResponse({ error: rosterError.message }, 500);

    const validTargetIds = new Set((memberRows ?? []).map((r: { user_id: string }) => r.user_id));
    const authorizedTargets = (targetUserIds as string[]).filter((id) => validTargetIds.has(id));
    if (authorizedTargets.length === 0) {
      return jsonResponse({ success: true, sent: 0, note: "No targets are members of this tour." });
    }

    // Only now escalate — read push_tokens (self-only RLS otherwise) for
    // the authorized targets.
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: tokenRows, error: tokenError } = await admin
      .from("push_tokens")
      .select("expo_push_token")
      .in("user_id", authorizedTargets);
    if (tokenError) return jsonResponse({ error: tokenError.message }, 500);

    const tokens = (tokenRows ?? []).map((r: { expo_push_token: string }) => r.expo_push_token);
    if (tokens.length === 0) {
      return jsonResponse({ success: true, sent: 0, note: "No registered devices for these targets." });
    }

    const messages = tokens.map((to: string) => ({ to, title, body, data: data ?? {}, sound: "default" }));

    let sent = 0;
    for (let i = 0; i < messages.length; i += EXPO_PUSH_BATCH_SIZE) {
      const batch = messages.slice(i, i + EXPO_PUSH_BATCH_SIZE);
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(batch),
      });
      if (response.ok) {
        sent += batch.length;
      } else {
        console.error("Expo push batch failed:", await response.text());
      }
    }

    return jsonResponse({ success: true, sent });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
