// create-checkout-session — Supabase Edge Function (Deno)
//
// Creates a Stripe-hosted subscription Checkout Session for an org owner/
// admin to subscribe (or re-subscribe) — mode 'subscription', seat-based
// quantity, monthly or annual Price. The client opens the returned URL via
// Linking.openURL (system browser), never an in-app WebView — this is
// what keeps the app clear of Apple/Google's in-app-purchase rules for a
// B2B tool (see BillingScreen.tsx for the client side of this).
//
// Same auth pattern as every other function here: anon-scoped client +
// Authorization passthrough + auth.getUser() to identify the caller, then
// an RPC gate (is_org_admin — the same function organizations'/
// organization_members' own RLS policies use) before spending anything.
// No service_role needed — every write here (persisting a new
// billing_customer_id) happens under the caller's own JWT, since they've
// already been confirmed to be an owner/admin of this org.
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@^22.4.0";

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

// No pinned apiVersion — deliberately left to the SDK/account default
// rather than hardcoding a specific dated version string that might not
// exist by the time this runs. If a specific API version is ever needed
// (e.g. to match a webhook signing behavior), set it explicitly and
// verify against https://docs.stripe.com/api/versioning first.
//
// Constructed lazily, inside the request handler, not at module scope —
// constructing it eagerly at import time means a missing STRIPE_SECRET_KEY
// (e.g. before `npx supabase secrets set` has been run) crashes the whole
// worker on cold start with an opaque WORKER_ERROR, before any of this
// function's own error handling ever runs. Lazy construction turns that
// into a normal, catchable 500 with a real message instead.
function getStripe(): Stripe {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set — run `npx supabase secrets set STRIPE_SECRET_KEY=...`");
  return new Stripe(key);
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

    const { orgId, interval } = await req.json();
    if (!orgId || (interval !== "monthly" && interval !== "annual")) {
      return jsonResponse({ error: "orgId and interval ('monthly' | 'annual') are required" }, 400);
    }

    const { data: isAdmin, error: adminError } = await supabase.rpc("is_org_admin", {
      p_org_id: orgId,
      p_user_id: user.id,
    });
    if (adminError) return jsonResponse({ error: adminError.message }, 500);
    if (!isAdmin) return jsonResponse({ error: "Only an organization owner or admin can manage billing." }, 403);

    const { data: org, error: orgError } = await supabase
      .from("organizations")
      .select("name, billing_customer_id")
      .eq("id", orgId)
      .single();
    if (orgError || !org) return jsonResponse({ error: orgError?.message ?? "Organization not found" }, 404);

    // Reuse the existing Stripe Customer if this org has one (e.g.
    // re-subscribing after a lapse); create one otherwise. Persisted back
    // under the caller's own JWT — allowed since they already passed the
    // is_org_admin check above, matching organizations' own update policy.
    let customerId = org.billing_customer_id;
    if (!customerId) {
      const customer = await getStripe().customers.create({
        name: org.name,
        email: user.email,
        metadata: { organization_id: orgId },
      });
      customerId = customer.id;
      const { error: updateError } = await supabase
        .from("organizations")
        .update({ billing_customer_id: customerId })
        .eq("id", orgId);
      if (updateError) return jsonResponse({ error: updateError.message }, 500);
    }

    const { data: seatCount, error: seatError } = await supabase.rpc("compute_org_seat_count", { p_org_id: orgId });
    if (seatError) return jsonResponse({ error: seatError.message }, 500);

    const priceId =
      interval === "annual" ? Deno.env.get("STRIPE_PRICE_ANNUAL") : Deno.env.get("STRIPE_PRICE_MONTHLY");
    if (!priceId) return jsonResponse({ error: `Missing STRIPE_PRICE_${interval.toUpperCase()} secret` }, 500);

    // No trial_period_days here on purpose — the 7-day trial is tracked
    // entirely in organizations.trial_ends_at (org_billing_active reads
    // it directly). A second, Stripe-side trial clock on top would just
    // disagree with the DB one.
    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: Math.max(seatCount ?? 1, 1) }],
      client_reference_id: orgId,
      subscription_data: { metadata: { organization_id: orgId } },
      // Tells Stripe this Checkout Session was opened from a mobile app
      // (via the system browser) rather than a regular web page —
      // Stripe's own parameter for exactly this integration shape.
      origin_context: "mobile_app",
      success_url: "tourmate://billing?checkout=success",
      cancel_url: "tourmate://billing?checkout=cancel",
    });

    return jsonResponse({ url: session.url });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
