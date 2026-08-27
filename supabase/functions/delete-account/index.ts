// delete-account — Supabase Edge Function (Deno)
//
// Permanently deletes the CALLING user's own account. Apple requires any
// app that supports account creation to offer in-app account deletion, or
// App Store review rejects the submission outright — this exists to
// satisfy that, not just as a nice-to-have.
//
// Deleting the auth.users row cascades cleanly through the app's data
// (profiles -> organization_members/tour_members/flight_passengers/etc,
// all ON DELETE CASCADE — see 0001_init.sql and friends). Historical
// records they created (tours, documents, budget entries, invites) are
// NOT deleted — their "created_by"/"uploaded_by" reference just clears to
// null instead, per 0019_creator_columns_deletable.sql. The tour's actual
// history survives; only "who did this" for their own past actions is
// forgotten.
//
// This is the one place in the app that legitimately needs the
// service_role key — auth.admin.deleteUser() isn't available under RLS
// no matter who's asking, by design. Supabase auto-provides
// SUPABASE_SERVICE_ROLE_KEY as an edge function env var; nothing extra to
// configure. The caller's own JWT is still verified first — this function
// can only ever delete the account making the request, never another
// user's.
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

    // Identity check runs under the caller's own session — proves who's
    // asking before anything with elevated privilege happens.
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) return jsonResponse({ error: "Not authenticated" }, 401);

    // Only the admin client (service_role) can delete an auth user at
    // all. Scoped to exactly this one call, never exposed to the client.
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);

    if (deleteError) {
      console.error(deleteError);
      return jsonResponse({ error: deleteError.message }, 500);
    }

    return jsonResponse({ success: true });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});