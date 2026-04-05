/// <reference types="https://deno.land/x/deno@v1.43.6/mod.d.ts" />

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type Json = Record<string, unknown>;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function safeString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

// ---- Cursor helpers (opaque string) ----
type Cursor = { created_at: string; id: string };
function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify(c));
}
function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const obj = JSON.parse(atob(raw));
    if (typeof obj?.created_at === "string" && typeof obj?.id === "string") return obj;
  } catch (_) {}
  return null;
}

// ---- Transcript & eligibility ----
const WAKE_PHRASE_RE = /\b(hey\s+gemini|play\s+gemini|are\s+you\s+there|can\s+you\s+hear\s+me|test|start\s+recording)\b/i;

function countWords(s: string): number {
  const words = s
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.length;
}

function looksLikeWakeOrProcedural(userText: string): boolean {
  const t = userText.trim().toLowerCase();
  if (!t) return true;
  if (WAKE_PHRASE_RE.test(t)) return true;
  // very short / greeting-like
  if (t.length < 30) return true;
  // lots of "hey"/"hello" plus question mark
  if ((t.includes("hey") || t.includes("hello")) && t.includes("?") && t.length < 80) return true;
  return false;
}

function looksLikeTranscriptSummary(s: string): boolean {
  const t = s.trim();
  if (!t) return true;

  // wake phrase summaries
  if (WAKE_PHRASE_RE.test(t)) return true;

  // role-ish patterns
  if (/(legacy_user|legacy_ai|assistant|user)\s*[:\-]/i.test(t)) return true;

  // very short "summary"
  if (t.length < 40) return true;

  // many line breaks or timestamp-ish
  const lines = t.split("\n").filter(Boolean);
  if (lines.length >= 5) return true;

  // too many quotes / turn-like
  if ((t.match(/["']/g) ?? []).length > 10) return true;

  return false;
}

// ---- Existing summary classification (for safe rebuild) ----
const GARBAGE_SUMMARY_RE = /^(you checked in briefly|hey,\s*gemini|play\s+gemini|are\s+you\s+there)/i;

function isGarbageSummary(existing: string): boolean {
  const t = existing.trim();
  if (!t) return true;
  if (GARBAGE_SUMMARY_RE.test(t)) return true;
  if (WAKE_PHRASE_RE.test(t)) return true;
  if (/(legacy_user|legacy_ai|assistant|user)\s*[:\-]/i.test(t)) return true;
  if (t.length < 40) return true;
  return false;
}


// ---- Gemini ----
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "models/gemini-2.0-flash-exp";

async function callGemini(prompt: string): Promise<string> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 1200,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Gemini non-OK: ${res.status} ${txt}`);
  }

  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const text = parts
      .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
      .join("\n")
      .trim();
    return text;
  }

  return "";
}

function stripCodeFences(s: string): string {
  let t = s.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  return t;
}

function tryParseJson(raw: string): Json | null {
  const t = stripCodeFences(raw);
  // try direct
  try {
    const obj = JSON.parse(t);
    if (obj && typeof obj === "object") return obj as Json;
  } catch (_) {}

  // try extracting first {...}
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(t.slice(start, end + 1));
      if (obj && typeof obj === "object") return obj as Json;
    } catch (_) {}
  }
  return null;
}

function sanitizeReflections(items: unknown): string[] {
  const arr = Array.isArray(items) ? items : [];
  const out: string[] = [];
  for (const it of arr) {
    if (typeof it !== "string") continue;
    const s = it.trim();
    if (!s) continue;
    // no therapy homework / no questions
    if (s.includes("?")) continue;
    if (/consider\s+reflecting|perhaps\s+you\s+could|you\s+could\s+reflect/i.test(s)) continue;
    out.push(s);
    if (out.length >= 4) break;
  }
  return out;
}

function buildPrompt(transcript: string): string {
  return [
    "You are LegacyMVP's session summarizer.",
    "Return ONLY valid JSON, no markdown, no commentary.",
    "",
    "STYLE RULES:",
    "- short_summary: 1-3 sentences, concrete, non-therapeutic, no questions.",
    "- full_summary: 1-3 short paragraphs, factual narrative; no counseling tone.",
    "- reflections: 0-4 bullets max; MUST be descriptive 'takeaways' (no questions, no advice, no homework).",
    "- longitudinal_insight: null unless there is a clear, repeated multi-session pattern (be conservative).",
    "- Never output transcript lines or role-prefixed lines.",
    "",
    "JSON SCHEMA:",
    "{",
    '  "short_summary": string,',
    '  "full_summary": string,',
    '  "reflections": string[],',
    '  "longitudinal_insight": string | null',
    "}",
    "",
    "TRANSCRIPT (chronological):",
    transcript,
  ].join("\n");
}

serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return jsonResponse({ error: "POST only" }, 405);
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("SUPABASE_PROJECT_URL") ?? "";
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return jsonResponse({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const body = await req.json().catch(() => ({}));
    const batchSize = clamp(Number(body?.batch_size ?? 20), 1, 50);
    const dryRun = Boolean(body?.dry_run ?? false);
const onlyGarbage = body?.only_garbage === undefined ? true : Boolean(body?.only_garbage);
const force = Boolean(body?.force ?? false);


    const scopeUserId = safeString(body?.scope?.user_id);
    const createdAfter = safeString(body?.scope?.created_after);
    const createdBefore = safeString(body?.scope?.created_before);
const scopeRawIds = Array.isArray(body?.scope?.raw_ids)
  ? (body.scope.raw_ids as unknown[]).filter((v) => typeof v === "string" && (v as string).length >= 16).slice(0, 2000) as string[]
  : [];


    const cursor = decodeCursor(body?.cursor);

    // Base query
    let q = supabase
      .from("memory_summary")
      .select("id,user_id,raw_id,conversation_id,created_at,short_summary,full_summary,session_insights")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(batchSize);

    if (scopeUserId) q = q.eq("user_id", scopeUserId);
    if (createdAfter) q = q.gte("created_at", createdAfter);
    if (createdBefore) q = q.lte("created_at", createdBefore);
    if (scopeRawIds.length) q = q.in("raw_id", scopeRawIds);

    // Cursor pagination (created_at, id)
    if (cursor) {
      // (created_at, id) > cursor
      q = q.or(`created_at.gt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.gt.${cursor.id})`);
    }

    const { data: rows, error } = await q;
    if (error) return jsonResponse({ error: error.message }, 500);

    const processed = rows?.length ?? 0;
    if (!rows || rows.length === 0) {
      return jsonResponse({
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        done: true,
        cursor_next: null,
      });
    }

    let updated = 0;
    let skipped = 0;
    let errors = 0;
    const samples: any[] = [];

    for (const row of rows) {
      const id = row.id as string;
      const userId = row.user_id as string;
      const rawId = row.raw_id as string;
      // ---- Safe targeting gates ----
      const si = (row.session_insights ?? {}) as any;
      const version = typeof si?.version === "string" ? si.version : "";

      const existingShort = safeString((row as any).short_summary);
      const existingIsGarbage = isGarbageSummary(existingShort);

      // If onlyGarbage mode, never touch good rows
      if (onlyGarbage && !existingIsGarbage) {
        skipped++;
        continue;
      }

      // Version gate: allow reprocessing when force=true (needed to repair earlier rebuild-v2 garbage)
      if (version === "rebuild-v2" && !force) {
        skipped++;
        continue;
      }

      // Load memory_raw anchor to get conversation_id
      // Prefer the summary row's conversation_id (it is often more reliable for older data),
      // otherwise fall back to the raw anchor's conversation_id.
      let convId = safeString((row as any).conversation_id);
      if (!convId) {
        const { data: rawAnchor, error: rawErr } = await supabase
          .from("memory_raw")
          .select("conversation_id,created_at")
          .eq("id", rawId)
          .maybeSingle();

        if (rawErr) {
          console.warn("raw anchor lookup failed", { id, rawId, rawErr: rawErr.message });
        }
        convId = safeString(rawAnchor?.conversation_id);
      }

      if (!convId) {
        // Can't rebuild without a conversation_id -> quarantine by stamping version so future runs skip.
        const nowIso = new Date().toISOString();
        const existingShort = safeString((row as any).short_summary) || "You checked in briefly, but you did not record a detailed story in this session.";
        const existingFull = safeString((row as any).full_summary) || null;

        const nextSI: any = typeof si === "object" && si ? { ...si } : {};
        nextSI.version = "rebuild-v2";
        nextSI.rebuilt_at = nowIso;
        nextSI.rebuild_status = "unrebuildable_missing_conversation_id";
        nextSI.short_summary = existingShort;
        nextSI.full_summary = existingFull;

        const reframed: any = (typeof nextSI.reframed === "object" && nextSI.reframed) ? { ...nextSI.reframed } : {};
        reframed.short_summary = existingShort;
        reframed.full_summary = existingFull;
        reframed.reflections = [];
        reframed.longitudinal_insight = null;
        nextSI.reframed = reframed;

        if (!dryRun) {
          const { error: uErr } = await supabase
            .from("memory_summary")
            .update({
              short_summary: existingShort,
              full_summary: existingFull,
              session_insights: nextSI,
              updated_at: nowIso,
            })
            .eq("id", id);
          if (uErr) {
            errors++;
            samples.push({ id, status: "error", reason: "failed quarantine update", detail: uErr.message });
            continue;
          }
        }

        skipped++;
        samples.push({ id, status: "skipped", reason: "missing conversation_id (quarantined)" });
        continue;
      }

      // Fetch transcript for that conversation
      const { data: turns, error: tErr } = await supabase
        .from("memory_raw")
        .select("role,source,content,created_at")
        .eq("user_id", userId)
        .eq("conversation_id", convId)
        .order("created_at", { ascending: true })
        .limit(400);

      if (tErr || !turns || turns.length === 0) {
        // Older rows can have mismatched conversation_id/transcript linkage.
        // Quarantine so future runs skip, while preserving existing summaries.
        const nowIso = new Date().toISOString();
        const existingShort = safeString((row as any).short_summary) || "You checked in briefly, but you did not record a detailed story in this session.";
        const existingFull = safeString((row as any).full_summary) || null;

        const nextSI: any = typeof si === "object" && si ? { ...si } : {};
        nextSI.version = "rebuild-v2";
        nextSI.rebuilt_at = nowIso;
        nextSI.rebuild_status = "unrebuildable_no_transcript_turns";
        nextSI.short_summary = existingShort;
        nextSI.full_summary = existingFull;

        const reframed: any = (typeof nextSI.reframed === "object" && nextSI.reframed) ? { ...nextSI.reframed } : {};
        reframed.short_summary = existingShort;
        reframed.full_summary = existingFull;
        reframed.reflections = [];
        reframed.longitudinal_insight = null;
        nextSI.reframed = reframed;

        if (!dryRun) {
          const { error: uErr } = await supabase
            .from("memory_summary")
            .update({
              short_summary: existingShort,
              full_summary: existingFull,
              session_insights: nextSI,
              updated_at: nowIso,
            })
            .eq("id", id);
          if (uErr) {
            errors++;
            samples.push({ id, status: "error", reason: "failed quarantine update", detail: uErr.message });
            continue;
          }
        }

        skipped++;
        samples.push({ id, status: "skipped", reason: "no transcript turns (quarantined)" });
        continue;
      }

      // Build transcript text and eligibility
      let userTextAll = "";
      const transcriptLines: string[] = [];
      for (const t of turns) {
        const role = safeString(t.role || t.source || "");
        const content = safeString(t.content);
        if (!content) continue;
        transcriptLines.push(`${role}: ${content}`);
        if ((t.role === "user" || t.source === "legacy_user") && content) {
          userTextAll += content + "\n";
        }
      }

const userWords = countWords(userTextAll);
const isWake = looksLikeWakeOrProcedural(userTextAll);

// IMPORTANT: eligibility gates are for *insights*, not for basic summaries.
// Only treat as "no story" when it's clearly a wake/procedural ping AND extremely short.
const isVeryShort = userWords < 80;
const isNoStory = (isWake && isVeryShort) || userWords < 20;

      let newShort = "";
      let newFull: string | null = null;
      let reflections: string[] = [];
      let longitudinal: string | null = null;

      // Treat as "no story" ONLY when it's clearly a wake/procedural ping AND extremely short.
      const userWords = countWords(userTextAll);
      const isWake = looksLikeWakeOrProcedural(userTextAll);
      const isVeryShort = userWords < 80;
      const isNoStory = (isWake && isVeryShort) || userWords < 20;

      if (isNoStory) {
        newShort = "You checked in briefly, but you did not record a detailed story in this session.";
        newFull = null;
        reflections = [];
        longitudinal = null;
      } else {
      const prompt = buildPrompt(transcriptLines.join("\n"));
      try {
        const raw = await callGemini(prompt);
        const obj = tryParseJson(raw) ?? {};
        newShort = safeString(obj["short_summary"]).trim();
        const full = safeString(obj["full_summary"]).trim();
        newFull = full ? full : null;
        reflections = sanitizeReflections(obj["reflections"]);
        longitudinal =
          typeof obj["longitudinal_insight"] === "string"
            ? (obj["longitudinal_insight"] as string).trim() || null
            : null;
      } catch (_e) {
        newShort = "You recorded a session, but we couldn't generate a summary reliably.";
        newFull = null;
        reflections = [];
        longitudinal = null;
      }
    }

      if (looksLikeTranscriptSummary(newShort)) {
        // enforce safe fallback
        newShort = "You recorded a session, but it did not contain enough clear story content to summarize well.";
      }
// If the model (or heuristics) still produced the generic placeholder while the session had substance,
// do NOT overwrite; fall back to a conservative non-placeholder summary.
if (!isNoStory && /^You checked in briefly,/i.test(newShort.trim())) {
  const firstUser = (turns.find((t: any) =>
    (t.role === "user" || t.source === "legacy_user") && safeString(t.content).trim().length > 0
  )?.content ?? "").toString();
  const cleaned = safeString(firstUser).replace(/\s+/g, " ").trim();
  newShort = cleaned
    ? `Brief session captured: ${cleaned.slice(0, 160)}${cleaned.length > 160 ? "…" : ""}`
    : "Brief session captured.";
}


// Final safety: never overwrite with garbage output in onlyGarbage mode.
if (onlyGarbage && isGarbageSummary(newShort)) {
  skipped++;
  samples.push({ id, status: "skipped", reason: "generated_summary_classified_garbage" });
  continue;
}

      // session_insights payload
      const nowIso = new Date().toISOString();
      const nextSI: any = typeof si === "object" && si ? { ...si } : {};
      nextSI.version = "rebuild-v2";
      nextSI.rebuilt_at = nowIso;

      // Canonical fields (source of truth)
      nextSI.short_summary = newShort;
      nextSI.full_summary = newFull;

      // Reframed section for UI compatibility (if you use it)
      const reframed: any = (typeof nextSI.reframed === "object" && nextSI.reframed) ? { ...nextSI.reframed } : {};
      reframed.short_summary = newShort;
      reframed.full_summary = newFull;
      reframed.reflections = reflections;
      reframed.longitudinal_insight = longitudinal;
      nextSI.reframed = reframed;

      // Mirror to top-level columns (Option A)
      const updatePayload: any = {
        short_summary: newShort,
        full_summary: newFull,
        session_insights: nextSI,
        updated_at: nowIso,
      };

      if (!dryRun) {
        const { error: uErr } = await supabase
          .from("memory_summary")
          .update(updatePayload)
          .eq("id", id);

        if (uErr) {
          errors++;
          samples.push({ id, status: "error", reason: uErr.message });
          continue;
        }
      }

      updated++;
      if (samples.length < 10) {
        samples.push({
          id,
          status: dryRun ? "would_update" : "updated",
          user_words: userWords,
          short_summary: newShort,
          full_summary_len: newFull ? newFull.length : 0,
          reflections_count: reflections.length,
        });
      }
    }

    const last = rows[rows.length - 1];
    const cursorNext = encodeCursor({ created_at: last.created_at as string, id: last.id as string });

    return jsonResponse({
      processed,
      updated,
      skipped,
      errors,
      done: processed < batchSize,
      cursor_next: cursorNext,
      samples,
      dry_run: dryRun,
      batch_size: batchSize,
    });
  } catch (e) {
    return jsonResponse({ error: String(e?.message ?? e) }, 500);
  }
});
