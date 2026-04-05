// supabase/functions/avatar/index.ts
// Receipts-only Avatar with Gemini synthesis, validation, and reuse penalties

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

 const corsHeaders = {
   "Access-Control-Allow-Origin": "*",
   "Access-Control-Allow-Headers":
     "authorization, x-client-info, apikey, x-sb-secret-key, content-type",
   "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
 
// (removed) authedUserId shim — avatar derives user_id from the Bearer JWT when present.

 type SpeakRequest = {
   action: "speak";
   text: string;
   voice_id?: string; // app preset id (e.g., older_male)
   format?: "mp3" | "wav";
 };

type AllowedSource = "user_knowledge";

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

 function needsMemory(q: string): boolean {
   const s = String(q ?? "").trim().toLowerCase();
   if (!s) return false;
   // Heuristic: only fetch heavy memory tables when the user is explicitly asking about
   // past sessions / saved memories / stories, or when they reference specific people/events.
   if (/(\bremember\b|\bsaved\b|\bfrom\s+my\s+(memories|stories)\b|\blast\s+time\b|\bearlier\b|\bprevious\b|\bwhat\s+did\s+i\s+say\b)/i.test(s)) return true;
   if (/(\bstory\b|\bstory\s+seed\b|\bmurder\s+crab\b|\bsuckling\s+pig\b)/i.test(s)) return true;
   if (/(\bmy\s+(dad|father|mom|mother|daughters?)\b|\bmiddle\s+daughter\b)/i.test(s)) return true;

   // Identity / core-profile questions should always pull memory (baseline facts + receipts).
   if (/(\bmy\s+name\b|\bwhat\s+is\s+my\s+name\b|\bage\b|\bdate\s+of\s+birth\b|\bbirthday\b|\bdob\b|\bchildren\b|\bdaughters?\b|\bwhere\s+did\s+i\s+work\b|\bhow\s+long\b)/i.test(s)) return true;
   return false;
 }

function safeJsonStringify(v: any): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "\"\"";
  }
}

 function pickRelevantFactsFromMap(facts: any, question: string, maxItems = 18): Array<[string, any]> {
   if (!facts || typeof facts !== "object") return [];
   const q = String(question ?? "").toLowerCase();
 
   // Simple prefix routing. Keep tiny and deterministic.
  const prefixes: string[] = [];
  if (/\bstory\b/i.test(q)) {
    prefixes.push("stories.");
  }
   if (/(food|eat|diet|fruit|snack|grocery|restaurant|buffet|peach|apple)/i.test(q)) {
    prefixes.push("preferences.", "diet.", "food.");
  } else if (/(education|college|university|degree|degrees|bachelor|master|mba|phd|school)/i.test(q)) {
    // Your actual keys live under identity.education.*
    prefixes.push("identity.education.", "education.", "work.");
   } else if (/(work|job|career|employ|ssa|social security|office)/i.test(q)) {
    prefixes.push("work.", "identity.education.", "education.");
   } else if (/(wife|husband|partner|relationship|married|single|kids|children|daughter|son|family)/i.test(q)) {
     prefixes.push("relationships.");
   } else if (/(live|living|where|location|country|city|timezone)/i.test(q)) {
     prefixes.push("location.");
   } else if (/(value|principle|belief|what matters|purpose)/i.test(q)) {
     prefixes.push("values.");
   }
 
  // If we can't bucket the question, still include baseline profile facts so we do not
   // incorrectly claim "not recorded" when facts exist in user_knowledge.
   if (!prefixes.length) {
     prefixes.push(
       "identity.",
       "identity.education.",
       "relationships.",
       "work.",
       "location.",
       "preferences.",
       "beliefs.",
       "views.",
       "projects.",
       "stories.",
     );
   }

   const entries = Object.entries(facts) as Array<[string, any]>;
   if (!entries.length) return [];
 
   const picked: Array<[string, any]> = [];
   const seen = new Set<string>();
 
   const accept = (k: string) => {
     if (seen.has(k)) return false;
     if (!prefixes.length) return false;
     for (const p of prefixes) if (k.startsWith(p)) return true;
     return false;
   };

  for (const [k, v] of entries) {
    if (picked.length >= maxItems) break;
    if (!accept(k)) continue;
    seen.add(k);
    picked.push([k, v]);
  }

  return picked;
}

function renderFactLines(items: Array<[string, any]>, maxChars = 900): string {
  if (!items.length) return "";
  const lines: string[] = [];
  let total = 0;
  for (const [k, v] of items) {
    const line = `- ${k}: ${typeof v === "string" ? v : safeJsonStringify(v)}`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}

function buildStoryRetellBlockFromFacts(facts: any, question: string): string {
  const q = String(question ?? "").trim();
  if (!q) return "";
  if (!/(tell me|retell|share)\b.*\bstory\b/i.test(q) && !/\bstory\b/i.test(q)) return "";
  if (!facts || typeof facts !== "object") return "";

  const m = q.match(/(?:tell me|retell|share)\s+(?:the\s+)?(.+?)\s+story\b/i);
  const needleRaw = String(m?.[1] ?? q).trim().toLowerCase();
  const needle = needleRaw.replace(/[^a-z0-9_\s-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!needle) return "";

  const entries = Object.entries(facts) as Array<[string, any]>;
  const storyEntries = entries.filter(([k]) => typeof k === "string" && k.startsWith("stories."));
  if (!storyEntries.length) return "";

  const score = (k: string, v: any): number => {
    const title = typeof v === "object" && v ? String((v as any).title ?? "") : "";
    const synopsis = typeof v === "object" && v ? String((v as any).synopsis ?? "") : (typeof v === "string" ? v : "");
    const hay = `${k} ${title} ${synopsis}`.toLowerCase();
    let s = 0;
    if (hay.includes(needle)) s += 5;
    const parts = needle.split(" ").filter(Boolean);
    for (const p of parts) if (p.length >= 4 && hay.includes(p)) s += 1;
    return s;
  };

  let best: { k: string; v: any; s: number } | null = null;
  for (const [k, v] of storyEntries) {
    const s = score(k, v);
    if (s <= 0) continue;
    if (!best || s > best.s) best = { k, v, s };
  }
  if (!best) return "";

  const v = best.v;
  const title = typeof v === "object" && v ? String((v as any).title ?? "") : "";
  const synopsis = typeof v === "object" && v ? String((v as any).synopsis ?? "") : (typeof v === "string" ? v : "");
  const story = typeof v === "object" && v ? String((v as any).story ?? "") : "";

  const label = title || best.k.replace(/^stories\./, "");
  const storyText = (story || synopsis).trim();
  if (!storyText) return "";

  return [
    "STORY_RETELL (from user_knowledge):",
    `TITLE: ${label}`,
    `SYNOPSIS: ${synopsis ? synopsis.slice(0, 420) : ""}`,
    "STORY:",
    storyText.slice(0, 2600),
  ].join("\n");
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  if (!ms || ms <= 0) return await p;
  return await Promise.race([
    p,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
 }

function monthNameToNumber(m: string): number | null {
  const s = m.toLowerCase();
  if (s.startsWith("jan")) return 1;
  if (s.startsWith("feb")) return 2;
  if (s.startsWith("mar")) return 3;
  if (s.startsWith("apr")) return 4;
  if (s.startsWith("may")) return 5;
  if (s.startsWith("jun")) return 6;
  if (s.startsWith("jul")) return 7;
  if (s.startsWith("aug")) return 8;
  if (s.startsWith("sep")) return 9;
  if (s.startsWith("oct")) return 10;
  if (s.startsWith("nov")) return 11;
  if (s.startsWith("dec")) return 12;
  return null;
}

function parseMonthDayFromDobValue(v: unknown): { month: number; day: number } | null {
  const raw = typeof v === "string" ? v : (v == null ? "" : String(v));
  const s = raw.replace(/\s+/g, " ").trim();
  // Examples: "October 20th", "Oct 20", "October 20"
  const m = s.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\s+(\d{1,2})/i,
  );
  if (!m) return null;
  const month = monthNameToNumber(m[1]);
  const day = Math.max(1, Math.min(31, parseInt(m[2], 10) || 0));
  if (!month || !day) return null;
  return { month, day };
}

function parseAgeValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  const s = (v == null ? "" : String(v)).trim();
  const m = s.match(/\b(\d{1,3})\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0, Math.floor(n));
}

// Avatar answers from user_knowledge (authoritative runtime memory surface).
// Older multi-table recall (fact_candidates/story_recall receipts) is deprecated and removed.

function safeJsonParse(raw: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    let s = (raw ?? "").trim();

    // Common LLM wrappers: ```json ... ``` or ``` ... ```
    if (s.startsWith("```")) {
      s = s.replace(/^```(?:json)?\s*/i, "");
      s = s.replace(/\s*```$/i, "");
      s = s.trim();
    }
  
    // If extra text surrounds JSON, attempt to slice the outermost object/array.
    const firstObj = s.indexOf("{");
    const firstArr = s.indexOf("[");
    let start = -1;
    if (firstObj >= 0 && firstArr >= 0) start = Math.min(firstObj, firstArr);
    else start = Math.max(firstObj, firstArr);

    if (start > 0) s = s.slice(start).trim();

    const lastObj = s.lastIndexOf("}");
    const lastArr = s.lastIndexOf("]");
    const end = Math.max(lastObj, lastArr);
    if (end >= 0 && end < s.length - 1) s = s.slice(0, end + 1).trim();

    const value = JSON.parse(s);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Light deterministic "de-templating" to reduce repetitive boilerplate without changing meaning.
 function deTemplateReply(text: string): string {
   let t = String(text ?? "").trim();
   if (!t) return t;

   t = t.replace(/^It[’']s about\s+/i, "");  
  // Strip common "parrot mode" openers that hurt voice quality / rubric score.
  // Only at the start, so we don't damage meaning mid-sentence.
  t = t.replace(/^It sounds like\s+/i, "");
  t = t.replace(/^It seems like\s+/i, "");
  t = t.replace(/^You(?:'re| are)\s+(?:talking about|referring to)\s+/i, "");

   // Common copy/paste openers we want to avoid
   t = t.replace(/^This refers to\s+/i, "It’s about ");
   t = t.replace(/^That refers to\s+/i, "It’s about ");
   t = t.replace(/^This is about\s+/i, "It’s about ");
   t = t.replace(/^This relates to\s+/i, "It’s tied to ");

   return t;
 }

function sanitizeSpeakableText(input: string): string {
  if (!input) return "";
  let out = input;
  // Strip SSML/XML/HTML tags.
  out = out.replace(/<[^>]+>/g, "");
  // Strip bracketed or asterisk stage directions like [pause] or *laughs*.
  out = out.replace(/\[[^\]]*\]/g, "");
  out = out.replace(/\*[^*]+\*/g, "");
  // Strip common markdown scaffolding.
  out = out.replace(/```[\s\S]*?```/g, "");
  out = out.replace(/^#{1,6}\s+/gm, "");
  out = out.replace(/[`_]/g, "");
  // Normalize whitespace for TTS.
  out = out.replace(/\s+/g, " ").trim();
  // Keep audio responses bounded.
  if (out.length > 1200) out = out.slice(0, 1197).trimEnd() + "...";
  return out;
}

function buildRepairPrompt(args: { donorName: string; previousOutput: string; error: string }): string {
  return [
    "You are the Avatar agent for a personal legacy app.",
    `DONOR_NAME: ${args.donorName}`,
    "Your previous response was NOT valid for the required strict JSON output.",
    `ERROR: ${args.error}`,
    "Return ONLY repaired STRICT JSON. No markdown, no backticks, no extra text.",
    "Schema:",
    '{"agent":"avatar_v1","reply_text":string,"receipts":[{"id":string,"source":"receipt"|"avatar_turns","quote":string,"why":string}],"confidence"?:number}',
    "Previous output (as a JSON string):",
    JSON.stringify(args.previousOutput),
  ].join("\n");
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
 
  // Speakability guardrails (hard rejection): no tags, no stage directions, no markdown fences
   if (typeof resp?.reply_text === "string") {
     const t = resp.reply_text;
    // Note: reject any angle-bracket tags OR stray < / >, common stage directions, and markdown headings/fences.
    const badSpeak = /<[^>]*>|\[[^\]]+\]|\*[^*]+\*|```|^\s{0,3}#{1,6}\s+/m;
     if (badSpeak.test(t) || /[<>]/.test(t)) errs.push("reply_text contains non-speakable markup");
      if (t.length > 1200) errs.push("reply_text too long for TTS");

     // Avatar contract: first-person donor voice. Reject obvious second-person openings.
     if (/^\s*(you|your)\b/i.test(t)) errs.push("reply_text must be first-person (no 'you/your' opener)");
    }
   
   if (Array.isArray(resp?.receipts)) {
    if (resp.receipts.length > 5) errs.push("receipts too long (max 5)");
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
  const t0 = performance.now();

  const GEMINI_API_KEY =
    Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GEMINI_API_KEY_EDGE");

  const GEMINI_MODEL = (Deno.env.get("GEMINI_MODEL") || "").trim();
  if (!GEMINI_MODEL) {
    throw new Error("Missing required edge secret: GEMINI_MODEL");
  }

   if (!GEMINI_API_KEY) {
     throw new Error("Missing GEMINI_API_KEY (or GEMINI_API_KEY_EDGE)");
   }
 
  // Match legacy/turn_core behavior: accept either "models/<name>" or "<name>"
  const modelName = GEMINI_MODEL.startsWith("models/")
    ? GEMINI_MODEL
    : `models/${GEMINI_MODEL}`;
 
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
    },
  );
 
   if (!res.ok) {
     const bodyText = await res.text().catch(() => "");
     throw new Error(
      `Gemini non-OK: ${res.status} ${res.statusText} | model=${modelName} | body=${(bodyText || "").slice(0, 1200)}`,
       );
       }
  const json: any = await res.json();
  // Gemini sometimes returns multiple parts; join all text parts.
  const parts = json?.candidates?.[0]?.content?.parts;
  const out = Array.isArray(parts)
    ? parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
    : (json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");

  // Surface useful diagnostics when Gemini returns no text (often safety block / empty candidate).
  if (!out || String(out).trim().length === 0) {
    const blockReason =
      json?.promptFeedback?.blockReason ??
      json?.promptFeedback?.block_reason ??
      json?.candidates?.[0]?.finishReason ??
      json?.candidates?.[0]?.finish_reason ??
      "";
    const diag = JSON.stringify(
      { has_candidates: Array.isArray(json?.candidates), block_reason: blockReason, model: modelName },
    );
    throw new Error(`Gemini returned empty text. diag=${diag} json=${JSON.stringify(json).slice(0, 1200)}`);
  }
  console.log(JSON.stringify({ tag: "avatar_timing", where: "callGemini", ms: Math.round(performance.now() - t0), prompt_chars: (prompt || "").length, model: modelName }));
  return out;
 }

/* -------------------- main -------------------- */

function presetToOpenAIVoice(presetId?: string): string {
  // Map your app’s preset IDs → OpenAI built-in voices (safe prototype).
  // You can later switch this to custom voice IDs without changing the client contract.
  const id = (presetId ?? "").toLowerCase().trim();
  if (id === "older_male") return "onyx";
  if (id === "young_male") return "echo";
  if (id === "older_female") return "sage";
  if (id === "young_female") return "nova";
  return "alloy";
}

function toBase64(bytes: Uint8Array): string {
  // Deno-safe base64 encoding
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

 const BUILD_ID = "avatar-build-verify-v3";

 // (removed) authedUserId shim — avatar derives user_id from the Bearer JWT when present.
 
 serve(async (req) => {
   const tReq0 = performance.now();
   let geminiCalls = 0;
  const tMark: Record<string, number> = {};
  const mark = (k: string) => (tMark[k] = performance.now());
  const dur = (k: string) => Math.round(performance.now() - (tMark[k] ?? tReq0));
  const logStage = (stage: string, extra: Record<string, unknown> = {}) => {
    console.log(
      JSON.stringify({
        tag: "avatar_stage",
        stage,
        ms: Math.round(performance.now() - tReq0),
        ...extra,
      }),
    );
  };
 
   const url = new URL(req.url);
 
   // quick health/ping for deployments
  if (url.searchParams.get("ping") === "1") {
    return new Response(`AVATAR_EDGE_HIT ✅ build=${BUILD_ID}`, { status: 200, headers: corsHeaders });
  }

   if (req.method === "OPTIONS") {
     return new Response("ok", { status: 200, headers: corsHeaders });
   }

  try {
 
   const authHeader =
     req.headers.get("authorization") ??
    "";
  const hasBearer = authHeader.toLowerCase().startsWith("bearer ");

  // Mirror ai-brain: authenticated app traffic uses Supabase JWT (Bearer).
  // Keep SB_SECRET_KEY only for CI/E2E callers that do not have a JWT.
  const requiredSecret = Deno.env.get("SB_SECRET_KEY") ?? "";
  if (!hasBearer && requiredSecret) {
    const provided =
      req.headers.get("x-sb-secret-key") ??
      req.headers.get("apikey") ??
      "";
    if (provided !== requiredSecret) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized", build: BUILD_ID }), {
        status: 401,
        headers: corsHeaders,
      });
    }
  }

     const bodyAny: any = await req.json();
 
     // If we have a Bearer token, verify it and derive user_id from it.
     if (hasBearer) {
       const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
       const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
       if (!supabaseUrl || !serviceKey) {
         return new Response(JSON.stringify({ ok: false, error: "Server misconfigured (missing SUPABASE_URL/SERVICE_ROLE_KEY)" }), {
           status: 500,
           headers: corsHeaders,
         });
       }
       const supaAuth = createClient(supabaseUrl, serviceKey, {
         global: { headers: { Authorization: authHeader } },
         auth: { persistSession: false, autoRefreshToken: false },
       });
       const { data, error } = await supaAuth.auth.getUser();
       if (error || !data?.user?.id) {
         return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
           status: 401,
           headers: corsHeaders,
         });
       }
     }

    // -------------------------------------------------------------------------
    // action = "speak" : Text → Speech (prototype; built-in voice)
    // Called by the Flutter speaker button in Avatar mode.
    // -------------------------------------------------------------------------
    if ((bodyAny?.action ?? "") === "speak") {
      const body = bodyAny as SpeakRequest;
      const text = String(body?.text ?? "").trim();
      if (!text) {
        return new Response(JSON.stringify({ ok: false, error: "Missing text" }), {
          status: 400,
          headers: corsHeaders,
        });
      }

      const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
      if (!OPENAI_API_KEY) {
        return new Response(JSON.stringify({ ok: false, error: "Missing OPENAI_API_KEY" }), {
          status: 500,
          headers: corsHeaders,
        });
      }

      const format = (body?.format ?? "mp3") as "mp3" | "wav";
      const voice = presetToOpenAIVoice(body?.voice_id);
      const model = "gpt-4o-mini-tts";

      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          voice,
          format,
          input: text,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        return new Response(
          JSON.stringify({ ok: false, error: `TTS non-OK: ${res.status} ${res.statusText}`, detail: errText.slice(0, 800) }),
          { status: 500, headers: corsHeaders },
        );
      }

      const buf = new Uint8Array(await res.arrayBuffer());
      const audio_base64 = toBase64(buf);
      const mime_type = format === "wav" ? "audio/wav" : "audio/mpeg";
      return new Response(
        JSON.stringify({ ok: true, audio_base64, mime_type, model, voice }),
        { status: 200, headers: corsHeaders },
      );
    }

      const body: AvatarRequest = bodyAny as AvatarRequest;
      
     // Be tolerant: different clients/modes may send different field names.
    const body_user_id = (body as any).user_id ?? (body as any).userId ?? null;
 
       const supabaseAuth = createClient(
         Deno.env.get("SUPABASE_URL")!,
         Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
         { global: { headers: { Authorization: authHeader } } },
       );
 
      mark("auth_getUser");
       const { data, error } = await supabaseAuth.auth.getUser();
      logStage("auth_getUser", { ms_stage: dur("auth_getUser") });
       if (error || !data?.user?.id) {
         return new Response(JSON.stringify({ ok: false, error: "Unauthorized", build: BUILD_ID }), {
           status: 401,
           headers: corsHeaders,
         });
       }
     const user_id = data.user.id;
     if (body_user_id && body_user_id !== data.user.id) {
       return new Response(JSON.stringify({ ok: false, error: "user_id mismatch", build: BUILD_ID }), {
         status: 403,
        headers: corsHeaders,
      });
    }

      const conversation_id_raw =
        (body as any).conversation_id ?? (body as any).conversationId ?? null;
      // Ensure avatar_turns always gets a stable conversation_id even if the client/proxy omits it.
      const effectiveConversationId =
        typeof conversation_id_raw === "string" && conversation_id_raw.trim().length > 0
          ? conversation_id_raw.trim()
          : crypto.randomUUID();

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

    const requestedModeRaw =
      (body as any)?.mode ??
      (body as any)?.conversation_mode ??
      (body as any)?.chat_mode ??
      (body as any)?.conversationMode ??
      "avatar";
    const requestedMode = String(requestedModeRaw ?? "avatar").toLowerCase().trim();
    const voiceHint = String((body as any)?.voice ?? "").toLowerCase().trim();
    const neutralVoice = requestedMode === "legacy" || requestedMode.startsWith("legacy") || voiceHint === "assistant";
      
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

    const wantMemory = needsMemory(question);
    // DIAG: verify memory gating + resolved user for this request
    console.log("AVATAR_MEM_GATE", {
      wantMemory,
      user_id,
      q_preview: String(question).slice(0, 80),
    });
    
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    /* ---- user_knowledge (single read model) ---- */
    let userKnowledgeCore: any = null;
    let userKnowledgeFacts: any = null;
    try {
      mark("db_user_knowledge");
      const ukRes = await withTimeout(
        supabase
          .from("user_knowledge")
           .select("core, facts, updated_at")
           .eq("user_id", user_id)
           .maybeSingle(),
        1200,
       );
       logStage("db_user_knowledge", { ms_stage: dur("db_user_knowledge"), timed_out: ukRes == null });
       const uk = (ukRes as any)?.data;
      userKnowledgeCore = (uk as any)?.core ?? null;
      userKnowledgeFacts = (uk as any)?.facts ?? null;
    } catch (_e) {
      // best-effort
    }

       /* ---- donor display name (user_knowledge core first; fallback to fact_candidates) ---- */
        let donorName = (userKnowledgeCore && typeof userKnowledgeCore === "object" && typeof (userKnowledgeCore as any)["identity.name"] === "string")
       ? String((userKnowledgeCore as any)["identity.name"]).trim()
       : "the donor";
        // donor display name is derived from user_knowledge core (authoritative).
        // Do not fall back to older multi-table sources (fact_candidates, etc.).
        logStage("db_profile", { ms_stage: 0, skipped: true });
 
      /* ---- receipts/prior-context (deprecated) ---- */
      // user_knowledge is the authoritative runtime memory surface. We no longer pull
      // "receipts" from fact_candidates/story_recall for prompt-time recall.
       logStage("db_recent_uses", { ms_stage: 0, skipped: true });
      logStage("db_relevant_prior_context", { ms_stage: 0, skipped: true });

      const priorContextBlock = "";
      const topReceipts: Receipt[] = [];
      const lens = (body as any)?.lens ?? null;
      const messageText = question;

    // -----------------------------------------------------------------------
    // FAST PATH: tiny "ping" messages should not pay the full receipts + strict
    // JSON + repair loop cost. This matches the snappy feel of legacy mode for
    // trivial prompts like "are you there?".
    // -----------------------------------------------------------------------
    {
      const m = String(messageText ?? "").trim().toLowerCase();
      const isPing =
        m === "are you there" ||
        m === "are you there?" ||
        m === "you there" ||
        m === "you there?" ||
        m === "hello" ||
        m === "hi" ||
        m === "test";
      if (isPing) {
        return new Response(
          JSON.stringify({ ok: true, agent: "avatar_v1", reply_text: "Yeah — I’m here.", receipts: [], confidence: 0.95 }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }
 
     // Load recent avatar_turns for conversation continuity (most recent last)
     // IMPORTANT: fetch newest first, then reverse for prompt order.
     mark("db_avatar_turns");
     const priorTurnsQuery = supabase
       .from("avatar_turns")
       .select("id, role, content, created_at")
       .eq("user_id", user_id)
       .eq("conversation_id", effectiveConversationId)
       .order("created_at", { ascending: false })
       .limit(18);
 
     const { data: priorTurns } = await priorTurnsQuery;
     logStage("db_avatar_turns", { ms_stage: dur("db_avatar_turns") });
 
     const priorTurnsChron = (priorTurns ?? []).slice().reverse();
       const avatarTurnsBlock = priorTurnsChron
           .map((t) => `${t.role.toUpperCase()}: ${String(t.content ?? "").slice(0, 600)}`)
           .join("\n");

     /* ---- Gemini prompt (strict JSON output) ---- */
mark("prompt_build");
	   const todayIso = new Date().toISOString().slice(0, 10);

      const coreLines = userKnowledgeCore && typeof userKnowledgeCore === "object"
         ? renderFactLines(Object.entries(userKnowledgeCore) as any, 700)
         : "";
      const relItems = pickRelevantFactsFromMap(userKnowledgeFacts, question, 18);
      const relLines = relItems.length ? renderFactLines(relItems, 900) : "";
      const storyRetellBlock = buildStoryRetellBlockFromFacts(userKnowledgeFacts, question);
      const agentIntro = neutralVoice
        ? "You are the assistant brain for a personal legacy app. You are NOT the Legacy summarizer. Speak directly to the user, grounded in the saved memories. Do NOT roleplay as the donor."
        : "You are the Avatar agent for a personal legacy app. You are NOT the Legacy summarizer.";
     const perspectiveRules = neutralVoice
      ? [
          "- Perspective (HARD): Speak directly to the user (second person) as an assistant. Use \"you / your\". Do NOT speak in first person as the donor.",
          "- If the user asks about themselves, answer in second person: \"You were born...\", \"You have...\", etc.",
        ].join("\n")
      : [
          "- Perspective (HARD): Speak strictly in first person as the donor (Steven). Use \"I / me / my\".",
          "  Do NOT refer to the donor as \"you / your\" (no second-person recap like \"you were born...\", \"you have three daughters...\").",
          "  If the user asks about themselves, answer as the donor: \"I was born...\", \"I have...\", etc.",
          "  If you catch yourself mixing first + second person, rewrite reply_text to be consistent first-person.",
        ].join("\n");
      const prompt = `
- You are the Avatar agent for a personal legacy app. You are NOT the Legacy summarizer.
 ${agentIntro}
  
     DONOR_NAME: ${donorName}
  
    TODAY_ISO: ${todayIso}

   USER_KNOWLEDGE_CORE:
 ${coreLines || "(none)"}

     USER_KNOWLEDGE_RELEVANT:
 ${relLines || "(none)"}

   USER_KNOWLEDGE_STORY_RETELL:
 ${storyRetellBlock || "(none)"}
  
      Use ONLY:
      1) The conversation turns provided in AVATAR_TURNS, and
      2) USER_KNOWLEDGE_CORE + USER_KNOWLEDGE_RELEVANT above.

   Rules:
 - Perspective (HARD): Speak strictly in first person as the donor. Use "I / me / my".
   Do NOT refer to the donor as "you / your" (no second-person recap like "you were born...", "you have three daughters...").
   If the user asks about themselves, answer as the donor: "I was born...", "I have...", etc.
   If you catch yourself mixing first + second person, rewrite reply_text to be consistent first-person.
 ${perspectiveRules}
    - Synthesize, don’t echo: RECEIPTS are evidence, not copy/paste text. Write reply_text in a grounded, direct voice. Avoid being overly assistant-y.
- Never output SSML, XML, HTML, or anything like <speak>…</speak>.
- Never include stage directions (e.g., *laughs*, [pause], etc.).
- Avoid templated openers like "This refers to", "You shared", "You are currently", "This is about" unless the user explicitly asks for that framing.
- Do not restate the receipt excerpt verbatim. Paraphrase it, then use 1–5 short receipt quotes only when needed to support a claim.
- NEVER say "I don't have access to personal information". You DO have access to saved memories via USER_KNOWLEDGE_* and AVATAR_TURNS.
  - If the answer is not present in USER_KNOWLEDGE_* or AVATAR_TURNS, say what you *do* know, state what’s missing, and ask ONE clarifying question.
- Read-aloud test (hard rejection): if your reply would sound wrong or evasive when read aloud to the user, rewrite it to be direct, specific, and grounded in receipts.
- If asked to "show receipts", include 1–5 receipts with short quotes that support your answer.
- In reply_text, do NOT copy/paste USER_KNOWLEDGE text. Paraphrase and synthesize in your own voice.
- Write reply_text in a grounded direct voice: grounded, direct, not overly “assistant-y”.
- Never output SSML, XML, HTML, or anything like <speak>…</speak>.
- Never include stage directions (e.g., *laughs*, [pause], etc.).
- No therapy-speak or over-apologizing. Be grounded and direct.
- Never say "As an AI" or mention policies/tooling.
- Minimize hedges ("might", "perhaps") unless you are genuinely uncertain.
- TODAY_ISO is the authoritative current date. Do NOT ask the user what year/date it is; use TODAY_ISO for any date math.
- Use USER_KNOWLEDGE_* to ground specifics (names, places, dates, numbers), but express them naturally.
- Only include verbatim quotes inside the "receipts" array (<=200 chars each), not in reply_text, unless the user asks to quote directly.
- Prefer weaving 2+ concrete details into a single cohesive narrative rather than listing the receipts.
- Avoid summary scaffolding phrases: "This refers to", "This is about", "There’s a mention of", "a few things". Start with the synthesized answer directly.
- When multiple facts appear, connect them with a causal/contrast link (because/however/so) to sound like lived context, not a database recap.
- If the user prompt asks "explain what this refers to", you may answer that—but still avoid mirroring the excerpt sentence structure.
- Keep reply_text phrasing fresh: vary sentence openings; do not repeat the user's wording.
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
 
   USER_MESSAGE:
   ${messageText}
 `.trim();
    logStage("prompt_build", { ms_stage: dur("prompt_build"), prompt_chars: prompt.length, top_receipts: topReceipts.length });
 
     geminiCalls++;
     let raw = await callGemini(prompt);
     let parsedRes = safeJsonParse(raw);
     if (!parsedRes.ok) {
       geminiCalls++;
       raw = await callGemini(
         buildRepairPrompt({ donorName, previousOutput: raw, error: `json_parse: ${parsedRes.error}` })
       );
       parsedRes = safeJsonParse(raw);
     }
     if (!parsedRes.ok) {
      console.error("AVATAR_JSON_INVALID", {
        error: String(parsedRes.error ?? "unknown"),
        raw_preview: String(raw ?? "").slice(0, 800),
      });
       return new Response(
        JSON.stringify({
          ok: false,
          agent: "avatar_v1",
          reply_text: "⚠️ Avatar error: Gemini returned invalid JSON. Check /avatar logs.",
          error: "Gemini returned invalid JSON",
        }),
         { status: 502, headers: corsHeaders }
       );
     }

function rewriteToFirstPersonOpenerV1(reply: string): string {
  const t = String(reply ?? "").trim();
  if (!t) return t;

  // Only touch the opener (first sentence-ish), leave rest intact.
  const m = t.match(/^([\s\S]*?)([.!?]\s+|$)([\s\S]*)$/);
  const first = (m?.[1] ?? t).trim();
  const sep = m?.[2] ?? "";
  const rest = m?.[3] ?? "";

  const firstLower = first.toLowerCase();

  // If opener starts with "you/your/it sounds like you/it seems like you", rewrite opener.
  const startsBad =
    /^you\b/.test(firstLower) ||
    /^your\b/.test(firstLower) ||
    /^it\s+(sounds|seems)\s+like\s+you\b/.test(firstLower) ||
    /^i\s+hear\s+you\b/.test(firstLower);

  if (!startsBad) return t;

  // Common empathetic openers -> first-person equivalents.
  let rewritten = first;

  // "It sounds like you and I ..." -> "I ..."
  rewritten = rewritten.replace(/^it\s+(sounds|seems)\s+like\s+you\s+and\s+i\s+/i, "I ");
  // "It sounds like you ..." -> "I "
  rewritten = rewritten.replace(/^it\s+(sounds|seems)\s+like\s+you\s+/i, "I ");
  // "You and I ..." -> "I "
  rewritten = rewritten.replace(/^you\s+and\s+i\s+/i, "I ");
  // "You ..." -> "I ..."
  rewritten = rewritten.replace(/^you\s+/i, "I ");
  // "Your ..." -> "My ..."
  rewritten = rewritten.replace(/^your\s+/i, "My ");
  // "I hear you ..." -> "I understand ..."
  rewritten = rewritten.replace(/^i\s+hear\s+you\b[:\s-]*/i, "I understand ");

  // Ensure the rewritten opener begins with I/My (validator wants first-person opener)
  const rTrim = rewritten.trim();
  if (!/^(i|my)\b/i.test(rTrim)) {
    rewritten = `I ${rTrim}`;
  }

  const out = `${rewritten.trim()}${sep}${rest}`.replace(/\s+/g, " ").trim();
  return out;
}

    let parsed = parsedRes.value as any;

     const buildResponse = (p: any) => ({
       ok: true,
       agent: "avatar_v1",
       mode: "receipts_only",
       reply_text: sanitizeSpeakableText(deTemplateReply(String(p?.reply_text ?? ""))),
       receipts: Array.isArray(p?.receipts) ? p.receipts : [],
       receipt_catalog: topReceipts,
       confidence: typeof p?.confidence === "number" ? p.confidence : 0.6,
       raw,
     });

 let response = buildResponse(parsed);
 if (typeof response?.reply_text === "string") {
   response.reply_text = rewriteToFirstPersonOpenerV1(response.reply_text);
 }

  let validation = validateAvatarResponse(response);
  if (!validation.ok) {
    console.error("AVATAR_VALIDATION_FAIL_1", { errs: validation.errs, raw_preview: String(raw ?? "").slice(0, 800) });
    geminiCalls++;
    raw = await callGemini(
      buildRepairPrompt({
        donorName,
        previousOutput: raw,
        error: `validation: ${validation.errs.join(" | ")}`,
      })
    );
    parsedRes = safeJsonParse(raw);
    if (parsedRes.ok) {
      parsed = parsedRes.value as any;
      response = buildResponse(parsed);
     if (typeof response?.reply_text === "string") {
       response.reply_text = rewriteToFirstPersonOpenerV1(response.reply_text);
     }
      validation = validateAvatarResponse(response);
    }
  }
 
     if (!validation.ok) {
      console.error("AVATAR_VALIDATION_FAIL_FINAL", { errs: validation.errs, raw_preview: String(raw ?? "").slice(0, 800) });
       return new Response(
         JSON.stringify({
           ok: false,
           agent: "avatar_v1",
           reply_text: "⚠️ Avatar error: validation failed. Check /avatar logs for details.",
           error: "Avatar validation failed",
           details: validation.errs,
         }),
         { status: 500, headers: corsHeaders }
        );
      }
    console.log(JSON.stringify({ tag: "avatar_timing", where: "handler_done", ms: Math.round(performance.now() - tReq0), gemini_calls: geminiCalls }));

     /* ---- record receipt usage ---- */
     for (const r of topReceipts) {
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
        conversation_id: effectiveConversationId,
         role: "user",
         content: String(_rawQuestion ?? "").trim(),
         created_at: nowIso,
         metadata: { mode: "avatar", source: "avatar-edge" },
       });
       rows.push({
         user_id,
         conversation_id: effectiveConversationId,
         role: "assistant",
         content: String((response as any)?.reply_text ?? "").trim(),
         created_at: new Date(Date.parse(nowIso) + 1).toISOString(),
           metadata: {
            mode: "avatar",
            source: "avatar-edge",
            receipt_ids: topReceipts.map((r: any) => r.id),
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
 
    console.log(JSON.stringify({ tag: "avatar_timing", where: "handler_done", ms: Math.round(performance.now() - tReq0), gemini_calls: geminiCalls }));
    // Helpful for clients/proxies that need to persist conversation continuity.
    (response as any).conversation_id = effectiveConversationId;
    return new Response(JSON.stringify(response), {
       headers: { ...corsHeaders, "Content-Type": "application/json" },
     });
  } catch (e) {
    console.log(
      JSON.stringify({
        tag: "avatar_timing",
        where: "handler_error",
        ms: Math.round(performance.now() - tReq0),
        gemini_calls: geminiCalls,
      }),
     );
     console.error("avatar error:", e);
    return new Response(
      JSON.stringify({
        ok: false,
        agent: "avatar_v1",
        reply_text: "⚠️ Avatar service error. Check function logs for details.",
        error: String(e),
        build: BUILD_ID,
      }),
      {
        status: 500,
        headers: corsHeaders,
      },
    );
   }
 });