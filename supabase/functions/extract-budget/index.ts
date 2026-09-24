// extract-budget — Supabase Edge Function (Deno)
//
// Extracts structured budget line items from an arbitrary production
// budget document (spreadsheet, PDF, or photo of a printed budget) using
// Claude — direct clone of extract-schedule's exact structure (same
// auth/authorization shape, same spreadsheet-to-CSV / native-document
// branching, same guaranteed-shape json_schema output). See that
// function's own header for the full reasoning; not repeated here.
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

const BUDGET_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", description: "Budget category/line-item name, e.g. 'Travel', 'Guarantee', 'Backline Rental'." },
          description: { type: ["string", "null"], description: "Any extra detail beyond the category, or null." },
          amount: { type: "number", description: "Always positive — entry_type carries the sign." },
          entry_type: { type: "string", enum: ["income", "expense"], description: "Guarantees/merch/sponsorship = income; everything paid out = expense." },
          date_label: {
            type: ["string", "null"],
            description: "A specific show date this line item is tied to, ISO 8601 YYYY-MM-DD, if the source clearly associates it with one date rather than the whole tour. Null if it's tour-wide or not determinable.",
          },
          notes: { type: ["string", "null"], description: "Anything else relevant not captured above, or null." },
        },
        required: ["category", "description", "amount", "entry_type", "date_label", "notes"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
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

    const { data: role, error: roleError } = await supabase.rpc("effective_tour_role", {
      p_tour_id: tourId,
      p_user_id: user.id,
    });
    if (roleError || !["owner", "admin", "manager"].includes(role ?? "")) {
      return jsonResponse({ error: "Only tour managers can import a budget." }, 403);
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
        { type: "text", text: `Extract every budget line item from this production budget (CSV, from "${fileName}"):\n\n${csv}` },
      ];
    } else if (mimeType === "application/pdf") {
      userContent = [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } },
        { type: "text", text: `Extract every budget line item from this production budget document ("${fileName}").` },
      ];
    } else if (mimeType.startsWith("image/")) {
      userContent = [
        { type: "image", source: { type: "base64", media_type: mimeType, data: base64Data } },
        { type: "text", text: `Extract every budget line item from this photo of a production budget ("${fileName}").` },
      ];
    } else {
      return jsonResponse({ error: `Unsupported file type: ${mimeType}` }, 400);
    }

    const response = await anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 8000,
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: BUDGET_SCHEMA },
      },
      system:
        "You extract structured budget line items from touring production budgets for a touring production app. Sources are messy real-world documents — spreadsheets, PDFs, and photos of printed budgets — so formats vary widely (some group by category, some by show date, some are a flat list). Extract every line item you can find, classifying each as income (guarantees, merch, sponsorship) or expense (everything paid out). If a field genuinely isn't present in the source, use null rather than guessing.",
      messages: [{ role: "user", content: userContent as never }],
    });

    if (response.stop_reason === "refusal") {
      return jsonResponse({ error: "The document could not be processed." }, 422);
    }

    const textBlock = response.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
    if (!textBlock) return jsonResponse({ error: "No extraction result returned." }, 502);

    const parsed = JSON.parse(textBlock.text) as { items: unknown[] };
    return jsonResponse(parsed);
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
