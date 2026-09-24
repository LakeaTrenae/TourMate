// extract-guestlist — Supabase Edge Function (Deno)
//
// Extracts structured guest-list entries from an arbitrary guest list
// document (spreadsheet, PDF, or photo) using Claude — direct clone of
// extract-schedule/extract-budget's exact structure (same auth/
// authorization shape, same spreadsheet-to-CSV / native-document
// branching, same guaranteed-shape json_schema output). See
// extract-schedule's own header for the full reasoning; not repeated here.
//
// Set ANTHROPIC_API_KEY yourself:
//   npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
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

const GUESTLIST_SCHEMA = {
  type: "object",
  properties: {
    guests: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date_label: {
            type: ["string", "null"],
            description: "The show date this guest is on, ISO 8601 YYYY-MM-DD, if determinable. Null if not specified — the importer will ask which show to file it under.",
          },
          guest_name: { type: "string" },
          guest_count: { type: "number", description: "How many people under this name, including the named guest. Default to 1 if not specified." },
          notes: { type: ["string", "null"], description: "Anything else relevant (VIP, plus-one details, who requested it), or null." },
        },
        required: ["date_label", "guest_name", "guest_count", "notes"],
        additionalProperties: false,
      },
    },
  },
  required: ["guests"],
  additionalProperties: false,
} as const;

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

    const { tourId, fileName, mimeType, base64Data } = await req.json();
    if (!tourId || !fileName || !mimeType || !base64Data) {
      return jsonResponse({ error: "Missing tourId, fileName, mimeType, or base64Data" }, 400);
    }

    // Guest list submission is open to any tour member (0001_init.sql —
    // "guest_list insertable by members"), so the import is too, unlike
    // extract-schedule/extract-budget's manager-only gate.
    const { data: role, error: roleError } = await supabase.rpc("effective_tour_role", {
      p_tour_id: tourId,
      p_user_id: user.id,
    });
    if (roleError || !role) {
      return jsonResponse({ error: "You must be a member of this tour to import a guest list." }, 403);
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
      userContent = [{ type: "text", text: `Extract every guest from this guest list (CSV, from "${fileName}"):\n\n${csv}` }];
    } else if (mimeType === "application/pdf") {
      userContent = [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
        { type: "text", text: `Extract every guest from this guest list document ("${fileName}").` },
      ];
    } else if (mimeType.startsWith("image/")) {
      userContent = [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64Data } },
        { type: "text", text: `Extract every guest from this photo of a guest list ("${fileName}").` },
      ];
    } else {
      return jsonResponse({ error: `Unsupported file type: ${mimeType}` }, 400);
    }

    const response = await anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 8000,
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: GUESTLIST_SCHEMA },
      },
      system:
        "You extract structured guest-list entries from touring guest lists for a touring production app. Sources are messy real-world documents — spreadsheets, PDFs, and photos of printed lists — from promoters, artists, and crew, so formats vary widely. Extract every named guest you can find. If a field genuinely isn't present in the source, use null (or 1 for guest_count) rather than guessing.",
      messages: [{ role: "user", content: userContent as never }],
    });

    if (response.stop_reason === "refusal") {
      return jsonResponse({ error: "The document could not be processed." }, 422);
    }

    const textBlock = response.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
    if (!textBlock) return jsonResponse({ error: "No extraction result returned." }, 502);

    const parsed = JSON.parse(textBlock.text) as { guests: unknown[] };
    return jsonResponse(parsed);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
