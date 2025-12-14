// supabase/functions/backfill-missing-summaries/index.ts
//
// Purpose:
// - Backfill/repair memory_summary rows for legacy sessions (by conversation_id)
// - Ensure observations + summaries exist (when missing)
// - Ensure session_insights is populated (fills {} / NULL by deriving from full_summary)
//
// Request body (JSON):
// {
//   "user_id": "<uuid>",              // required
//   "since_days": 365,                // optional (default 365, max 3650)
//   "max_sessions": 50,               // optional (default 50, max 500)
//   "dry_run": false                  // optional (default false)
// }
//
// Notes:
// - Uses SERVICE ROLE key (SUPABASE_SERVICE_ROLE_KEY) because this is maintenance/admin.
// - Avoids raw_id anchoring problems by selecting memory_summary rows by conversation_id,
//   then updating any rows with empty insights.
// - Adds time/call caps to reduce 503 risk.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const GEMINI_API_KEY =
  Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GEMINI_API_KEY_EDGE") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "models/gemini-1.5-flash";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function safeTrim(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isEmptyJsonish(v: any): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "" || v.trim() === "{}";
  if (typeof v === "object") return Object.keys(v).length === 0;
  return true;
}

function tryExtractJsonObject(rawText: string): any | null {
  if (!rawText) return null;
  let text = String(rawText).trim();

  // Strip fenced code blocks
  if (text.startsWith("```")) {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1);
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    // Try best-effort brace extraction
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

type LegacyTurn = { role: "user" | "assistant"; text: string };

type SummarizeResult = {
  short_summary: string;
  full_summary: string;
  observations: any | null;
  session_insights: any | null;
};

type SessionInsightKind = "trait" | "theme" | "value" | "behavior";

type SessionInsightItem = {
  id: string;
  kind: SessionInsightKind;
  text: string;
  strength?: number;
};

type SessionInsightsJson = {
  session_id: string;
  conversation_id: string;
  key_sentence: string;
  items: SessionInsightItem[];
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchSessionTranscript(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  conversationId: string,
): Promise<LegacyTurn[]> {
  const { data, error } = await supabase
    .from("memory_raw")
    .select("role, content, created_at")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("fetchSessionTranscript error", error);
    return [];
  }

  const turns: LegacyTurn[] = [];
  for (const r of (data || []) as any[]) {
    const role = safeTrim(r?.role).toLowerCase();
    const content = safeTrim(r?.content);
    if (!content) continue;
    if (role === "user" || role === "assistant") {
      turns.push({ role, text: content });
    }
  }
  return turns;
}

async function summarizeWithGemini(
  transcript: LegacyTurn[],
  conversationId: string,
): Promise<SummarizeResult | null> {
  if (!transcript.length) return null;
  if (!GEMINI_API_KEY) {
    console.error("summarizeWithGemini: missing GEMINI_API_KEY");
    return null;
  }

  // Keep last ~9k chars of transcript for cost/latency
  const MAX_CHARS = 9000;
  const trimmed: LegacyTurn[] = [];
  let total = 0;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const t = transcript[i];
    const len = (t.text || "").length;
    if (total + len > MAX_CHARS && trimmed.length > 0) break;
    trimmed.push(t);
    total += len;
  }
  trimmed.reverse();

  const transcriptText = trimmed
    .map((t) => `${t.role === "user" ? "USER" : "AI"}: ${t.text}`)
    .join("\n");

  const allowedChapterKeys = [
    "early_childhood",
    "adolescence",
    "early_adulthood",
    "midlife",
    "later_life",
    "family_relationships",
    "work_career",
    "education",
    "health_wellbeing",
    "hobbies_interests",
    "beliefs_values",
    "major_events",
  ];

  const prompt = `
You are an expert autobiographical editor summarizing a legacy-preservation interview session.

Return ONLY valid JSON with EXACT keys: short_summary, full_summary, observations.
NO markdown, NO prose.

short_summary: ONE sentence in third person.
full_summary: 1–3 short paragraphs in third person, include distinctive anecdotes if present.
observations: must include chapter_keys (1–3) from ALLOWED list, and themes (array of strings).

ALLOWED chapter_keys:
${allowedChapterKeys.map((k) => `- "${k}"`).join("\n")}

JSON SHAPE:
{
  "short_summary": "...",
  "full_summary": "...",
  "observations": {
    "chapter_keys": ["family_relationships"],
    "themes": ["food", "family"],
    "insight_tags": [],
    "word_count_estimate": 0,
    "narrative_depth_score": 0.0,
    "emotional_depth_score": 0.0,
    "reflection_score": 0.0,
    "distinctiveness_score": 0.0,
    "stereotype_risk_flags": []
  }
}

Transcript:
${transcriptText}
`.trim();

  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }] };

  const url =
    `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    25_000,
  );

  if (!resp.ok) {
    console.error("Gemini summarize non-OK", resp.status, await resp.text());
    return null;
  }

  const json = await resp.json();
  const text =
    json?.candidates?.[0]?.content?.parts?.[0]?.text ??
    json?.candidates?.[0]?.content?.parts?.[0]?.rawText ??
    "";

  const parsed = tryExtractJsonObject(text);
  if (!parsed) return null;

  const short_summary = safeTrim(parsed?.short_summary);
  const full_summary = safeTrim(parsed?.full_summary);
  const observations =
    parsed?.observations && typeof parsed.observations === "object"
      ? parsed.observations
      : null;

  if (!short_summary || !full_summary) return null;

  return {
    short_summary,
    full_summary,
    observations,
    session_insights: null, // generated separately
  };
}

async function extractSessionInsightsFromSummaryText(
  fullSummary: string,
  sessionId: string,
  conversationId: string,
): Promise<SessionInsightsJson | null> {
  if (!fullSummary.trim()) return null;
  if (!GEMINI_API_KEY) {
    console.error("extractSessionInsightsFromSummaryText: missing GEMINI_API_KEY");
    return null;
  }

  const prompt = `
You are an expert biographer and personality analyst.

From the session summary below, extract personally specific insights (not generic).
Return ONLY valid JSON with this exact shape (no extra keys, no prose):

{
  "key_sentence": "One sentence that captures what mattered most in this session.",
  "items": [
    { "id": "playful_teasing", "kind": "trait", "text": "Short, specific insight.", "strength": 0.7 }
  ]
}

Rules:
- key_sentence must be specific, not a platitude.
- items: 3–8 items when possible.
- If distinctive anecdotes exist (e.g., 'murder crabs', 'suckling pig'), include them as kind="theme".
- strength: 0.55–0.95.

Session summary:
${fullSummary}
`.trim();

  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }] };

  const url =
    `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    25_000,
  );

  if (!resp.ok) {
    console.error("Gemini insights non-OK", resp.status, await resp.text());
    return null;
  }

  const json = await resp.json();
  const text =
    json?.candidates?.[0]?.content?.parts?.[0]?.text ??
    json?.candidates?.[0]?.content?.parts?.[0]?.rawText ??
    "";

  const parsed = tryExtractJsonObject(text);
  if (!parsed) return null;

  const key_sentence = safeTrim(parsed?.key_sentence);
  const itemsRaw = Array.isArray(parsed?.items) ? parsed.items : [];
  if (!key_sentence || itemsRaw.length === 0) return null;

  const items: SessionInsightItem[] = itemsRaw
    .map((it: any) => {
      const t = safeTrim(it?.text);
      if (!t) return null;
      const kindRaw = safeTrim(it?.kind);
      const kind: SessionInsightKind =
        kindRaw === "theme" || kindRaw === "value" || kindRaw === "behavior"
          ? kindRaw
          : "trait";
      const id = safeTrim(it?.id) || "i";
      const strength =
        typeof it?.strength === "number" ? it.strength : undefined;
      return { id, kind, text: t, strength };
    })
    .filter(Boolean) as SessionInsightItem[];

  if (!items.length) return null;

  return {
    session_id: sessionId,
    conversation_id: conversationId,
    key_sentence,
    items,
  };
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  let geminiCalls = 0;

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body = await req.json().catch(() => ({}));
    const userId = safeTrim((body as any)?.user_id);
    if (!userId) return jsonResponse({ error: "Missing user_id" }, 400);

    const sinceDaysRaw = Number.isFinite((body as any)?.since_days)
      ? Number((body as any).since_days)
      : 365;
    const sinceDays = Math.max(1, Math.min(3650, sinceDaysRaw));

    const maxSessionsRaw = Number.isFinite((body as any)?.max_sessions)
      ? Number((body as any).max_sessions)
      : 50;
    const maxSessions = Math.max(1, Math.min(500, maxSessionsRaw));

    const dryRun = Boolean((body as any)?.dry_run);

    const sinceIso = isoDaysAgo(sinceDays);

    // -----------------------------------------------------------------------
    // 1) Build a WORKLIST by scanning memory_summary for rows missing insights.
    //    IMPORTANT: PostgREST jsonb equality filters can be finicky; so we pull
    //    a candidate set and filter in code using isEmptyJsonish().
    // -----------------------------------------------------------------------
    const candidateLimit = Math.min(maxSessions * 50, 2500);

    const { data: candRows, error: candErr } = await supabase
      .from("memory_summary")
      .select("id, conversation_id, raw_id, created_at, short_summary, full_summary, observations, session_insights")
      .eq("user_id", userId)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(candidateLimit);

    if (candErr) {
      console.error("scan memory_summary error:", candErr);
      return jsonResponse(
        { error: "Failed to scan memory_summary", details: candErr },
        500,
      );
    }

    const needRows = (candRows || []).filter((r: any) =>
      isEmptyJsonish(r?.session_insights),
    );

    // Group rows needing insights by conversation_id
    const workByCid = new Map<string, any[]>();
    for (const r of needRows) {
      const cid = safeTrim(r?.conversation_id);
      if (!cid) continue; // can't process without conversation_id
      if (!workByCid.has(cid)) workByCid.set(cid, []);
      workByCid.get(cid)!.push(r);
    }

    const sessionIds = Array.from(workByCid.keys()).slice(0, maxSessions);

    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const failures: any[] = [];

    // -----------------------------------------------------------------------
    // 2) Process each conversation_id deterministically.
    //    - Prefer existing full_summary (fast path).
    //    - If missing, compute summary from transcript (memory_raw).
    //    - Derive session_insights from full_summary.
    //    - Update ALL rows for that conversation_id that have {} insights.
    // -----------------------------------------------------------------------
    for (const cid of sessionIds) {
      scanned++;

      // Stop early to avoid Edge timeout
      if (Date.now() - startedAt > 95_000) {
        console.log("Stopping early to avoid timeout", { scanned, updated });
        break;
      }

      // Load up to 25 summary rows for this conversation (newest first)
      const { data: rowsForCid, error: existErr } = await supabase
        .from("memory_summary")
        .select("id, raw_id, conversation_id, observations, session_insights, short_summary, full_summary, created_at")
        .eq("user_id", userId)
        .eq("conversation_id", cid)
        .order("created_at", { ascending: false })
        .limit(25);

      if (existErr) {
        failures.push({ conversation_id: cid, raw_id: null, stage: "select_summary", error: existErr });
        continue;
      }

      const summaries = (rowsForCid || []) as any[];
      const primary = summaries.length ? summaries[0] : null;

      const rowsNeedingInsights = summaries.filter((r: any) =>
        isEmptyJsonish(r?.session_insights),
      );

      if (!primary) {
        skipped++;
        continue;
      }

      let shortSummary = safeTrim(primary?.short_summary) || "Legacy session";
      let fullSummary = safeTrim(primary?.full_summary);
      let observations: any | null =
        primary?.observations && typeof primary.observations === "object"
          ? primary.observations
          : null;

      const hasFullSummary = fullSummary.length > 0;
      const obsEmpty = !primary?.observations || isEmptyJsonish(primary.observations);

      // If we can't derive insights because full_summary is missing, try to summarize from transcript.
      if (!hasFullSummary || obsEmpty) {
        const transcript = await fetchSessionTranscript(supabase, userId, cid);
        if (transcript.length === 0) {
          skipped++;
          continue;
        }

        // cap Gemini calls per run
        if (geminiCalls >= 12) {
          console.log("Stopping early (gemini call cap reached)", { scanned, updated });
          break;
        }

        const s = await summarizeWithGemini(transcript, cid);
        geminiCalls++;
        await sleep(250);

        if (!s) {
          failures.push({ conversation_id: cid, raw_id: primary?.raw_id ?? null, stage: "summarize", error: "null_summary" });
          continue;
        }

        shortSummary = s.short_summary;
        fullSummary = s.full_summary;
        observations = s.observations;

        // Write repaired summary/observations to primary row
        if (!dryRun) {
          const { error: upSumErr } = await supabase
            .from("memory_summary")
            .update({
              short_summary: shortSummary,
              full_summary: fullSummary,
              observations: observations ?? {},
              updated_at: new Date().toISOString(),
            })
            .eq("id", primary.id);

          if (upSumErr) {
            failures.push({ conversation_id: cid, raw_id: primary?.raw_id ?? null, stage: "update_primary_summary", error: upSumErr });
          } else {
            updated++;
          }
        }
      }

      if (rowsNeedingInsights.length === 0) {
        skipped++;
        continue;
      }

      // Derive insights from full_summary
      if (geminiCalls >= 12) {
        console.log("Stopping early (gemini call cap reached)", { scanned, updated });
        break;
      }

      const sessionId =
        safeTrim(primary?.raw_id) ||
        safeTrim(rowsNeedingInsights[0]?.raw_id) ||
        "session";

      const derived = await extractSessionInsightsFromSummaryText(
        fullSummary,
        sessionId,
        cid,
      );
      geminiCalls++;
      await sleep(250);

      const sessionInsightsOut = derived ?? {};

      if (dryRun) continue;

      for (const r of rowsNeedingInsights) {
        const { error: upErr } = await supabase
          .from("memory_summary")
          .update({
            session_insights: sessionInsightsOut,
            updated_at: new Date().toISOString(),
          })
          .eq("id", r.id);

        if (upErr) {
          failures.push({ conversation_id: cid, raw_id: r?.raw_id ?? null, stage: "update_insights", error: upErr });
        } else {
          updated++;
        }
      }
    }

    return jsonResponse({
      ok: true,
      since_iso: sinceIso,
      scanned_sessions: scanned,
      inserted,
      updated,
      skipped,
      dry_run: dryRun,
      gemini_calls: geminiCalls,
      failures,
    });
  } catch (err) {
    console.error("backfill-missing-summaries fatal error", err);
    return jsonResponse({ error: "Fatal error", details: String(err) }, 500);
  }
});
