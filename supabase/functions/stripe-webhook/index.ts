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
// stripe_subscription_id lookup), invoice.payment_failed (pushes a
// notification to the org's owner/admin — does NOT write subscription_status
// itself, since the authoritative status change follows moments later via
// customer.subscription.updated and writing from both would race it).
//
// Every event is deduped by id against stripe_webhook_events
// (0036_billing_notifications_and_seat_sync.sql) before processing —
// Stripe explicitly documents that webhooks can be delivered more than
// once. The org-status writes above are naturally idempotent (they just
// overwrite with the latest state), but the payment-failed notification
// below is a side effect, not a state write, and side effects aren't
// idempotent for free — without the dedup, a redelivered event could
// alert an admin twice for the same failure.
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

// Duplicated from send-notification's own version rather than factored
// into a shared module — small enough, and this repo has no _shared/
// precedent yet. Expo's push API needs no API key to send to.
async function sendPushToUsers(userIds: string[], title: string, body: string, data?: Record<string, unknown>) {
  if (userIds.length === 0) return;
  const { data: tokenRows } = await admin.from("push_tokens").select("expo_push_token").in("user_id", userIds);
  const tokens = (tokenRows ?? []).map((r: { expo_push_token: string }) => r.expo_push_token);
  if (tokens.length === 0) return;
  const messages = tokens.map((to: string) => ({ to, title, body, data: data ?? {}, sound: "default" }));
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(messages),
  });
  if (!response.ok) console.error("Expo push failed:", await response.text());
}

async function notifyPaymentFailed(invoice: Stripe.Invoice) {
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;

  const { data: org } = await admin
    .from("organizations")
    .select("id, name, subscription_status")
    .eq("billing_customer_id", customerId)
    .maybeSingle();
  if (!org) return;

  // Only alert on the *first* failure for this billing cycle — once
  // customer.subscription.updated has already flipped the org to
  // past_due/canceled, Stripe's retry schedule will keep sending
  // invoice.payment_failed for the same underlying problem, and none of
  // those are new news to the admin.
  if (org.subscription_status === "past_due" || org.subscription_status === "canceled") return;

  const { data: members } = await admin
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", org.id)
    .in("role", ["owner", "admin"]);
  const targets = (members ?? []).map((r: { user_id: string }) => r.user_id);

  await sendPushToUsers(
    targets,
    `Payment failed — ${org.name}`,
    "We couldn't process your payment. Update your billing to avoid losing access.",
    { type: "payment_failed", organizationId: org.id }
  );
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

  // Dedup by event id — see file header. A unique-violation means we've
  // already processed this exact event; ack it without reprocessing.
  // Any other insert error fails open (still processes the event) rather
  // than silently dropping a real webhook over a transient DB hiccup.
  const { error: dedupError } = await admin.from("stripe_webhook_events").insert({ event_id: event.id });
  if (dedupError && dedupError.code === "23505") {
    return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 });
  }
  if (dedupError) {
    console.error("Webhook dedup insert failed (processing anyway):", dedupError);
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
        // Does not write subscription_status itself — see file header.
        const invoice = event.data.object as Stripe.Invoice;
        console.log("Invoice payment failed:", invoice.id);
        await notifyPaymentFailed(invoice);
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
