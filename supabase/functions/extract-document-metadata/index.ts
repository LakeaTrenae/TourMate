// extract-document-metadata — Supabase Edge Function (Deno)
//
// Suggests a title, category, and artist tag for a document being
// uploaded, by reading the actual file content with Claude — same
// "AI drafts, human confirms" shape as extract-schedule, not an
// auto-commit. The client pre-fills its existing editable fields with
// whatever comes back; nothing saves until the person hits Upload.
//
// Structurally a near-clone of extract-schedule (same auth, same
// file-type branching, same secret) — see that function's header comment
// for the full reasoning on running this server-side and on the
// spreadsheet/PDF/image split. ANTHROPIC_API_KEY is the same secret
// already set for extract-schedule; nothing new to configure.
//
// Deliberately does NOT suggest `visibility`/sharing — who can see a
// document is an access-control decision, left to the human uploading
// it, not inferred from content.
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";
import * as XLSX from "npm:xlsx@0.18.5";

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

const METADATA_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "A concise, human-friendly title for this document (e.g. \"Artist X Technical Rider\", \"Venue Contract — The Fillmore\").",
    },
    category: {
      type: "string",
      enum: ["general", "contract", "rider", "hospitality", "itinerary", "other"],
      description: "Best-fit category for this document's actual content.",
    },
    artist_name: {
      type: ["string", "null"],
      description: "The specific artist/act this document is about, if the document clearly names one (e.g. a rider or contract for a specific performer). Null if the document is general/venue-level or no artist is identifiable.",
    },
  },
  required: ["title", "category", "artist_name"],
  additionalProperties: false,
} as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

    // Scoped to the caller's own session, exactly like extract-schedule —
    // every query below runs under their RLS.
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) return jsonResponse({ error: "Not authenticated" }, 401);

    const { tourId, fileName, mimeType, base64Data } = await req.json();
    if (!tourId || !fileName || !mimeType || !base64Data) {
      return jsonResponse({ error: "Missing tourId, fileName, mimeType, or base64Data" }, 400);
    }

    // Only managers can trigger an extraction — matches "documents
    // writable by managers" (0001_init.sql), the same tier that's
    // actually allowed to upload a document in the first place, and it
    // costs real API spend per call like extract-schedule does.
    const { data: role, error: roleError } = await supabase.rpc("effective_tour_role", {
      p_tour_id: tourId,
      p_user_id: user.id,
    });
    if (roleError || !["owner", "admin", "manager"].includes(role ?? "")) {
      return jsonResponse({ error: "Only tour managers can use this." }, 403);
    }

    const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });

    const isSpreadsheet =
      mimeType.includes("spreadsheet") ||
      mimeType.includes("ms-excel") ||
      mimeType === "text/csv" ||
      /\.(xlsx|xls|csv)$/i.test(fileName);

    let userContent: Array<Record<string, unknown>>;

    if (isSpreadsheet) {
      const bytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
      const workbook = XLSX.read(bytes, { type: "array" });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const csv = XLSX.utils.sheet_to_csv(firstSheet);
      userContent = [
        { type: "text", text: `Suggest a title, category, and artist tag for this document (CSV, from "${fileName}"):\n\n${csv}` },
      ];
    } else if (mimeType === "application/pdf") {
      userContent = [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
        { type: "text", text: `Suggest a title, category, and artist tag for this document ("${fileName}").` },
      ];
    } else if (mimeType.startsWith("image/")) {
      userContent = [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64Data } },
        { type: "text", text: `Suggest a title, category, and artist tag for this photo of a document ("${fileName}").` },
      ];
    } else {
      return jsonResponse({ error: `Unsupported file type: ${mimeType}` }, 400);
    }

    const response = await anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 2000,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: METADATA_SCHEMA },
      },
      system:
        "You classify documents for a touring production app — contracts, technical/hospitality riders, itineraries, and general paperwork exchanged between bands, venues, and promoters. Suggest a concise real title (not the filename), the best-fit category, and the specific artist/act the document is about if one is clearly identifiable, else null. Do not guess an artist name that isn't actually stated or clearly implied in the document.",
      messages: [{ role: "user", content: userContent as never }],
    });

    if (response.stop_reason === "refusal") {
      return jsonResponse({ error: "The document could not be processed." }, 422);
    }

    const textBlock = response.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
    if (!textBlock) return jsonResponse({ error: "No extraction result returned." }, 502);

    const parsed = JSON.parse(textBlock.text) as { title: string; category: string; artist_name: string | null };
    return jsonResponse(parsed);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
