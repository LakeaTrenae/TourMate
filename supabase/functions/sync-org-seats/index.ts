// sync-org-seats — Supabase Edge Function (Deno)
//
// Manual "Sync Seats" action (BillingScreen) — recomputes the org's live
// seat count (compute_org_seat_count RPC) and pushes it as the quantity
// on the org's active Stripe subscription item. Deliberately manual, not
// automatic on every tour_members change: an org's roster can change
// often (invites, removals), and auto-pushing every change straight to
// Stripe would mean unpredictable, frequent proration charges. A v1
// scope decision, not an oversight — see the plan's "Seat-count sync to
// Stripe post-checkout" section for the reasoning and the automatic-sync
// fast-follow this could become.
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

// No pinned apiVersion — see create-checkout-session's header for why.
// Constructed lazily inside the handler, not at module scope — see
// create-checkout-session's getStripe() comment for why (avoids a
// worker-crashing WORKER_ERROR if STRIPE_SECRET_KEY isn't set yet).
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

    const { orgId } = await req.json();
    if (!orgId) return jsonResponse({ error: "orgId is required" }, 400);

    const { data: isAdmin, error: adminError } = await supabase.rpc("is_org_admin", {
      p_org_id: orgId,
      p_user_id: user.id,
    });
    if (adminError) return jsonResponse({ error: adminError.message }, 500);
    if (!isAdmin) return jsonResponse({ error: "Only an organization owner or admin can manage billing." }, 403);

    const { data: org, error: orgError } = await supabase
      .from("organizations")
      .select("stripe_subscription_id")
      .eq("id", orgId)
      .single();
    if (orgError || !org) return jsonResponse({ error: orgError?.message ?? "Organization not found" }, 404);
    if (!org.stripe_subscription_id) {
      return jsonResponse({ error: "This organization has no active subscription to sync." }, 400);
    }

    const { data: seatCount, error: seatError } = await supabase.rpc("compute_org_seat_count", { p_org_id: orgId });
    if (seatError) return jsonResponse({ error: seatError.message }, 500);

    const subscription = await getStripe().subscriptions.retrieve(org.stripe_subscription_id);
    const item = subscription.items.data[0];
    if (!item) return jsonResponse({ error: "Subscription has no line items to update." }, 500);

    await getStripe().subscriptionItems.update(item.id, { quantity: Math.max(seatCount ?? 1, 1) });

    return jsonResponse({ seatCount: Math.max(seatCount ?? 1, 1) });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
