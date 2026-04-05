/// <reference types="https://deno.land/x/deno@v1.43.6/mod.d.ts" />

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type Json = Record<string, unknown>;

async function invokeEdgeFunction(
  supabaseUrl: string,
  serviceKey: string,
  slug: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; text: string }> {
  const base = supabaseUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/functions/v1/${slug}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, text };
}

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


// ---- Fact key hygiene (block meta + canonicalize common prefixes) ----
const BLOCKED_FACT_PREFIXES = new Set<string>([
  "app",
  "application",
  "device",
  "devices",
  "product",
  "products",
  "project",
  "projects",
  "files",
  "onboarding",
  "testing",
  "task",
  "previous_task",
  "request",
  "response",
  "interaction",
  "service",
  "language",
  "language_learning",
  "translation",
  "datetime",
  "date",
  "time",
  "timezone",
  "locale",
  "temperature",
  "weather",
  // legacy cleanup stragglers / inconsistent namespaces
  "current_city",
  "current_country",
  "current_location",
  "exercise_routine",
]);

const CANONICAL_FACT_PREFIX: Record<string, string> = {
  relationships: "relationship",
  financial: "finance",
  fitness: "exercise",
  emotion: "emotions",
  belief: "beliefs",
};

function normalizeFactKey(rawKey: string): string | null {
  const k = rawKey.trim();
  if (!k) return null;
  const dot = k.indexOf(".");
  const prefix = (dot === -1 ? k : k.slice(0, dot)).toLowerCase();
  if (BLOCKED_FACT_PREFIXES.has(prefix)) return null;

  const canonical = CANONICAL_FACT_PREFIX[prefix];
  if (!canonical) return k;
  return dot === -1 ? canonical : canonical + k.slice(dot);
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
const GARBAGE_SUMMARY_RE = /^(you checked in briefly|you opened the app|you checked in briefly this session|hey,\s*gemini|play\s+gemini|are\s+you\s+there)/i;

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

function buildFactsPrompt(transcript: string): string {
  return [
    "You are extracting durable user facts from a single session transcript.",
    "",
    "Return ONLY valid JSON with this exact shape:",
    "{",
    '  "facts": [',
    "    {",
    '      "fact_key": string,',
    '      "value_json": any,',
    '      "context": string | null,',
    '      "confidence": number',
    "    }",
    "  ]",
    "}",
    "",
    "Rules:",
    '- fact_key must be a dot-separated stable key (e.g., "work.status", "health.exercise_frequency").',
    "- value_json must be valid JSON (string/number/bool/object/array). Do not wrap JSON inside a string.",
    "- confidence must be 0..1.",
    '- If no reliable facts, return {"facts": []}.',
    "",
    "TRANSCRIPT:",
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
      return jsonResponse(
        { ok: false, where: "env", error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
        200,
      );
     }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const body = await req.json().catch(() => ({}));
    const batchSize = clamp(Number(body?.batch_size ?? 20), 1, 50);
    const dryRun = Boolean(body?.dry_run ?? false);
    const onlyGarbage = body?.only_garbage === undefined ? true : Boolean(body?.only_garbage);
    const force = Boolean(body?.force ?? false);
 
    const mode = safeString((body as any)?.mode ?? (body as any)?.op).trim() || "summaries";
    const sessionUserId = safeString((body as any)?.user_id);
    const sessionConvId = safeString((body as any)?.conversation_id);
    const isRepairLegacy = mode === "repair_legacy";
    const alsoRebuildInsights =
      (body as any)?.also_rebuild_insights === undefined ? true : Boolean((body as any)?.also_rebuild_insights);

     const scopeUserId = safeString(body?.scope?.user_id);
     const createdAfter = safeString(body?.scope?.created_after);
     const createdBefore = safeString(body?.scope?.created_before);
 const scopeRawIds = Array.isArray(body?.scope?.raw_ids)
  ? (body.scope.raw_ids as unknown[]).filter((v) => typeof v === "string" && (v as string).length >= 16).slice(0, 2000) as string[]
  : [];

    const cursor = decodeCursor(body?.cursor);
    let q: any;

     // Mode: summaries (default) or session
     if (mode === "summaries") {
       q = supabase
        .from("memory_summary")
        .select("id,user_id,raw_id,conversation_id,created_at,short_summary,session_insights");
     }
    if (mode === "session") {
      if (!sessionUserId || !sessionConvId) {
        return jsonResponse({ error: "mode=session requires user_id and conversation_id" }, 400);
      }
      q = supabase
        .from("memory_summary")
        .select("id,user_id,raw_id,conversation_id,created_at,short_summary,session_insights")
        .eq("user_id", sessionUserId)
        .eq("conversation_id", sessionConvId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(10);
    }

    if (isRepairLegacy) {
      if (!sessionUserId) {
        return jsonResponse({ error: "mode=repair_legacy requires user_id" }, 400);
      }
      q = supabase
        .from("memory_summary")
        .select("id,user_id,raw_id,conversation_id,created_at,short_summary,session_insights")
        .eq("user_id", sessionUserId);
    }    

    if (!q) {
      return jsonResponse({ ok: false, where: "mode", error: `Unknown or unsupported mode: ${mode}` }, 200);
    }
    
    q = q
       .order("created_at", { ascending: true })
       .order("id", { ascending: true })
       .limit(batchSize);

    if (mode !== "session") {
      if (scopeUserId) q = q.eq("user_id", scopeUserId);
      if (createdAfter) q = q.gte("created_at", createdAfter);
      if (createdBefore) q = q.lte("created_at", createdBefore);
      if (scopeRawIds.length) q = (mode === "facts") ? q.in("id", scopeRawIds) : q.in("raw_id", scopeRawIds);
      // Cursor pagination (created_at, id)
      if (cursor) {
        q = q.or(`created_at.gt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.gt.${cursor.id})`);
      }
    }

    const { data: rows, error } = await q;
    if (error) {
      return jsonResponse(
        { ok: false, where: "query", mode, error: error.message },
        200,
      );
    }

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
    }    // ------------------------------------------------------------------
    // FACTS MODE: rebuild user_facts from memory_raw.content
    // ------------------------------------------------------------------
    if (mode === "facts") {
      let updated = 0;
      let skipped = 0;
      let errors = 0;
      const samples: any[] = [];

      let lastCreatedAt: string | null = null;
      let lastId: string | null = null;

      for (const row of rows as any[]) {
        const id = String((row as any)?.id ?? "");
        const userId = String((row as any)?.user_id ?? "");
        const createdAt = String((row as any)?.created_at ?? "");
        const content = String((row as any)?.content ?? "").trim();

        lastCreatedAt = createdAt || lastCreatedAt;
        lastId = id || lastId;

        if (!id || !userId || !content) {
          skipped++;
          continue;
        }

        const prompt = buildFactsPrompt(content);
        try {
          const raw = await callGemini(prompt);
          const obj = tryParseJson(raw) ?? {};
          const facts = Array.isArray((obj as any)?.facts) ? ((obj as any).facts as any[]) : [];

          if (!facts.length) {
            skipped++;
            continue;
          }

          const upserts = facts
            .map((f) => {
              const rawKey = safeString((f as any)?.fact_key);
              const fact_key = normalizeFactKey(rawKey);
              if (!fact_key) return null;
              return {
                user_id: userId,
                fact_key,
                value_json: (f as any)?.value_json ?? null,
                context: typeof (f as any)?.context === "string" ? (f as any).context : null,
                confidence: typeof (f as any)?.confidence === "number" ? (f as any).confidence : null,
              };
            })
            .filter((r): r is {
              user_id: string;
              fact_key: string;
              value_json: unknown;
              context: string | null;
              confidence: number | null;
            } => r !== null && r.fact_key.length > 0);

          if (!upserts.length) {
            skipped++;
            continue;
          }

          if (!dryRun) {
            const { error: upsertErr } = await supabase
              .from("user_facts")
              .upsert(upserts, { onConflict: "user_id,fact_key" });

            if (upsertErr) {
              errors++;
              if (samples.length < 10) samples.push({ id, status: "error", reason: upsertErr.message });
              continue;
            }
          }

          updated += upserts.length;
          if (samples.length < 10) samples.push({ id, status: dryRun ? "dry_run" : "updated", facts: upserts.length });
        } catch (e) {
          errors++;
          const msg = (e as any)?.message ? String((e as any).message) : String(e);
          if (samples.length < 10) samples.push({ id, status: "error", reason: msg });
        }
      }

      const cursor_next = (lastCreatedAt && lastId) ? encodeCursor({ created_at: lastCreatedAt, id: lastId }) : null;

      return jsonResponse({
        mode,
        processed,
        updated,
        skipped,
        errors,
        done: (rows.length < batchSize),
        cursor_next,
        samples,
      });
    }



    let updated = 0;
    let skipped = 0;
    let errors = 0;
    const samples: any[] = [];

    for (const row of rows) {
      try {
        const id = safeString((row as any)?.id);
        const userId = safeString((row as any)?.user_id);
        const rawId = safeString((row as any)?.raw_id);

        if (!id || !userId) {
          skipped++;
          if (samples.length < 10) {
            samples.push({ id: id || "(missing)", status: "skipped", reason: "missing id/user_id" });
          }
          continue;
        }
      // ---- Safe targeting gates ----
      const si = (row.session_insights ?? {}) as any;
      const version = typeof si?.version === "string" ? si.version : "";

      const existingShort = safeString((row as any).short_summary);
      const existingIsGarbage = isGarbageSummary(existingShort);
 
      // Repair mode is always "only garbage" + force.
      const effectiveOnlyGarbage = isRepairLegacy ? true : onlyGarbage;
      const effectiveForce = isRepairLegacy ? true : force;

      // If onlyGarbage mode, never touch good rows
      if (effectiveOnlyGarbage && !existingIsGarbage) {
         skipped++;
         continue;
       }

        // Load memory_raw anchor to get conversation_id
        // Prefer the summary row's conversation_id (it is often more reliable for older data),
        // otherwise fall back to the raw anchor's conversation_id.
        let convId = safeString((row as any).conversation_id);
        let transcriptUserId = userId;
        if (!convId) {
          if (rawId) {
            const { data: rawAnchor, error: rawErr } = await supabase
              .from("memory_raw")
              .select("conversation_id,user_id,created_at")
              .eq("id", rawId)
              .maybeSingle();
 
            if (rawErr) {
              console.warn("raw anchor lookup failed", { id, rawId, rawErr: rawErr.message });
            }
            convId = safeString(rawAnchor?.conversation_id);
            transcriptUserId = safeString((rawAnchor as any)?.user_id) || transcriptUserId;
          }
        }

       if (!convId) {
        if (rawId) {
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
       }

      if (!convId) {
        // Can't rebuild without a conversation_id -> quarantine by stamping version so future runs skip.
        const nowIso = new Date().toISOString();
        const existingShort = safeString((row as any).short_summary) || "You checked in briefly, but you did not record a detailed story in this session.";
        // No memory_summary.full_summary column in this project; preserve full summary from session_insights if present.
        const existingFull = safeString((si as any)?.full_summary) || null;
 
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
        .select("id,role,source,content,created_at")
        .eq("user_id", transcriptUserId)
        .eq("conversation_id", convId)
        .order("created_at", { ascending: true })
        .limit(400);

      if (tErr || !turns || turns.length === 0) {
        // Older rows can have mismatched conversation_id/transcript linkage.
        // Quarantine so future runs skip, while preserving existing summaries.
        const nowIso = new Date().toISOString();
        const existingShort = safeString((row as any).short_summary) || "You checked in briefly, but you did not record a detailed story in this session.";
        // No memory_summary.full_summary column in this project; preserve full summary from session_insights if present.
        const existingFull = safeString((si as any)?.full_summary) || null;
 
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

      // Overlay edits from memory_raw_edits for summarization
      const rawIds = (turns ?? [])
        .map((t: any) => safeString(t?.id))
        .filter((s) => s.length >= 16);

      const editsByRawId = new Map<string, string>();
      if (rawIds.length) {
        const { data: edits, error: eErr } = await supabase
          .from("memory_raw_edits")
          .select("raw_id,edited_content")
          .eq("user_id", userId)
          .eq("status", "active")
          .eq("is_current", true)
          .contains("use_for", ["summarization"])
          .in("raw_id", rawIds);

        if (!eErr && Array.isArray(edits)) {
          for (const e of edits as any[]) {
            const rid = safeString(e?.raw_id);
            const txt = safeString(e?.edited_content);
            if (rid && txt) editsByRawId.set(rid, txt);
          }
        }
      }

       for (const t of turns) {
         const role = safeString(t.role || t.source || "");
         const rawId = safeString((t as any)?.id);
         const edited = rawId ? editsByRawId.get(rawId) : undefined;
         const content = safeString(edited ?? t.content);
         if (!content) continue;
         transcriptLines.push(`${role}: ${content}`);
         if ((t.role === "user" || t.source === "legacy_user") && content) {
           userTextAll += content + "\n";
         }
       }
      let newShort = "";
      let newFull: string | null = null;
      let reflections: string[] = [];
      let longitudinal: string | null = null;

       // Treat as "no story" ONLY when it's clearly a wake/procedural ping AND extremely short.
       // IMPORTANT: users may edit assistant turns or restructure the transcript; consider total transcript too.
       const userWords = countWords(userTextAll);
       const totalWords = countWords(transcriptLines.join("\n"));
       const isWake = looksLikeWakeOrProcedural(userTextAll);
       const isVeryShort = userWords < 80;
       // If the overall transcript has substance, don't force the placeholder even if user-only words are low.
       const transcriptHasSubstance = totalWords >= 60;
       const isNoStory = !transcriptHasSubstance && ((isWake && isVeryShort) || userWords < 20);
 
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
{
  const trimmed = newShort.trim();
  if (!isNoStory && /^you checked in briefly/i.test(trimmed)) {
    // Prefer the first *substantive* user turn (skip wake/pings).
    const substantiveUser = (turns.find((t: any) => {
      const isUser = (t.role === "user" || t.source === "legacy_user");
      const txt = safeString(t.content).replace(/\s+/g, " ").trim();
      return isUser && txt && countWords(txt) >= 20 && !looksLikeWakeOrProcedural(txt);
    })?.content ?? "").toString();

    const cleaned = safeString(substantiveUser).replace(/\s+/g, " ").trim();
    newShort = cleaned
      ? `Session recap: ${cleaned.slice(0, 160)}${cleaned.length > 160 ? "…" : ""}`
      : "Session recap captured.";
  }
}

// Final safety: never overwrite with garbage output in onlyGarbage mode.
if (onlyGarbage && isGarbageSummary(newShort)) {
  // In legacy repair mode, we *must* overwrite placeholders. Use a non-garbage fallback instead of skipping.
  if (!isNoStory && transcriptHasSubstance) {
    const fallback = (turns.find((t: any) => {
      const isUser = (t.role === "user" || t.source === "legacy_user");
      const txt = safeString(t.content).replace(/\s+/g, " ").trim();
      return isUser && txt && countWords(txt) >= 20 && !looksLikeWakeOrProcedural(txt);
    })?.content ?? "").toString();
    const cleaned = safeString(fallback).replace(/\s+/g, " ").trim();
    newShort = cleaned
      ? `Session recap: ${cleaned.slice(0, 160)}${cleaned.length > 160 ? "…" : ""}`
      : "Session recap captured.";
  } else {
    skipped++;
    samples.push({ id, status: "skipped", reason: "generated_summary_classified_garbage" });
    continue;
  }
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
        samples.push({ id, status: dryRun ? "dry_run" : "updated", convId });
      } catch (e) {
        errors++;
        const msg = (e as any)?.message ? String((e as any).message) : String(e);
        const rowId = safeString((row as any)?.id) || "(unknown)";
        if (samples.length < 10) {
          samples.push({ id: rowId, status: "error", reason: msg });
        }
        continue;
      }
    }
 
    // In session mode, also rebuild insights (best-effort) so one button touches both artifacts.
    let rebuildInsights: any = null;
    if (mode === "session" && !dryRun && sessionUserId && sessionConvId && alsoRebuildInsights) {
      try {
        const res = await invokeEdgeFunction(SUPABASE_URL, SERVICE_KEY, "rebuild-insights", {
          user_id: sessionUserId,
          conversation_id: sessionConvId,
          source: "rebuild-summaries-v2/session",
        });
        rebuildInsights = { ok: res.ok, status: res.status, text: res.text };
      } catch (e) {
        rebuildInsights = { ok: false, status: 0, error: String((e as any)?.message ?? e) };
      }
    }
     return jsonResponse({
       ok: true,
       mode,
       processed,
       updated,
       skipped,
       errors,
       done: (rows.length < batchSize),
       cursor_next: null,
       samples,
       rebuild_insights: rebuildInsights ?? undefined,
      });
    } catch (e) {
      const msg = (e as any)?.message ? String((e as any).message) : String(e);
     const stack = typeof (e as any)?.stack === "string" ? String((e as any).stack) : "";
     return jsonResponse(
       {
         ok: false,
         where: "top",
         error: msg,
         stack: stack ? stack.slice(0, 1200) : undefined,
       },
       200,
     );
    }
  });