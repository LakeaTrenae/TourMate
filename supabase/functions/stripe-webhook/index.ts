// stripe-webhook — Supabase Edge Function (Deno)
//
// Genuinely new auth pattern for this codebase: every other function here
// requires a Supabase JWT (Authorization header + auth.getUser()) — this
// one is called directly by Stripe, which sends no Supabase JWT at all.
// Identity instead comes from verifying the raw request body against a
// Stripe-Signature header (stripe.webhooks.constructEventAsync) using a shared
// secret only Stripe and this function know (STRIPE_WEBHOOK_SECRET) — so
// `verify_jwt = false` is set for this function alone in config.toml, and
// this is the one place outside delete-account that legitimately needs
// the service_role client for its ENTIRE body, not just an escalation:
// there is no caller session to scope anything to.
//
// Handles: checkout.session.completed (first-time subscribe — org id
// comes from client_reference_id), customer.subscription.updated /
// .deleted (ongoing status changes — org id from subscription_data's
// metadata.organization_id, set at checkout time, falling back to a
// stripe_subscription_id lookup), invoice.payment_failed (logged only —
// the authoritative status change follows moments later via
// customer.subscription.updated, so writing from this event too would
// just race it).
import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@^22.4.0";

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

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Stripe's subscription statuses fold down onto the existing 5-value
// subscription_status enum (0001_init.sql) rather than growing the enum
// to match Stripe's vocabulary one-for-one — the app only ever needs to
// ask "is this org locked," a question these 5 values already answer.
// 'trialing' is unreachable in practice (no Stripe-side trial is used —
// see create-checkout-session), kept only for completeness/future-proofing.
function mapStripeStatus(status: Stripe.Subscription.Status): "trialing" | "active" | "past_due" | "canceled" {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "unpaid":
    case "incomplete":
    case "paused":
      return "past_due"; // recoverable — payment needs attention but Stripe hasn't fully canceled
    case "incomplete_expired":
      return "canceled"; // subscription never actually started; Stripe auto-canceled it
    default:
      return "past_due";
  }
}

async function updateOrgFromSubscription(orgId: string, subscription: Stripe.Subscription) {
  const price = subscription.items.data[0]?.price;
  const interval = price?.recurring?.interval === "year" ? "annual" : price?.recurring?.interval === "month" ? "monthly" : null;
  // current_period_end's location has moved between Stripe API versions
  // (subscription-item-level in newer ones, subscription-level in
  // older) — read whichever is actually present rather than assume one.
  const currentPeriodEnd =
    (subscription.items.data[0] as unknown as { current_period_end?: number })?.current_period_end ??
    (subscription as unknown as { current_period_end?: number }).current_period_end ??
    null;

  const { error } = await admin
    .from("organizations")
    .update({
      stripe_subscription_id: subscription.id,
      subscription_status: mapStripeStatus(subscription.status),
      subscription_interval: interval,
      stripe_price_id: price?.id ?? null,
      subscription_renews_at: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
    })
    .eq("id", orgId);
  if (error) console.error("Failed to update organization from subscription event:", error);
}

async function resolveOrgId(subscription: Stripe.Subscription): Promise<string | null> {
  const fromMetadata = subscription.metadata?.organization_id;
  if (fromMetadata) return fromMetadata;

  // Fallback for events that don't carry the metadata directly — look up
  // by the subscription id we stored on checkout.session.completed.
  const { data } = await admin
    .from("organizations")
    .select("id")
    .eq("stripe_subscription_id", subscription.id)
    .maybeSingle();
  return data?.id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok");
  }

  const signature = req.headers.get("Stripe-Signature");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!signature || !webhookSecret) {
    return new Response(JSON.stringify({ error: "Missing signature or webhook secret" }), { status: 400 });
  }

  // Read the RAW body — signature verification needs the exact bytes
  // Stripe signed, not a re-serialized JSON.parse() round-trip.
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = await getStripe().webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const orgId = session.client_reference_id;
        if (orgId && session.subscription) {
          const subscription = await getStripe().subscriptions.retrieve(
            typeof session.subscription === "string" ? session.subscription : session.subscription.id
          );
          if (session.customer) {
            await admin
              .from("organizations")
              .update({ billing_customer_id: typeof session.customer === "string" ? session.customer : session.customer.id })
              .eq("id", orgId);
          }
          await updateOrgFromSubscription(orgId, subscription);
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const orgId = await resolveOrgId(subscription);
        if (orgId) {
          if (event.type === "customer.subscription.deleted") {
            await admin
              .from("organizations")
              .update({ subscription_status: "canceled", stripe_subscription_id: null })
              .eq("id", orgId);
          } else {
            await updateOrgFromSubscription(orgId, subscription);
          }
        } else {
          console.error("Could not resolve organization for subscription event:", subscription.id);
        }
        break;
      }
      case "invoice.payment_failed": {
        // Logged only — see file header. The authoritative status change
        // arrives via customer.subscription.updated moments later.
        console.log("Invoice payment failed:", (event.data.object as Stripe.Invoice).id);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error("Error processing webhook event:", err);
    // Still 200 — Stripe retries on non-2xx, and a processing bug on our
    // side shouldn't cause Stripe to hammer this endpoint indefinitely.
    // The error is logged for investigation instead.
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
});
