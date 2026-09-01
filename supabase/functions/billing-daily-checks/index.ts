// billing-daily-checks — Supabase Edge Function (Deno)
//
// Scheduled once a day (see 0036_billing_notifications_and_seat_sync.sql's
// cron.schedule call) rather than invoked by a client or by Stripe. Same
// "no real caller session" situation as stripe-webhook, so identity comes
// from a shared secret (x-cron-secret header vs. the CRON_SECRET function
// secret) instead of a Supabase JWT — verify_jwt = false in config.toml.
//
// Does two unrelated things in one run purely because they're both cheap,
// once-a-day, whole-organizations-table sweeps:
//   1. Warns orgs whose trial ends within 3 days (once per trial, tracked
//      via organizations.trial_warning_sent_at) — closes the "hard lock
//      with zero notice" gap.
//   2. Resyncs seat count → Stripe quantity for every actively-subscribed
//      org, closing the gap where sync-org-seats only fires on manual
//      button-press or member *removal* — an invite acceptance (which
//      happens via a DB trigger, not a client screen) never had a natural
//      call site to resync from. Up to 24h of staleness between a roster
//      change and the Stripe quantity catching up, which is an acceptable
//      trade for "not pushing every single invite straight to Stripe" —
//      see sync-org-seats's own header for why that's deliberate.
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@^22.4.0";

function getStripe(): Stripe {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set — run `npx supabase secrets set STRIPE_SECRET_KEY=...`");
  return new Stripe(key);
}

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

async function orgAdminUserIds(orgId: string): Promise<string[]> {
  const { data } = await admin.from("organization_members").select("user_id").eq("organization_id", orgId).in("role", ["owner", "admin"]);
  return (data ?? []).map((r: { user_id: string }) => r.user_id);
}

async function runTrialWarnings() {
  const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const { data: orgs, error } = await admin
    .from("organizations")
    .select("id, name, trial_ends_at")
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
  for (const org of orgs ?? []) {
    const daysLeft = Math.max(1, Math.ceil((new Date(org.trial_ends_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
    const targets = await orgAdminUserIds(org.id);
    await sendPushToUsers(
      targets,
      `Trial ending soon — ${org.name}`,
      `Your free trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. Subscribe to keep your team's access.`,
      { type: "trial_ending", organizationId: org.id }
    );
    await admin.from("organizations").update({ trial_warning_sent_at: new Date().toISOString() }).eq("id", org.id);
    sent++;
  }
  return sent;
}

async function runSeatResync() {
  const { data: orgs, error } = await admin
    .from("organizations")
    .select("id, stripe_subscription_id")
    .eq("subscription_status", "active")
    .not("stripe_subscription_id", "is", null);
  if (error) {
    console.error("Seat resync query failed:", error);
    return 0;
  }

  let synced = 0;
  for (const org of orgs ?? []) {
    // Same query compute_org_seat_count runs, done directly here since
    // that RPC's is_member_of_org(..., auth.uid()) guard returns null for
    // any caller without a real auth session (see file header).
    const { data: tourMembers, error: countError } = await admin
      .from("tour_members")
      .select("user_id, tours!inner(organization_id)")
      .eq("tours.organization_id", org.id);
    if (countError) {
      console.error(`Seat count query failed for org ${org.id}:`, countError);
      continue;
    }
    const seatCount = Math.max(new Set((tourMembers ?? []).map((r: { user_id: string }) => r.user_id)).size, 1);

    try {
      const subscription = await getStripe().subscriptions.retrieve(org.stripe_subscription_id!);
      const item = subscription.items.data[0];
      if (item && item.quantity !== seatCount) {
        await getStripe().subscriptionItems.update(item.id, { quantity: seatCount });
        synced++;
      }
    } catch (err) {
      console.error(`Stripe seat resync failed for org ${org.id}:`, err);
    }
  }
  return synced;
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
    const [trialWarningsSent, seatSyncs] = await Promise.all([runTrialWarnings(), runSeatResync()]);
    return new Response(JSON.stringify({ trialWarningsSent, seatSyncs }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }), { status: 500 });
  }
});