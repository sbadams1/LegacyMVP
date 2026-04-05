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

  if (resp?.agent !== "avatar_v1") errs.push('agent must be "avatar_v1"');
  if (typeof resp?.reply_text !== "string" || resp.reply_text.trim().length === 0) errs.push("reply_text missing");
  if (resp?.receipts != null && !Array.isArray(resp.receipts)) errs.push("receipts must be an array if present");

  if (Array.isArray(resp?.receipts)) {
    for (const r of resp.receipts) {
      if (!r || typeof r !== "object") { errs.push("receipt must be object"); continue; }
      if (typeof r.id !== "string") errs.push("receipt.id missing");
      if (r.source !== "receipt" && r.source !== "avatar_turns") errs.push("receipt.source invalid");
      if (typeof r.quote !== "string") errs.push("receipt.quote missing");
      if (typeof r.why !== "string") errs.push("receipt.why missing");
    }
  }

  return { ok: errs.length === 0, errs };
}

/* -------------------- Gemini call -------------------- */
// (debug) moved ping response into handler

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
  const url = new URL(req.url);
  // quick health/ping for deployments
  if (url.searchParams.get("ping") === "1") {
    return new Response("AVATAR_EDGE_HIT ✅ build=v1-test", { status: 200 });
  }
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body: AvatarRequest = await req.json();

    // Be tolerant: different clients/modes may send different field names.
    const user_id = (body as any).user_id ?? (body as any).userId;
    const conversation_id = (body as any).conversation_id ?? (body as any).conversationId ?? null;
    const _rawQuestion =
      (body as any).question ??
      (body as any).message_text ??
      (body as any).message ??
      (body as any).user_message ??
      (body as any).input ??
      "";

    const question = _rawQuestion
      .toString()
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!user_id) {
      return new Response(JSON.stringify({ ok: false, error: "Missing user_id" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    if (!question) {
      return new Response(
        JSON.stringify({
          ok: true,
          answer:
            "I’m here. I didn’t catch any text to respond to—try typing a short message like ‘hello’.",
          receipts: [],
        }),
        { status: 200, headers: corsHeaders },
      );
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
      const topReceipts = top;
      const messageText = question;

      // Load recent avatar_turns for conversation continuity (most recent last)
      // IMPORTANT: fetch newest first, then reverse for prompt order.
      const priorTurnsQuery = supabase
        .from("avatar_turns")
        .select("id, created_at, role, content")
        .eq("user_id", user_id)
        .order("created_at", { ascending: false })
        .limit(24);

      const { data: priorTurns, error: priorTurnsError } = conversation_id
        ? await priorTurnsQuery.eq("conversation_id", conversation_id)
        : await priorTurnsQuery;

      const avatarTurnsBlock = (priorTurnsError || !priorTurns || priorTurns.length === 0)
        ? "(no prior turns)"
        : [...priorTurns].reverse()
            .map((t) => {
              const role = t.role === "assistant" ? "ASSISTANT" : "USER";
              const content = String(t.content ?? "").replace(/\s+/g, " ").trim();
              return `- id=${t.id} | ${role} | ${t.created_at}: ${content}`;
            })
            .join("\n");

    if (top.length < 2) {
      return new Response(
        JSON.stringify({
          ok: true,
          agent: "avatar_v1",
          reply_text:
            "I don’t have enough in the memories I have here yet to answer that confidently.",
          confidence: 0.1,
          claims: [],
          receipts: [],
          followups: ["What’s the most recent moment related to this that you want me to anchor on?"],
        }),
        { headers: corsHeaders }
      );
    }

    /* ---- Gemini prompt (strict JSON output) ---- */
    const prompt = `
You are the Avatar agent for a personal legacy app. You are NOT the Legacy summarizer.

DONOR_NAME: ${donorName}

Use ONLY:
1) The conversation turns provided in AVATAR_TURNS, and
2) The RECEIPTS list below (these are short excerpts from the user's saved memories).

Rules:
- Do not claim access to external files, databases, or tools.
- Do not invent "receipts." Only quote from RECEIPTS or AVATAR_TURNS.
- NEVER say "I don't have access to personal information" or anything like it. You DO have access to the user's saved memories via RECEIPTS and the prior AVATAR_TURNS.
  - If the answer is not present in RECEIPTS or AVATAR_TURNS, say: "I don’t have that in the memories I have here yet."
- Read-aloud test (hard rejection): if your reply would sound wrong or evasive when read aloud to the user, rewrite it to be direct, specific, and grounded in receipts.
- If asked to "show receipts", include 1–5 receipts with short quotes that support your answer.
- Avoid confirmation loops. Answer first; ask at most ONE follow-up question if truly needed.

Return STRICT JSON (no markdown, no backticks):
{
  "agent": "avatar_v1",
  "reply_text": string,
  "receipts": [
    {
      "id": string,                 // receipt.id OR avatar_turns.id
      "source": "receipt"|"avatar_turns",
      "quote": string,              // <= 200 chars
      "why": string
    }
  ],
  "confidence": number             // 0..1 optional
}

AVATAR_TURNS (most recent last):
${avatarTurnsBlock}

RECEIPTS:
${topReceipts.map((r) => `- id=${r.id} | ${r.excerpt}`).join("\n")}

USER_MESSAGE:
${messageText}
`.trim();

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
      agent: "avatar_v1",
      mode: "receipts_only",
      ...parsed,
      // receipts must be the model's citations; keep our retrieval as a separate field
      receipts: Array.isArray((parsed as any)?.receipts) ? (parsed as any).receipts : [],
      receipt_catalog: top,
      confidence: typeof (parsed as any)?.confidence === "number" ? (parsed as any).confidence : 0.6,
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


    // Persist avatar transcript turns (separate from memory_raw)
    try {
      const nowIso = new Date().toISOString();
      const rows: any[] = [];
      rows.push({
        user_id,
        conversation_id,
        role: "user",
        content: String(_rawQuestion ?? "").trim(),
        created_at: nowIso,
        metadata: { mode: "avatar", source: "avatar-edge" },
      });
      rows.push({
        user_id,
        conversation_id,
        role: "assistant",
        content: String((response as any)?.reply_text ?? "").trim(),
        created_at: new Date(Date.parse(nowIso) + 1).toISOString(),
        metadata: {
          mode: "avatar",
          source: "avatar-edge",
          receipt_ids: (top || []).map((r: any) => r.id),
          model_receipts: (response as any)?.receipts ?? [],
          receipt_catalog: (response as any)?.receipt_catalog ?? [],
          lens,
        },
      });

      // Only insert non-empty content
      const filtered = rows.filter((r) => typeof r.content === "string" && r.content.trim().length > 0);
      if (filtered.length > 0) {
        const { error } = await supabase.from("avatar_turns").insert(filtered);
        if (error) console.error("avatar_turns insert error:", error);
      }
    } catch (e) {
      console.error("avatar_turns persistence exception:", e);
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