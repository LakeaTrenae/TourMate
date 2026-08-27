// extract-schedule — Supabase Edge Function (Deno)
//
// Extracts structured show-date data from an arbitrary tour routing sheet
// (PDF, photo, or spreadsheet) using Claude. This runs server-side, not in
// the mobile app, for the same reason the Supabase `service_role` key never
// ships client-side: ANTHROPIC_API_KEY is a real secret, and a mobile app
// binary can be decompiled. Set it with:
//   npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// (run that yourself — never paste an API key into chat with an assistant,
// same reasoning as every other secret in this project).
//
// Two extraction paths:
//   - PDF / photo -> sent to Claude natively as a document/image content
//     block. Claude reads it directly (layout, handwriting, scan quality
//     and all) — this is exactly the kind of messy real-world document
//     understanding vision models are good at.
//   - Spreadsheet (.xlsx/.xls/.csv) -> parsed server-side into CSV text
//     first. Claude has no native way to "see" a spreadsheet file; parsing
//     it directly is both more reliable and far cheaper than pretending
//     it's an image.
//
// Every request is authorized against the same effective_tour_role RPC the
// app itself uses — only tour managers can trigger an extraction (this
// costs real API spend per call).
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

// Structured-outputs schema — guarantees Claude's response is exactly this
// shape, no parsing-a-hopeful-JSON-string-and-praying required. Every field
// beyond `date` is nullable: real routing sheets frequently omit soundcheck
// or load-in times, and we'd rather get a null than a hallucinated guess.
const SCHEDULE_SCHEMA = {
  type: "object",
  properties: {
    shows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description:
              "Show date, ISO 8601 YYYY-MM-DD. Infer the year from context (tour dates, document date, adjacent shows) if not explicit for this row.",
          },
          venue_name: { type: ["string", "null"], description: "Venue name, or null if not present in the source." },
          city: { type: ["string", "null"], description: "City and state/country, or null." },
          load_in: { type: ["string", "null"], description: "Load-in time, 24-hour HH:MM, or null." },
          soundcheck: { type: ["string", "null"], description: "Soundcheck time, 24-hour HH:MM, or null." },
          doors: { type: ["string", "null"], description: "Doors time, 24-hour HH:MM, or null." },
          set_time: { type: ["string", "null"], description: "Set/performance time, 24-hour HH:MM, or null." },
          notes: {
            type: ["string", "null"],
            description: "Anything else relevant (promoter, confirmation #, capacity) not captured above, or null.",
          },
        },
        required: ["date", "venue_name", "city", "load_in", "soundcheck", "doors", "set_time", "notes"],
        additionalProperties: false,
      },
    },
  },
  required: ["shows"],
  additionalProperties: false,
} as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

    // Scoped to the caller's own session (their JWT, not service_role) — every
    // query below runs under their RLS, exactly like the mobile app itself.
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

    // Authorization: only managers can trigger an extraction — it costs
    // real API spend per call. Same RPC the app itself uses to decide what
    // to show; this is the actual enforcement, not just a hidden button.
    const { data: role, error: roleError } = await supabase.rpc("effective_tour_role", {
      p_tour_id: tourId,
      p_user_id: user.id,
    });
    if (roleError || !["owner", "admin", "manager"].includes(role ?? "")) {
      return jsonResponse({ error: "Only tour managers can import a schedule." }, 403);
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
        { type: "text", text: `Extract every show date from this tour routing sheet (CSV, from "${fileName}"):\n\n${csv}` },
      ];
    } else if (mimeType === "application/pdf") {
      userContent = [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
        { type: "text", text: `Extract every show date from this tour routing sheet ("${fileName}").` },
      ];
    } else if (mimeType.startsWith("image/")) {
      userContent = [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64Data } },
        { type: "text", text: `Extract every show date from this photo of a tour routing sheet ("${fileName}").` },
      ];
    } else {
      return jsonResponse({ error: `Unsupported file type: ${mimeType}` }, 400);
    }

    const response = await anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 8000,
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: SCHEDULE_SCHEMA },
      },
      system:
        "You extract structured show-date data from tour routing sheets, schedules, and itineraries for a touring production app. Sources are messy real-world documents — spreadsheets, PDFs, and photos of printed sheets — from booking agents and promoters, so formats vary widely. Extract every show date you can find. If a field genuinely isn't present in the source, use null rather than guessing.",
      messages: [{ role: "user", content: userContent as never }],
    });

    if (response.stop_reason === "refusal") {
      return jsonResponse({ error: "The document could not be processed." }, 422);
    }

    const textBlock = response.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
    if (!textBlock) return jsonResponse({ error: "No extraction result returned." }, 502);

    const parsed = JSON.parse(textBlock.text) as { shows: unknown[] };
    return jsonResponse(parsed);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});