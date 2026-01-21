// supabase/functions/avatar/index.ts
// Receipts-only Avatar with Gemini synthesis, validation, and reuse penalties

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type AllowedSource = "memory_summary" | "memory_insights" | "story_seeds";

type AvatarRequest = {
  user_id: string;
  question: string;
  persona?: string;
  max_receipts?: number;
};

type Receipt = {
  id: string;
  source: AllowedSource;
  row_id: string;
  created_at: string;
  conversation_id?: string | null;
  title?: string | null;
  excerpt: string;
  relevance: number;
  reuse_penalty: number;
};

/* -------------------- helpers -------------------- */

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function baseScore(text: string, tokens: string[]): number {
  let s = 0;
  const l = text.toLowerCase();
  for (const t of tokens) if (l.includes(t)) s++;
  return s + Math.min(text.length / 800, 0.25);
}

function excerpt(text: string, max = 220) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

function lensFromQuestion(q: string): string {
  const l = q.toLowerCase();
  if (l.includes("why") || l.includes("meaning")) return "meaning";
  if (l.includes("learn") || l.includes("lesson")) return "lesson";
  if (l.includes("feel") || l.includes("emotion")) return "emotional";
  if (l.includes("decide") || l.includes("choice")) return "decision";
  if (l.includes("advice")) return "advice";
  return "reflective";
}

/* -------------------- validation -------------------- */

function validateAvatarResponse(resp: any) {
  const errs: string[] = [];
  if (resp?.mode !== "receipts_only") errs.push("mode must be receipts_only");
  if (!Array.isArray(resp?.claims)) errs.push("claims missing");
  if (!Array.isArray(resp?.receipts)) errs.push("receipts missing");

  const receiptIds = new Set(resp.receipts.map((r: any) => r.id));
  for (const c of resp.claims ?? []) {
    const personal = ["personal_fact", "personal_reflection", "interpretation", "advice"];
    if (personal.includes(c.type)) {
      if (!Array.isArray(c.receipt_ids) || c.receipt_ids.length === 0) {
        errs.push(`claim ${c.id} missing receipts`);
      }
    }
    if (c.type === "interpretation" && c.receipt_ids.length < 2) {
      errs.push(`interpretation ${c.id} requires >=2 receipts`);
    }
    for (const rid of c.receipt_ids ?? []) {
      if (!receiptIds.has(rid)) errs.push(`missing receipt ${rid}`);
    }
  }
  return { ok: errs.length === 0, errs };
}

/* -------------------- Gemini call -------------------- */

async function callGemini(prompt: string): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=" +
      apiKey,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
    }
  );

  if (!res.ok) {
    throw new Error("Gemini call failed");
  }

  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

function safeJsonParse(raw: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    let s = raw.trim();
    // Strip common Gemini markdown fences
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const value = JSON.parse(s);
    if (value === null || typeof value !== 'object') {
      return { ok: false, error: 'Parsed JSON is not an object' };
    }
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}


/* -------------------- main -------------------- */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body: AvatarRequest = await req.json();
    const { user_id, question } = body;

    if (!user_id || !question) {
      return new Response(JSON.stringify({ ok: false, error: "Missing input" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    /* ---- donor display name (profile) ---- */
    let donorName = "the donor";
    try {
      const { data: profile } = await supabase
        .from("profile")
        .select("preferred_name, display_name")
        .eq("user_id", user_id)
        .maybeSingle();

      const preferred = (profile as any)?.preferred_name?.toString().trim();
      const display = (profile as any)?.display_name?.toString().trim();
      donorName = preferred || display || donorName;
    } catch (_) {
      // fail-quietly; keep fallback
    }


    const tokens = tokenize(question);
    const lens = lensFromQuestion(question);
    const maxReceipts = body.max_receipts ?? 8;

    /* ---- receipt reuse memory (last 20 answers) ---- */
    const { data: recentUses } = await supabase
      .from("avatar_receipt_usage")
      .select("receipt_id")
      .eq("user_id", user_id)
      .order("used_at", { ascending: false })
      .limit(20);

    /* ---- receipt reuse memory (global) ---- */
    const { data: globalUses } = await supabase
      .from("avatar_receipt_usage")
      .select("receipt_id")
      .eq("user_id", user_id)
      .limit(5000);

    const globalCounts = new Map<string, number>();
    for (const r of globalUses ?? []) {
      globalCounts.set(r.receipt_id, (globalCounts.get(r.receipt_id) ?? 0) + 1);
    }


    const reuseCounts = new Map<string, number>();
    for (const r of recentUses ?? []) {
      reuseCounts.set(r.receipt_id, (reuseCounts.get(r.receipt_id) ?? 0) + 1);
    }

    const receipts: Receipt[] = [];

    /* ---- memory_summary ---- */
    const { data: summaries } = await supabase
      .from("memory_summary")
      .select("id, created_at, conversation_id, short_summary, full_summary")
      .eq("user_id", user_id)
      .limit(300);

    for (const r of summaries ?? []) {
      const text = r.full_summary || r.short_summary || "";
      const base = baseScore(text, tokens);
      if (base <= 0) continue;
      const id = `ms_${r.id}`;
      const localCount = reuseCounts.get(id) ?? 0;
      const globalCount = globalCounts.get(id) ?? 0;
      const entropy = 1 / (1 + Math.log(1 + globalCount) + localCount);
      const penalty = localCount * 0.4;
      receipts.push({
        id,
        source: "memory_summary",
        row_id: r.id,
        created_at: r.created_at,
        conversation_id: r.conversation_id,
        excerpt: excerpt(text),
        relevance: (base - penalty) * entropy,
        reuse_penalty: penalty,
      });
    }

    /* ---- story_seeds ---- */
    const { data: seeds } = await supabase
      .from("story_seeds")
      .select("id, created_at, conversation_id, title, seed_text")
      .eq("user_id", user_id)
      .limit(200);

    for (const s of seeds ?? []) {
      const text = `${s.title ?? ""} ${s.seed_text ?? ""}`;
      const base = baseScore(text, tokens) + 0.15;
      if (base <= 0) continue;
      const id = `ss_${s.id}`;
      const localCount = reuseCounts.get(id) ?? 0;
      const globalCount = globalCounts.get(id) ?? 0;
      const entropy = 1 / (1 + Math.log(1 + globalCount) + localCount);
      const penalty = localCount * 0.4;
      receipts.push({
        id,
        source: "story_seeds",
        row_id: s.id,
        created_at: s.created_at,
        conversation_id: s.conversation_id,
        title: s.title,
        excerpt: excerpt(s.seed_text || s.title || ""),
        relevance: (base - penalty) * entropy,
        reuse_penalty: penalty,
      });
    }

    receipts.sort((a, b) => b.relevance - a.relevance);
    const top = receipts.slice(0, maxReceipts);

    if (top.length < 2) {
      return new Response(
        JSON.stringify({
          ok: true,
          mode: "receipts_only",
          answer_markdown:
            "I don’t yet have enough recorded material to answer that at the depth it deserves.",
          confidence: 0.1,
          claims: [],
          receipts: [],
          followups: ["Can you narrow this to a person, place, or decision?"],
        }),
        { headers: corsHeaders }
      );
    }

    /* ---- Gemini prompt (strict JSON output) ---- */
    const prompt = `
You are the Avatar of ${donorName}.
Mode: receipts_only.
Lens: ${lens}

Use ONLY the receipts provided.
Do NOT invent facts.
Produce valid JSON with fields:
{
  answer_markdown,
  claims: [{id, text, type, receipt_ids}]
}

Interpretations require >=2 receipts.
End each paragraph with claim IDs.

Receipts:
${top.map((r) => `- ${r.id}: ${r.excerpt}`).join("\n")}
`;

    const raw = await callGemini(prompt);
    const parsedRes = safeJsonParse(raw);
    if (!parsedRes.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: "Gemini returned invalid JSON" }),
        { status: 502, headers: corsHeaders }
      );
    }

    const parsed = parsedRes.value;

    const response = {
      ok: true,
      mode: "receipts_only",
      ...parsed,
      receipts: top,
      confidence: 0.6,
    };

    const validation = validateAvatarResponse(response);
    if (!validation.ok) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Avatar validation failed",
          details: validation.errs,
        }),
        { status: 500, headers: corsHeaders }
      );
    }

    /* ---- record receipt usage ---- */
    for (const r of top) {
      await supabase.from("avatar_receipt_usage").insert({
        user_id,
        receipt_id: r.id,
        used_at: new Date().toISOString(),
      });
    }

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("avatar error:", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});