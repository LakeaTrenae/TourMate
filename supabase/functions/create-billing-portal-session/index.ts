// create-billing-portal-session — Supabase Edge Function (Deno)
//
// Creates a Stripe Billing Portal session so a signed-in user can update
// their payment method, view invoices, switch monthly/annual, or cancel
// their OWN individual Professional license — all inside Stripe's own
// hosted UI, opened via Linking.openURL the same way create-checkout-
// session's URL is. Same auth pattern as every other function here (see
// create-checkout-session's header) — no admin/org gate, since this only
// ever acts on the caller's own billing record.
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

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .single();
    if (profileError || !profile) return jsonResponse({ error: profileError?.message ?? "Profile not found" }, 404);
    if (!profile.stripe_customer_id) {
      return jsonResponse({ error: "You don't have a billing account yet — subscribe first." }, 400);
    }

    const session = await getStripe().billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: "tourmate://billing",
    });

    return jsonResponse({ url: session.url });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
