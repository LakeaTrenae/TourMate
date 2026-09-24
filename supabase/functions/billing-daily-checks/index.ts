// billing-daily-checks — Supabase Edge Function (Deno)
//
// Scheduled once a day (see 0036_billing_notifications_and_seat_sync.sql's
// cron.schedule call) rather than invoked by a client or by Stripe. Same
// "no real caller session" situation as stripe-webhook, so identity comes
// from a shared secret (x-cron-secret header vs. the CRON_SECRET function
// secret) instead of a Supabase JWT — verify_jwt = false in config.toml.
//
// Per-user billing, not per-org (0037_per_user_billing.sql): warns
// individuals whose own trial ends within 3 days (once per trial, tracked
// via profiles.trial_warning_sent_at) — closes the "soft-demote with zero
// notice" gap. There's no seat-resync sweep anymore — "seats" don't exist
// under this model; crew access is free and unlimited, and everyone else
// pays for their own individual access regardless of anyone else's roster.
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Expo's push API needs no API key to send to. Duplicated from
// send-notification's own version rather than factored into a shared
// module — small enough, and this repo has no _shared/ precedent yet.
async function sendPushToUsers(userIds: string[], title: string, body: string, data?: Record<string, unknown>) {
  if (userIds.length === 0) return 0;
  const { data: tokenRows } = await admin.from("push_tokens").select("expo_push_token").in("user_id", userIds);
  const tokens = (tokenRows ?? []).map((r: { expo_push_token: string }) => r.expo_push_token);
  if (tokens.length === 0) return 0;
  const messages = tokens.map((to: string) => ({ to, title, body, data: data ?? {}, sound: "default" }));
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(messages),
  });
  if (!response.ok) {
    console.error("Expo push failed:", await response.text());
    return 0;
  }
  return tokens.length;
}

async function runTrialWarnings() {
  const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const { data: users, error } = await admin
    .from("profiles")
    .select("id, trial_ends_at")
    .eq("subscription_status", "trialing")
    .not("trial_ends_at", "is", null)
    .lte("trial_ends_at", in3Days)
    .gt("trial_ends_at", new Date().toISOString())
    .is("trial_warning_sent_at", null);
  if (error) {
    console.error("Trial warning query failed:", error);
    return 0;
  }

  let sent = 0;
  for (const user of users ?? []) {
    const daysLeft = Math.max(1, Math.ceil((new Date(user.trial_ends_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
    await sendPushToUsers(
      [user.id],
      "Trial ending soon",
      `Your free trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Subscribe to keep your manager access.`,
      { type: "trial_ending" }
    );
    await admin.from("profiles").update({ trial_warning_sent_at: new Date().toISOString() }).eq("id", user.id);
    sent++;
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok");
  }

  const provided = req.headers.get("x-cron-secret");
  const expected = Deno.env.get("CRON_SECRET");
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  try {
    const trialWarningsSent = await runTrialWarnings();
    return new Response(JSON.stringify({ trialWarningsSent }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }), { status: 500 });
  }
});
