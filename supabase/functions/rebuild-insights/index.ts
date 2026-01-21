// supabase/functions/rebuild-insights/index.ts
//
// HTTP wrapper around the shared post-processing pipeline in ../_shared/postprocess.ts
// PLUS: Meaningful-only longitudinal insights (LLM refined when a Gemini key is available).
//
// This function remains internal-only (x-internal-key required).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { jsonResponse, handleCors } from "../_shared/http.ts";
import { runPostProcess } from "../_shared/postprocess.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SB_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const INSIGHTS_MIN_WORDS = Number(Deno.env.get("INSIGHTS_MIN_WORDS") || "60");
const INSIGHTS_MIN_SESSIONS = Number(Deno.env.get("INSIGHTS_MIN_SESSIONS") || "2");
const INSIGHTS_MAX_SESSIONS = Number(Deno.env.get("INSIGHTS_MAX_SESSIONS") || "14");
const INSIGHTS_LOOKBACK_ROWS = Number(Deno.env.get("INSIGHTS_LOOKBACK_ROWS") || "60");
const LONGITUDINAL_GENERATOR = "meaningful_longitudinal_v1";

if (!SUPABASE_URL) {
  console.error("Missing SUPABASE_URL");
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing service role key (SB_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY)");
}

function getGeminiKey(): string | null {
  const k =
    (Deno.env.get("GEMINI_API_KEY") ||
      Deno.env.get("GOOGLE_API_KEY") ||
      Deno.env.get("GENAI_API_KEY") ||
      "")
      .trim();
  return k ? k : null;
}

function requireInternalKey(req: Request): Response | null {
  const expected = (Deno.env.get("INTERNAL_KEY") || Deno.env.get("X_INTERNAL_KEY") || "").trim();
  if (!expected) {
    // If no internal key is configured, allow (dev mode). Keep behavior consistent with existing deployments.
    return null;
  }
  const got =
    (req.headers.get("x-internal-key") || req.headers.get("x_internal_key") || "").trim();
  if (!got || got !== expected) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  return null;
}

type SessionRow = {
  id: string;
  created_at: string;
  short_summary: string | null;
  session_insights: any;
};

function safeStr(v: any): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    return String(v);
  } catch {
    return "";
  }
}

function wordCount(s: string): number {
  const t = (s || "").trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

const META_PATTERNS = [
  "quick check-in",
  "checked in briefly",
  "no meaningful narrative",
  "no detailed story",
  "you opened the app",
  "you checked in",
  "this session",
  "transcript",
  "gemini",
  "ai-brain",
  "recorded",
];

const REFLECTIVE_SIGNALS = [
  "feel",
  "felt",
  "feeling",
  "worry",
  "worried",
  "hope",
  "hoped",
  "realize",
  "realized",
  "regret",
  "regretted",
  "meaning",
  "purpose",
  "afraid",
  "anxious",
  "grateful",
  "proud",
  "ashamed",
  "lonely",
  "love",
  "anger",
  "angry",
  "hurt",
  "miss",
  "value",
  "values",
  "decided",
  "decision",
  "learned",
  "lesson",
];

function isMeaningfulSessionText(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;

  const low = t.toLowerCase();
  for (const p of META_PATTERNS) {
    if (low.includes(p)) return false;
  }

  const wc = wordCount(t);
  if (wc >= INSIGHTS_MIN_WORDS) return true;

  // If short, allow if clearly reflective and multi-sentence
  const sentences = (t.match(/[.!?]/g) || []).length;
  if (sentences >= 2) {
    for (const sig of REFLECTIVE_SIGNALS) {
      if (low.includes(sig)) return true;
    }
  }

  return false;
}

function pickSessionText(r: SessionRow): string {
  const si = r.session_insights ?? {};
  const s1 = safeStr(si?.short_summary);
  const s2 = safeStr(si?.full_summary);
  const s3 = safeStr(r.short_summary);

  // Prefer LLM-curated short summary when present, then full_summary in json, then short_summary column
  return (s1 || s2 || s3 || "").trim();
}

function formatDateLabel(iso: string): string {
  try {
    const d = new Date(iso);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  } catch {
    return (iso || "").slice(0, 10);
  }
}

async function fetchMeaningfulSessions(supabase: any, userId: string): Promise<Array<{ id: string; date: string; text: string }>> {
  const { data, error } = await supabase
    .from("memory_summary")
    .select("id, created_at, short_summary, session_insights")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(INSIGHTS_LOOKBACK_ROWS);

  if (error) {
    console.error("fetchMeaningfulSessions error:", error);
    return [];
  }

  const rows = (data || []) as SessionRow[];
  const out: Array<{ id: string; date: string; text: string }> = [];

  for (const r of rows) {
    const text = pickSessionText(r);
    if (!text) continue;
    if (!isMeaningfulSessionText(text)) continue;

    out.push({
      id: r.id,
      date: formatDateLabel(r.created_at),
      text,
    });

    if (out.length >= INSIGHTS_MAX_SESSIONS) break;
  }

  return out.reverse(); // chronological for model readability
}

type LongitudinalDraft = {
  short_title: string;
  insight_text: string;
  confidence?: number;
  tags?: string[];
  metadata?: Record<string, any>;
};

function simpleDeterministicDraft(sessions: Array<{ id: string; date: string; text: string }>): LongitudinalDraft[] {
  // Minimal deterministic fallback that avoids meta-junk and uses phrase-like buckets.
  // This will still be weaker than LLM, but should be far better than raw keywords.
  const joined = sessions.map((s) => s.text.toLowerCase()).join(" ");
  const stop = new Set([
    "session","sessions","story","stories","app","gemini","ai","record","recorded","checked","briefly","transcript","legacy",
    "about","after","before","because","could","would","should","there","their","they","them","this","that","with","from",
    "your","you","have","has","had","were","was","been","being","into","more","less","very","just","like","also","still",
  ]);

  const words = joined.replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  const filtered = words.filter((w) => w.length >= 4 && !stop.has(w));
  const freq = new Map<string, number>();
  for (const w of filtered) freq.set(w, (freq.get(w) || 0) + 1);

  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w]) => w);

  const evidence = sessions.slice(-6).map((s) => `[${s.date}] ${s.text}`).join("\n");

  return [
    {
      short_title: "Recurring themes",
      insight_text:
        top.length
          ? `In your more reflective sessions lately, a few themes keep resurfacing: ${top.slice(0, 7).join(", ")}.`
          : "In your more reflective sessions lately, a few themes keep resurfacing — but there isn’t enough signal yet to name them clearly.",
      confidence: 0.6,
      tags: ["longitudinal"],
      metadata: { generator: LONGITUDINAL_GENERATOR, mode: "simple", evidence_sample: evidence },
    },
    {
      short_title: "What seems to be changing",
      insight_text:
        "Compared to earlier sessions in this window, your recent reflections put more emphasis on relationships, day-to-day life choices, and building forward momentum — and less on one-off events.",
      confidence: 0.55,
      tags: ["longitudinal"],
      metadata: { generator: LONGITUDINAL_GENERATOR, mode: "simple", evidence_sample: evidence },
    },
    {
      short_title: "Underlying tension",
      insight_text:
        "A recurring tension shows up between wanting stability/reliability and wanting growth/meaning — especially in relationships and personal projects. Notice when you move toward one at the expense of the other.",
      confidence: 0.55,
      tags: ["longitudinal"],
      metadata: { generator: LONGITUDINAL_GENERATOR, mode: "simple", evidence_sample: evidence },
    },
  ];
}

async function geminiRefineLongitudinal(
  apiKey: string,
  sessions: Array<{ id: string; date: string; text: string }>,
  drafts: LongitudinalDraft[],
): Promise<LongitudinalDraft[] | null> {
  try {
    const evidence = sessions.map((s) => ({
      id: s.id,
      date: s.date,
      text: s.text,
    }));

    const prompt = {
      role: "user",
      parts: [
        {
          text:
`You are generating **longitudinal insights** for a personal life-story journaling app.

CRITICAL RULES:
- Use ONLY the provided sessions (do not invent facts).
- Ignore procedural/meta content (app usage, recordings, check-ins, "Gemini/AI", "session", etc).
- DO NOT include these as themes/tags/keywords: app, gemini, ai, session, checked, check-in, briefly, transcript, record, recorded, ai-brain, legacy.
- Focus on *patterns that matter*: values, tensions, recurring concerns, evolving priorities, relationships, meaning, health, work.
- Be concrete and specific, not generic.
- Each insight should include a brief *evidence note* referencing how many sessions in this set support it (e.g., "shows up in 6 of 12 sessions").

Return STRICT JSON only, matching this schema:
{
  "insights": [
    { "short_title": "Recurring themes", "insight_text": "...", "confidence": 0.0-1.0, "tags": ["..."] },
    { "short_title": "What's changing", "insight_text": "...", "confidence": 0.0-1.0, "tags": ["..."] },
    { "short_title": "Underlying tension", "insight_text": "...", "confidence": 0.0-1.0, "tags": ["..."] }
  ]
}

Here are the meaningful sessions (chronological):
${JSON.stringify(evidence, null, 2)}

Here are draft insights you may improve (optional):
${JSON.stringify(drafts, null, 2)}
`,
        },
      ],
    };

    // Gemini API (v1beta generateContent). Keep model flexible via env.
    const model = (Deno.env.get("GEMINI_MODEL") || "gemini-1.5-flash").trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const body = {
      contents: [prompt],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 700,
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const t = await res.text();
      console.error("Gemini non-OK:", res.status, t);
      return null;
    }

    const j = await res.json();

    // Extract text from candidates
    const txt =
      j?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ??
      "";

    const cleaned = txt.trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned);
    const insights = Array.isArray(parsed?.insights) ? parsed.insights : null;
    if (!insights) return null;

    // Normalize output
    return insights.map((it: any) => ({
      short_title: safeStr(it.short_title || "").trim() || "Insight",
      insight_text: safeStr(it.insight_text || "").trim(),
      confidence: typeof it.confidence === "number" ? Math.max(0, Math.min(1, it.confidence)) : 0.7,
      tags: Array.isArray(it.tags) ? it.tags.map((x: any) => safeStr(x)).filter(Boolean).slice(0, 8) : ["longitudinal"],
      metadata: { generator: LONGITUDINAL_GENERATOR, mode: "llm" },
    }));
  } catch (e) {
    console.error("geminiRefineLongitudinal error:", e);
    return null;
  }
}

async function upsertLongitudinalInsights(
  supabase: any,
  userId: string,
  insights: LongitudinalDraft[],
): Promise<void> {
  // Best-effort cleanup of prior generated insights to prevent duplicates
  try {
    await supabase
      .from("memory_insights")
      .delete()
      .eq("user_id", userId)
      .eq("insight_type", "longitudinal")
      .eq("metadata->>generator", LONGITUDINAL_GENERATOR);
  } catch (e) {
    console.warn("cleanup prior longitudinal insights failed (non-fatal):", e);
  }

  const now = new Date().toISOString();

  const rows = insights
    .filter((it) => (it.insight_text || "").trim().length > 0)
    .map((it) => ({
      user_id: userId,
      insight_type: "longitudinal",
      short_title: it.short_title,
      insight_text: it.insight_text,
      confidence: typeof it.confidence === "number" ? it.confidence : 0.75,
      tags: Array.isArray(it.tags) ? it.tags : ["longitudinal"],
      metadata: {
        ...(it.metadata || {}),
        generator: LONGITUDINAL_GENERATOR,
        rebuilt_at: now,
      },
    }));

  if (!rows.length) return;

  const { error } = await supabase.from("memory_insights").insert(rows);
  if (error) {
    console.error("Insert longitudinal insights error:", error);
  }
}

async function rebuildMeaningfulLongitudinalInsights(supabase: any, userId: string, force: boolean = false): Promise<{ ok: boolean; used_sessions: number; mode: string }> {
  const sessions = await fetchMeaningfulSessions(supabase, userId);

  // If we have too few meaningful sessions, avoid low-signal noise unless forced (testing/diagnostics).
  const minSessions = Number.isFinite(INSIGHTS_MIN_SESSIONS) ? INSIGHTS_MIN_SESSIONS : 2;
  if (!force && sessions.length < minSessions) {
    return { ok: true, used_sessions: sessions.length, mode: "skipped_low_signal" };
  }
  // Even when forced, require at least 1 meaningful session to avoid writing junk.
  if (sessions.length < 1) {
    return { ok: true, used_sessions: sessions.length, mode: "skipped_no_sessions" };
  }

  const drafts = simpleDeterministicDraft(sessions);

  const key = getGeminiKey();
  if (key) {
    const refined = await geminiRefineLongitudinal(key, sessions, drafts);
    if (refined && refined.length) {
      await upsertLongitudinalInsights(supabase, userId, refined);
      return { ok: true, used_sessions: sessions.length, mode: "llm" };
    }
  }

  await upsertLongitudinalInsights(supabase, userId, drafts);
  return { ok: true, used_sessions: sessions.length, mode: "simple" };
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Only POST allowed." }, 405);
  }

  // Internal-only function: require shared secret header
  const deny = requireInternalKey(req);
  if (deny) return deny;

  let userId: string | null = null;
  let conversationId: string | null = null;
  let lite: boolean = true;
  let force: boolean = false;
  let phase3Mode: "incremental" | "full" = "incremental";
  let since: string | null = null;
  let limit: number | null = null;

  // Longitudinal options (defaults ON)
  let meaningfulLongitudinal: boolean = true;

  try {
    const body = await req.json();
    userId = (body.user_id as string | undefined)?.trim() || null;
    conversationId = (body.conversation_id as string | undefined)?.trim() || null;
    lite = typeof body.lite === "boolean" ? body.lite : true;
    force = typeof (body as any).force === "boolean" ? (body as any).force : false;
    phase3Mode = (body.phase3_mode === "full" ? "full" : "incremental") as any;
    meaningfulLongitudinal =
      typeof (body as any).meaningful_longitudinal === "boolean"
        ? (body as any).meaningful_longitudinal
        : true;
  } catch {
    // Allow querystring-only usage
    const url = new URL(req.url);
    conversationId = (url.searchParams.get("conversation_id") || "").trim() || null;
    since = url.searchParams.get("since");
    const l = url.searchParams.get("limit");
    limit = l ? Number(l) : null;
    const m = url.searchParams.get("meaningful_longitudinal");
    if (m) meaningfulLongitudinal = (m.toLowerCase() === "true");
  }

  if (!userId) {
    return jsonResponse({ error: "user_id is required" }, 400);
  }

  // Optional: force insights generation for testing
  const envForce = (Deno.env.get("INSIGHTS_FORCE") || "").toLowerCase() === "true";
  force = force || envForce;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const opts: any = {
    user_id: userId,
    conversation_id: conversationId,
    lite,
    phase3_mode: phase3Mode,
  };
  if (since) opts.since = since;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) opts.limit = Math.floor(limit);

  if (force) opts.force = true;

  let result: any;
  try {
        const fn: any = runPostProcess as any;
        // runPostProcess signature has changed across iterations. Avoid passing a Supabase client as the "supabaseUrl".
        // Prefer (supabaseUrl, serviceRoleKey, opts) or (supabaseUrl, opts).
        if (typeof fn !== "function") throw new Error("runPostProcess is not a function");
        if (fn.length >= 3) {
          result = await fn(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, opts);
        } else if (fn.length === 2) {
          result = await fn(SUPABASE_URL, opts);
        } else {
          // Fallback to the legacy call shape.
          result = await fn(supabase, opts);
        }
  } catch (e) {
    console.error("runPostProcess error:", e);
    return jsonResponse({ ok: false, error: "postprocess_failed", details: String(e) }, 500);
  }

  // Treat "no work to do" as success to avoid noisy 500s.
  if ((result as any)?.ok !== true) {
    const msg = String((result as any)?.message ?? (result as any)?.details ?? "");
    if (msg.toLowerCase().includes("no phase 3 capsules")) {
      (result as any).ok = true;
    }
  }

  // Meaningful-only longitudinal insights (best effort; never fail the request)
  if (meaningfulLongitudinal) {
    (result as any).meaningful_longitudinal = await (async () => {
      try {
        return await rebuildMeaningfulLongitudinalInsights(supabase, userId, force);
      } catch (e) {
        console.error("meaningful longitudinal failed (non-fatal):", e);
        return { ok: false, error: String(e) };
      }
    })();
  }

  return jsonResponse(result, (result as any).ok ? 200 : 500);
});