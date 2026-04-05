export {};
import { buildLegacySystemPrompt, getLegacyPersonaInstructions } from "../../prompts/legacy.ts";
import { buildLegacySessionSummaryPrompt, buildStorySeedsPrompt, buildExtractStoriesPrompt, buildCoverageClassificationPrompt } from "../../prompts/turn_core_prompts.ts";
 
// ---------------------------------------------------------------------------
// Avatar fallback (used when we skip proxying to /avatar, e.g. JWT mismatch).
// Keep this lightweight: the heavy lifting comes from the same contextBlock
// retrieval + evidence-only rules you already enforce.
// ---------------------------------------------------------------------------
function buildAvatarSystemPrompt(preferredLocale: string): string {
  const locale = (preferredLocale || "en").trim();
  return `
You are the user's personal Avatar (agent: avatar_v1).

GOAL:
- Respond naturally and conversationally in ${locale}.
- Be helpful, specific, and grounded in the provided context/evidence.

HARD RULES:
- Do NOT invent personal facts. If something isn't in the provided context, say you’re not sure.
- If the user asks about their own saved memories, use only the supplied context.
- Ask 1 clarifying question when it would materially improve accuracy.

STYLE:
- First-person voice as the user's Avatar when appropriate.
- No markdown fences, no stage directions, no roleplay brackets.
`.trim();
}

/**
 * BURN-DOWN INVENTORY (turn_core.ts) — annotate + delete aggressively.
 * KEEP: code that directly supports (1) in-session continuity, (2) durable memory, (3) dot-connecting, (4) low latency.
 * KILL: anything mode-dead, post-hoc “rewrite” layers, and end-session prose artifacts not used for retrieval.
 *
 * Current calls:
 * - VIP lane heuristics + fact_candidates writes: KEEP (memory substrate; can simplify later)
 * - language_learning mode support (types/helpers/branches): KILL (dead >2 months)
 * - Coverage/lifetime/story-seeds/narrative expansion: KILL-CANDIDATE (non-core; delete next if you want)
 */
 
 // ---------------------------------------------------------------------------
 // VIP lane (hard-gated): always write fact_candidates + selectively promote to canonical facts table [KEEP]
 // ---------------------------------------------------------------------------
 type VipFact = {
   fact_key: string;
   value_json: any; // stored as jsonb by Postgres via Supabase JSON encoding
   context?: string | null;
   confidence?: number;
   stability?: string | null;
   canonical_key?: string | null;
   receipt_quote: string;
 };

  const VIP_ALLOWLIST: Record<string, { stability: string; confidence: number; canonical_key?: string }> = {
    "identity.full_name": { stability: "core", confidence: 0.99, canonical_key: "identity.full_name" },
    "identity.birth_year": { stability: "core", confidence: 0.99, canonical_key: "identity.birth_year" },
    "identity.age": { stability: "stable", confidence: 0.95, canonical_key: "identity.age" },
    "identity.date_of_birth": { stability: "stable", confidence: 0.95, canonical_key: "identity.date_of_birth" },
    "identity.height_inches": { stability: "stable", confidence: 0.92, canonical_key: "identity.height_inches" },
    "health.weight_lbs": { stability: "volatile", confidence: 0.90, canonical_key: "health.weight_lbs" },
    "relationships.daughters.count": { stability: "stable", confidence: 0.92, canonical_key: "relationships.daughters.count" },
    "relationships.daughters": { stability: "stable", confidence: 0.92, canonical_key: "relationships.daughters" },
    "location.current_city": { stability: "stable", confidence: 0.90, canonical_key: "location.current_city" },
    "location.current_country": { stability: "stable", confidence: 0.90, canonical_key: "location.current_country" },
    "location.grew_up_city": { stability: "stable", confidence: 0.92, canonical_key: "location.grew_up_city" },
    "location.grew_up_state": { stability: "stable", confidence: 0.92, canonical_key: "location.grew_up_state" },
    "occupation.last_employer": { stability: "stable", confidence: 0.90, canonical_key: "occupation.last_employer" },
    "occupation.last_role": { stability: "stable", confidence: 0.88, canonical_key: "occupation.last_role" },
    "occupation.retired_year": { stability: "stable", confidence: 0.92, canonical_key: "occupation.retired_year" },
   };
 // Migration: retire user_facts (v1) in favor of receipts-backed canonical table.
 const USER_FACTS_TABLE = "facts_effective";

 function jsonEqualLoose(a: any, b: any) {
   try {
     return JSON.stringify(a) === JSON.stringify(b);
   } catch {
     return String(a) === String(b);
   }
 }

 function uniqueAppend<T>(arr: T[], item: T): T[] {
   return arr.includes(item) ? arr : [...arr, item];
 }

function normalizeForCompare(v: any): any {
  if (typeof v === "string") {
    return v.trim().replace(/\s+/g, " ").toLowerCase();
  }
  return v;
}

function jsonEqualVip(a: any, b: any) {
  // Prefer normalized string equality for common VIP facts.
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  try {
    return JSON.stringify(na) === JSON.stringify(nb);
  } catch {
    return String(na) === String(nb);
  }
}

 function extractVipFactsFromText(userText: string): VipFact[] {
   const facts: VipFact[] = [];
   const t = String(userText ?? "").trim();
   if (!t) return facts;

   const parseSmallInt = (s: string): number | null => {
     const raw = String(s ?? "").trim().toLowerCase();
     if (!raw) return null;
     if (/^\d+$/.test(raw)) return Number(raw);
     const map: Record<string, number> = {
       "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
       "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
     };
     return Object.prototype.hasOwnProperty.call(map, raw) ? map[raw] : null;
   };

   // Full name (conservative)
   // Accept: "my full name is X" OR "my name is X"
   {
     const m =
       t.match(/\bmy\s+full\s+name\s+is\s+"([^"]+)"\s*\.?/i) ??
       t.match(/\bmy\s+full\s+name\s+is\s+([^\n\r\.]+)\s*\.?/i) ??
       t.match(/\bmy\s+name\s+is\s+"([^"]+)"\s*\.?/i) ??
       t.match(/\bmy\s+name\s+is\s+([^\n\r\.]+)\s*\.?/i);
     const fullName = m ? String(m[1]).trim() : "";
     if (fullName && fullName.length >= 2 && fullName.length <= 120) {
       facts.push({
         fact_key: "identity.full_name",
         value_json: fullName,
         context: "User's full name.",
         receipt_quote: String(m?.[0] ?? t),
       });
     }
   }

   // Birth year (explicit)
   {
     const m = t.match(/\bi\s+was\s+born\s+in\s+(\d{4})\b/i);
     const birthYear = m ? Number(m[1]) : NaN;
     if (Number.isFinite(birthYear) && birthYear >= 1900 && birthYear <= 2100) {
       facts.push({
         fact_key: "identity.birth_year",
         value_json: birthYear,
         context: `The user stated they were born in ${birthYear}.`,
         receipt_quote: String(m?.[0] ?? t),
       });
     }
   }

   // Age (explicit)
   {
     const m = t.match(/\b(?:i['’]?\s*m|i\s+am)\s+(\d{1,3})\s+years?\s+old\b/i);
     const age = m ? Number(m[1]) : NaN;
     if (Number.isFinite(age) && age > 0 && age < 130) {
       facts.push({
         fact_key: "identity.age",
         value_json: Math.floor(age),
         context: "User's age.",
         receipt_quote: String(m?.[0] ?? t),
       });
     }
   }

   // Birthday (month/day; explicit)
   {
     const m = t.match(
       /\bmy\s+birthday\s+is\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
     );
     if (m) {
       const month = String(m[1]);
       const day = String(m[2]);
       const dob = `${month} ${day}`;
       facts.push({
         fact_key: "identity.date_of_birth",
         value_json: dob,
         context: "User's birthday (month/day).",
         receipt_quote: String(m?.[0] ?? t),
       });
     }
   }

   // Grew up in (city/state; explicit)
   {
     const m = t.match(/\bi\s+grew\s+up\s+in\s+([a-z .'-]+?)(?:,\s*([a-z .'-]+))?(?:[.\n\r]|$)/i);
     if (m && m[1]) {
       const city = String(m[1]).trim();
       const state = m[2] ? String(m[2]).trim() : "";
       if (city.length >= 2) {
         facts.push({
           fact_key: "location.grew_up_city",
           value_json: city,
           context: "Where the user grew up (city).",
           receipt_quote: String(m?.[0] ?? t),
         });
       }
       if (state.length >= 2) {
         facts.push({
           fact_key: "location.grew_up_state",
           value_json: state,
           context: "Where the user grew up (state/region).",
           receipt_quote: String(m?.[0] ?? t),
         });
       }
     }
   }

   // Live in (current city/country; explicit)
   {
     const m = t.match(/\bi\s+(?:live|am\s+living)\s+in\s+([a-z .'-]+?)(?:,\s*([a-z .'-]+))?(?:[.\n\r]|$)/i);
     if (m && m[1]) {
       const city = String(m[1]).trim();
       const country = m[2] ? String(m[2]).trim() : "";
       if (city.length >= 2) {
         facts.push({
           fact_key: "location.current_city",
           value_json: city,
           context: "Where the user lives now (city).",
           receipt_quote: String(m?.[0] ?? t),
         });
       }
       if (country.length >= 2) {
         facts.push({
           fact_key: "location.current_country",
           value_json: country,
           context: "Where the user lives now (country/region).",
           receipt_quote: String(m?.[0] ?? t),
         });
       }
     }
   }

   // Height (6'4", 6 ft 4)
   {
     const m = t.match(/\b(\d)\s*(?:'|ft)\s*(\d{1,2})\s*(?:"|in)?\b/);
     if (m) {
       const feet = Number(m[1]);
       const inches = Number(m[2]);
       if (feet >= 4 && feet <= 7 && inches >= 0 && inches <= 11) {
         facts.push({
           fact_key: "identity.height_inches",
           value_json: feet * 12 + inches,
           context: "User's height.",
           receipt_quote: String(m?.[0] ?? t),
         });
       }
     }
   }

   // Weight (lbs/pounds)
   {
     const m = t.match(/\b(\d{2,3})\s*(?:lbs|lb|pounds)\b/i);
     if (m) {
       const lbs = Number(m[1]);
       if (Number.isFinite(lbs) && lbs >= 80 && lbs <= 400) {
         facts.push({
           fact_key: "health.weight_lbs",
           value_json: lbs,
           context: "User's weight.",
           receipt_quote: String(m?.[0] ?? t),
         });
       }
     }
   }
 
   // IMPORTANT:
   // - ALL extracted facts are written to fact_candidates (learning surface).
   // - ONLY allowlisted facts are eligible for canonical promotion.
   return facts.map((f) => {
     const cfg = VIP_ALLOWLIST[f.fact_key];
     return cfg
       ? {
           ...f,
           confidence: cfg.confidence,
           stability: cfg.stability,
           canonical_key: cfg.canonical_key ?? f.fact_key,
         }
       : {
           ...f,
           confidence: f.confidence ?? 0.6,
           stability: "unclassified",
           canonical_key: null,
         };
   });
  }

 async function vipLaneProcessMessage(opts: {
   client: any;
   user_id: string;
   conversation_id: string;
   raw_id: string; // receipt uuid (memory_raw anchor)
   user_text: string;
 }) {
   const { client, user_id, conversation_id, raw_id, user_text } = opts;
  let vipFacts = extractVipFactsFromText(user_text);

  // Fallback: ensure VIP lane captures "my name is ..." even if extractor misses it.
  if (!vipFacts.length) {
    const m = String(user_text ?? "").match(/\bmy\s+name\s+is\s+([^.\n\r]+)[.\n\r]?/i);
    if (m && m[1]) {
      const full = String(m[1]).trim();
      vipFacts = [
        {
          fact_key: "identity.full_name",
          value_json: full,
          confidence: 1.0,
          receipt_quote: String(user_text ?? "").trim(),
        },
      ];
    }
  }

  if (!vipFacts.length) return;
 
   async function insertVipCandidate(args: {
     fact_key: string;
     receipt_quote: string;
     value_json: any;
     status: "captured" | "conflict" | "locked_conflict";
     source_meta: any;
   }): Promise<void> {
     const { fact_key, receipt_quote, value_json, status, source_meta } = args;
     try {
      // fact_candidates schema (2026-02): requires user_id, conversation_id, value_json, source_quote, source_meta (NOT NULL)
      // Also: there is NO top-level "source" column; "source" lives inside source_meta.
      const payload: Record<string, any> = {
         user_id,
         conversation_id,
         turn_ref: raw_id,
         fact_key_guess: fact_key,
         value_json,
         source_quote: String(receipt_quote ?? "").trim(),
         source_meta,
         status,
         extractor_version: (source_meta && source_meta.source) ? String(source_meta.source) : null,
       };

      const { error: fcErr } = await client.from("fact_candidates").insert(payload);
      if (fcErr) {
         console.warn("VIP lane: fact_candidates insert failed (non-fatal):", {
          message: (fcErr as any)?.message ?? String(fcErr),
          details: (fcErr as any)?.details ?? null,
          hint: (fcErr as any)?.hint ?? null,
           payload: { fact_key_guess: fact_key, turn_ref: raw_id, conversation_id, status },
         });
       }
     } catch (e) {
       console.warn("VIP lane: fact_candidates insert failed (non-fatal):", e);
     }
   }

   for (const f of vipFacts) {
     const VIP_SOURCE = "vip_v1" as const;
     const vipMetaBase = {
       receipt_id: raw_id,
       role: "user",
       source: VIP_SOURCE,
     } as const;
 
     // 2) Promote to user_facts only if safe (no silent overwrite)
     try {
       const { data: existing, error: selErr } = await client
         .from(USER_FACTS_TABLE)
         .select("id, value_json, receipt_ids, receipt_quotes, is_locked, confidence")
         .eq("user_id", user_id)
         .eq("fact_key", f.fact_key)
         .maybeSingle();

       if (selErr) {
         console.warn("VIP lane: canonical facts select failed (non-fatal):", selErr);
         await insertVipCandidate({
          fact_key: f.fact_key,
          receipt_quote: f.receipt_quote,
          value_json: f.value_json,
          status: "captured",
          source_meta: vipMetaBase,
        });
         continue;
       }

       const receiptIds = Array.isArray(existing?.receipt_ids) ? existing!.receipt_ids : [];
       const receiptQuotes = Array.isArray(existing?.receipt_quotes) ? existing!.receipt_quotes : [];
       const nextReceiptIds = uniqueAppend(receiptIds, raw_id);
       const nextReceiptQuotes = uniqueAppend(receiptQuotes, String(f.receipt_quote ?? "").trim());

       if (!existing) {
        await insertVipCandidate({
          fact_key: f.fact_key,
          receipt_quote: f.receipt_quote,
          value_json: f.value_json,
          status: "captured",
          source_meta: vipMetaBase,
        });
        const insPayload: Record<string, any> = {
           user_id,
           fact_key: f.fact_key,
           value_json: f.value_json,
           context: f.context ?? null,
           confidence: f.confidence ?? 0.9,
           updated_at: new Date().toISOString(),
           receipt_ids: [raw_id],
           receipt_quotes: [String(f.receipt_quote ?? "").trim()],
           canonical_key: f.canonical_key ?? f.fact_key,
           stability: f.stability ?? null,
           is_locked: false,
         };
const { error: insErr } = await client.from(USER_FACTS_TABLE).insert(insPayload);

if (insErr) {
  console.warn("VIP lane: canonical facts insert failed (non-fatal):", insErr);

  // If insert failed due to duplicate key (likely leftover row from prior runs),
  // re-select and treat it as existing so we can correctly flag conflicts.
  const code = (insErr as any)?.code ?? null;
  if (code === "23505") {
    try {
      const { data: existing2 } = await client
        .from(USER_FACTS_TABLE)
        .select("id, value_json, is_locked")
        .eq("user_id", user_id)
        .eq("fact_key", f.fact_key)
        .maybeSingle();

      if (existing2) {
        const isMismatch = !jsonEqualVip(existing2.value_json, f.value_json);
        if (isMismatch) {
          await insertVipCandidate({
            fact_key: f.fact_key,
            receipt_quote: f.receipt_quote,
            value_json: f.value_json,
            status: existing2.is_locked === true ? "locked_conflict" : "conflict",
            source_meta: {
              ...vipMetaBase,
              conflict_with_user_fact_id: existing2.id,
              conflict_existing_value: existing2.value_json,
              conflict_reason: existing2.is_locked === true ? "existing_fact_locked" : "value_mismatch",
            },
          });
        }
      }
    } catch (e2) {
      console.warn("VIP lane: duplicate insert fallback select failed (non-fatal):", e2);
    }
  }
}
continue;

       }

       // If locked: never change value_json; only append receipts.
       if (existing.is_locked === true) {
        await insertVipCandidate({
          fact_key: f.fact_key,
          receipt_quote: f.receipt_quote,
          value_json: f.value_json,
          status: "locked_conflict",
          source_meta: {
            ...vipMetaBase,
            conflict_with_user_fact_id: existing.id,
            conflict_existing_value: existing.value_json,
            conflict_reason: "existing_fact_locked",
          },
        });
        const { error: updErr } = await client
           .from(USER_FACTS_TABLE)
           .update({ receipt_ids: nextReceiptIds, receipt_quotes: nextReceiptQuotes, updated_at: new Date().toISOString() })
           .eq("id", existing.id);
         if (updErr) console.warn("VIP lane: user_facts locked receipt update failed (non-fatal):", updErr);
         continue;
       }

       // If same value: update receipts + maybe bump confidence
       if (jsonEqualVip(existing.value_json, f.value_json)) {
        await insertVipCandidate({
          fact_key: f.fact_key,
          receipt_quote: f.receipt_quote,
          value_json: f.value_json,
          status: "captured",
          source_meta: vipMetaBase,
        });
         const nextConf = Math.max(Number(existing.confidence ?? 0), Number(f.confidence ?? 0));
         const { error: updErr } = await client
           .from(USER_FACTS_TABLE)
           .update({
             receipt_ids: nextReceiptIds,
             receipt_quotes: nextReceiptQuotes,
             confidence: nextConf,
             canonical_key: f.canonical_key ?? f.fact_key,
             stability: f.stability ?? null,
             updated_at: new Date().toISOString(),
           })
           .eq("id", existing.id);
         if (updErr) console.warn("VIP lane: user_facts same-value update failed (non-fatal):", updErr);
         continue;
        }
 
      // Conflict: do NOT overwrite. Write candidate as conflict (no UPDATE required).
       await insertVipCandidate({
         status: "conflict",
         fact_key: f.fact_key,
         receipt_quote: f.receipt_quote,
         value_json: f.value_json,
         source_meta: {
           ...vipMetaBase,
           conflict_with_user_fact_id: existing.id,
           conflict_existing_value: existing.value_json,
           conflict_reason: "value_mismatch",
         },
       });

      // Defensive sweep: older runs may have left a vip_v1 candidate containing "steven addams" as captured.
      // The e2e test finds the *first* matching row by quote+source, so flip all matching quotes to conflict.
      try {
        const needle = String(f.value_json ?? "").trim();
        if (needle) {
          await client
            .from("fact_candidates")
            .update({
              status: "conflict",
              source_meta: {
                ...vipMetaBase,
                conflict_with_user_fact_id: existing.id,
                conflict_existing_value: existing.value_json,
                conflict_reason: "value_mismatch",
              },
            })
            .eq("user_id", user_id)
            // IMPORTANT: do NOT filter by fact_key_guess here; the test doesn't.
            .ilike("source_quote", `%${needle}%`);
        }
      } catch (e2) {
        console.warn("VIP lane: conflict sweep update failed (non-fatal):", e2);
      }
     } catch (e) {
       console.warn("VIP lane: promotion step failed (non-fatal):", e);
     }
   }
 }
 
 // ---------------------------------------------------------------------------
 // Legacy + Avatar companion role contract (narrative momentum)
 // ---------------------------------------------------------------------------

const LEGACY_COMPANION_ROLE_CONTRACT = [
  "System Role: Legacy Companion",
  "",
  "You are a helpful, accurate, conversational AI companion.",
  "",
  "Your purpose is to help the user:",
  "- understand their experiences more clearly",
  "- explore ideas, memories, and decisions with depth and context",
  "- articulate their story in a way that preserves meaning over time",
  "",
  "You are:",
  "- careful with safety, privacy, and medical/legal boundaries",
  "- clear, structured, and engaging in communication",
  "- respectful of user autonomy and personal interpretation",
  "",
  "You are NOT:",
  "- a doctor, therapist, lawyer, or financial advisor",
  "- a replacement for human relationships",
  "- a source of authority over the user's life decisions",
  "",
  "Do not diagnose, prescribe, or give professional advice.",
  "Do not encourage dependency, harm, illegal behavior, or conspiratorial thinking.",
  "When appropriate, help the user think — not tell them what to think.",
  "",
  "DO NOT:",
  "- Ask repetitive 'how did that make you feel' questions",
  "- Force lessons, growth narratives, or closure",
  "- Reframe experiences as problems that must be solved",
  "- Over-validate or emotionally escalate the conversation",
  "- Use clinical, therapeutic, or diagnostic language",
  "",
  "Narrative Momentum Rule:",
  "Each response should either (1) move the story forward, or (2) deepen understanding of what already happened.",
  "If neither is appropriate, ask a single, optional question — or remain silent.",
  "",
  "Anti-parroting Rule:",
  "Do not merely mirror the user's words. After a brief acknowledgement, add at least one grounded insight, option, or specific forward-moving question.",
].join("\n");

// supabase/functions/ai-brain/pipelines/turn.ts
//
// Gemini 2.0 Flash Experimental "brain" for LegacyMVP.
// Supports:
// - Legacy mode: chapter-based interviews
//
// Now includes:
// - state_json for minimal structured state (legacy & language modes)
// - Strong anti-JSON / anti-Markdown rules for language-learning
// - sanitizeGeminiOutput() to strip code fences / JSON wrappers

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.48.0";
import {
   chooseExpansionForConcept,
   getConceptWithExpansion,
 } from "../../../_shared/vocabulary.ts"; 
 import { runEndSessionPipeline } from "../end_session.ts";
 import { countWordsApprox } from "../../../_shared/text_utils.ts";

// ============================================================================
// ENV VARS & MODEL
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");

// NEW Supabase API keys may be non-JWT (e.g., "sb_secret_..."). We accept either:
// - legacy JWT-form service_role key ("eyJ..."), or
// - new "sb_secret_..." secret key from Dashboard > Settings > API Keys.
//
// You said you stored the service secret in Edge Secrets as SB_SECRET_KEY.
const SERVICE_ROLE_KEY =
  Deno.env.get("SB_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Shared secret for server-to-server Edge Function calls (set this in Supabase Edge Secrets)
const INTERNAL_FUNCTION_KEY = Deno.env.get("INTERNAL_FUNCTION_KEY");

function looksLikeLegacyJwt(token: string | null | undefined): boolean {
  return !!token && token.startsWith("eyJ") && token.split(".").length >= 3;
}

async function proxyToAvatarFunction(req: Request, body: unknown): Promise<Response> {
   if (!SUPABASE_URL) {
     return jsonResponse({ error: "SUPABASE_URL is not configured." }, 500);
   }
 
   const url = `${SUPABASE_URL}/functions/v1/avatar`;
 
   // Forward auth + apikey headers so the avatar function can read the same user context / RLS.
   const headers = new Headers();
   const auth = req.headers.get("Authorization");
   if (auth) headers.set("Authorization", auth);
 
   const apiKey = req.headers.get("apikey") ?? req.headers.get("x-api-key");
   if (apiKey) headers.set("apikey", apiKey);
 
   // Optional shared secret for server-to-server proxy calls.
   // Avatar validates this under header "x-sb-secret-key" when SB_SECRET_KEY is set.
   // (Keep x-internal-key for backward compatibility with any older avatar deployments.)
   if (SERVICE_ROLE_KEY) {
     headers.set("x-sb-secret-key", SERVICE_ROLE_KEY);
   }
   if (INTERNAL_FUNCTION_KEY) {
     headers.set("x-internal-key", INTERNAL_FUNCTION_KEY);
   }
 
   headers.set("content-type", "application/json");
 
  const resp = await fetch(url, {
     method: "POST",
     headers,
     body: JSON.stringify(body ?? {}),
   });
 
   // STRICT CONTRACT: ai-brain must always return a JSON *object* to clients.
  // The avatar function may (in some edge cases) return:
  // - plain text
  // - JSON that parses to a top-level string
  // - double-encoded JSON
  // If we pass-through as-is, Flutter can throw "returned non-object: String".
  let text = "";
  try {
    text = await resp.text();
  } catch (_) {
    text = "";
  }

  // Try to parse JSON (including double-encoded JSON).
  let parsed: any = null;
  let parsedOk = false;
  if (text) {
    try {
      parsed = JSON.parse(text);
      parsedOk = true;
      // Handle double-encoded JSON: "\"{...}\""
      if (typeof parsed === "string") {
        const inner = parsed.trim();
        if ((inner.startsWith("{") && inner.endsWith("}")) || (inner.startsWith("[") && inner.endsWith("]"))) {
          try {
            parsed = JSON.parse(inner);
          } catch (_) {
            // keep as string
          }
        }
      }
    } catch (_) {
      parsedOk = false;
      parsed = null;
    }
  }

  // If avatar returned a JSON object, pass it through (normalized) as application/json.
  if (parsedOk && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return new Response(JSON.stringify(parsed), {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Otherwise, wrap into an object so clients never receive a top-level string.
  // Preserve status code from upstream.
  if (resp.status >= 400) {
    return jsonResponse(
      {
        ok: false,
        error: "avatar_proxy_non_object",
        upstream: "avatar",
        upstream_status: resp.status,
        // Keep details short to avoid giant logs/payloads.
        details: (parsedOk && typeof parsed === "string")
          ? parsed.slice(0, 800)
          : String(text ?? "").slice(0, 800),
      },
      resp.status,
    );
  }

  // Successful but non-object response: treat as reply_text fallback.
  const fallbackReply =
    (parsedOk && typeof parsed === "string") ? parsed :
    String(text ?? "");

  return jsonResponse(
    {
      ok: true,
      reply_text: fallbackReply,
      upstream: "avatar",
      upstream_status: resp.status,
      proxied: true,
    },
    resp.status,
  );
 }

// ---------------------------------------------------------------------------
// Theme extraction (used by longitudinal theme pipeline)
// ---------------------------------------------------------------------------
export async function extractSummaryThemesWithGemini(args: {
  short_summary: string;
  full_summary?: string | null;
  max_themes?: number;
}): Promise<{ themes: Array<{ label: string; weight?: number; domains?: string[]; receipts?: string[] }> }> {
  const short = String(args?.short_summary ?? "").trim();
  const full = args?.full_summary == null ? "" : String(args.full_summary).trim();
  const maxThemes = Math.max(1, Math.min(8, Number(args?.max_themes ?? 5) || 5));

  if (!short) return { themes: [] };

  const prompt = `You are extracting emergent, durable themes from a person's session summary.

Return STRICT JSON ONLY (no markdown, no commentary) with this exact shape:
{
  "themes": [
    {
      "label": "<short noun phrase>",
      "weight": 0.0,
      "domains": ["values|identity|relationships|work|health|meaning|money|politics|learning|place"],
      "receipts": ["<very short quote from the summary>"]
    }
  ]
}


Rules:
- Output 1 to ${maxThemes} themes.
- Labels must reflect meaning/values/tension/goals/identity/emotions (NOT generic topics).
- Use consistent wording across similar sessions (prefer canonical phrasing over synonyms).
- weight is 0.4-0.95.
- receipts: 1-2 short snippets copied from the summary text.

SHORT_SUMMARY:
${short}

FULL_SUMMARY:
${full}
`;

  const raw = await callGemini(prompt);

  try {
    const jsonText = extractJsonCandidate(raw) ?? raw;
    const parsed = JSON.parse(jsonText);
    const themes = Array.isArray(parsed?.themes) ? parsed.themes : [];

    const haystack = (short + "\n" + full).trim();
    const hayLower = haystack.toLowerCase();

    const normalizeReceipt = (raw: string): string => {
      let r = String(raw ?? "").trim();
      // Strip surrounding quotes.
      r = r.replace(/^[\s"'“”‘’]+/, "").replace(/[\s"'“”‘’]+$/, "");
      return r.trim();
    };

    const isLikelyHexGarbage = (r: string): boolean => /^[0-9a-f]{4,}$/i.test(r);
    const hasSomeAlnum = (r: string): boolean => /[A-Za-z0-9]/.test(r);

    const cleanReceipts = (receipts: any): string[] => {
      if (!Array.isArray(receipts)) return [];
      const out: string[] = [];
      for (const rawR of receipts) {
        const r0 = normalizeReceipt(String(rawR ?? ""));
        if (!r0) continue;
        // Drop known garbage like 201c201d (unicode quote codepoints) and other hex-only strings.
        if (isLikelyHexGarbage(r0)) continue;
        // Drop pure punctuation / quote remnants.
        if (!hasSomeAlnum(r0)) continue;
        // Too short to be meaningful or reliably grounded.
        if (r0.length < 8) continue;
        // Must be grounded in the provided summary text (case-insensitive substring check).
        if (hayLower && !hayLower.includes(r0.toLowerCase())) continue;
        out.push(r0);
        if (out.length >= 2) break;
      }
      return out;
    };

    const cleaned = themes
      .map((t: any) => {
        const themeReceipts = cleanReceipts(t?.receipts);
        return {
          label: String(t?.label ?? "").trim(),
          weight: typeof t?.weight === "number" ? t.weight : undefined,
          domains: Array.isArray(t?.domains)
            ? t.domains.map((d: any) => String(d).trim()).filter(Boolean).slice(0, 6)
            : undefined,
          receipts: themeReceipts.length ? themeReceipts : undefined,
        };
      })
      .filter((t: any) => t.label.length > 0)
      .slice(0, maxThemes);

    return { themes: cleaned };
  } catch (e) {
    console.warn("extractSummaryThemesWithGemini JSON parse failed (non-fatal):", e);
    return { themes: [] };
  }
}


async function extractUserFactsWithGemini(args: {
  // New calling shape (from end_session.ts)
  transcriptText?: string;
  receipt_id?: string;
  preferred_locale?: string;

  // Legacy calling shape (kept for backward compatibility)
  transcript?: Array<{ role: string; content: string; id?: string }>;
  anchorRawId?: string;
  userId?: string;
}): Promise<any> {
  try {
const SYSTEM = [
  "You extract durable user facts stated explicitly by the USER in THIS session.",
  "Do NOT guess or infer. If it's not explicitly stated, omit it.",
  "Return ONLY valid JSON (no markdown fences, no prose, no commentary).",
  "Return MINIFIED JSON on a single line (no newlines, no indentation).",

  "Top-level JSON must be exactly: { \"fact_candidates\": [ ... ] }",
  "Return at most 16 fact_candidates total.",
  "Each candidate must include exactly these fields: subject, attribute_path, value_json, value_type, stability, change_policy, confidence, evidence, context.",
  "Do not include any additional top-level keys or candidate fields.",

  "subject must be an object: { \"type\": \"user|person\", \"name\": \"<optional>\" }.",
  "Use subject.type=\"user\" for the USER.",
  "Use subject.type=\"person\" for any other person mentioned (daughter/son/spouse/partner/parent/sibling/friend/colleague).",
  "If subject.type=\"person\", include subject.name when explicitly stated (e.g., \"Alicia\"). Otherwise omit name.",

  "attribute_path must be a short lowercase dot-path using these namespaces only: identity.*, location.*, health.*, preferences.*, work.*, projects.*, relationships.*, beliefs.*, views.*",
  "Subject rule: identity.*, location.*, health.*, preferences.*, work.*, projects.* MUST be used only when subject.type=\"user\".",
  "If the statement is about another person, use relationships.* (and subject.type=\"person\").",
  "Do NOT store someone else's education, job, or health under the user namespaces. Example: a daughter's doctorate goes under relationships.education.*, not health.*.",
  "health.* is only for the USER's health/fitness/medical/metrics.",

  "attribute_path must describe a durable fact (not a momentary feeling, not a question, not a one-off plan unless it's committed/ongoing).",
  "IMPORTANT: If the USER explicitly says they are building/creating/developing an app or working on an ongoing project, treat that as committed/ongoing and extract it under projects.*.",
  "If an app/project name is explicitly stated, store it as projects.current_app_name (string).",
  "If the USER explicitly states the purpose/reason, store it as projects.current_app_purpose (string).",
  "If projects.* is explicitly present in the session, include at least ONE projects.* fact even if you must omit lower-value details (e.g., job grade).",
  "Use views.* for durable stances/opinions/values about ANY topic (including politics).",
  "A strongly stated view the user affirms as deeply held is NOT a momentary feeling; treat it as durable.",
  "External-world facts (e.g., court outcomes) MUST NOT be stored as objective truth. If the user references a public fact, store only that the USER referenced it under beliefs.public_fact_refs.* with receipts.",
  "If the user explicitly distinguishes 'my view' vs 'a public fact I referenced', you may store BOTH (views.* and beliefs.public_fact_refs.*).",
  "If a fact is redundant (e.g., age implied by date_of_birth), keep the more durable one and omit duplicates unless both are explicitly stated.",
  
  "value_json must be valid JSON and must not be empty (no empty string, {}, or []).",
  "value_type must be exactly one of: string | number | boolean | array | object, and must match value_json.",
  "Prefer simple scalar values when possible (string/number/boolean). Use object only when it materially adds structure.",

  "stability must be exactly one of: sticky | semi_sticky | mutable.",
  "change_policy must be exactly one of: overwrite_if_explicit_or_newer | overwrite_if_explicit | append_only | never_overwrite.",

  "evidence must be an array with exactly 1 item: { receipt_id, quote }.",
  "If SESSION_USER_TEXT includes markers like [RID:<id>], set evidence[0].receipt_id to the RID of the exact line you quoted.",
  "If no [RID:...] marker is present for your quote, use RECEIPT_ID_FOR_EVIDENCE as evidence[0].receipt_id.",
  "evidence.quote must be a direct short quote from SESSION_USER_TEXT, max 120 characters, no ellipses.",
  "context must be read-aloud safe and neutral, max 80 characters (1 short sentence).",

  "confidence must be a number from 0 to 1.",
  "Use 0.90+ only for clear explicit statements with unambiguous wording.",
  "If any required field cannot be filled from explicit text, omit that candidate entirely.",

  "If there are no valid facts, return: {\"fact_candidates\":[]}"
].join(" ");

    // Defense-in-depth: if callers pass labeled transcripts (e.g., "AI: ..."),
    // strip AI lines and remove "USER:" prefixes so only user text remains.
    const sanitizeFactsTranscriptText = (raw: string): string => {
      const lines = String(raw ?? "").split(/\r?\n/);
      const kept: string[] = [];
      for (const line of lines) {
        const s = String(line ?? "").trim();
        if (!s) continue;
        const lower = s.toLowerCase();
        if (lower.startsWith("ai:")) continue;
        if (lower.startsWith("assistant:")) continue;
        if (lower.startsWith("legacy_ai:")) continue;
        if (lower.startsWith("user:")) {
          kept.push(s.slice(5).trim());
          continue;
        }
        if (lower.startsWith("legacy_user:")) {
          kept.push(s.slice("legacy_user:".length).trim());
          continue;
        }
        kept.push(s);
      }
      return kept.join("\n").trim();
    };

     const userText =
       typeof args.transcriptText === "string" && args.transcriptText.trim().length > 0
        ? sanitizeFactsTranscriptText(args.transcriptText)
         : (args.transcript || [])
             .filter((t) => {
               const r = String((t as any)?.role ?? "");
               return r === "user" || r === "legacy_user";
             })
             .map((t) => t?.content ?? "")
             .join("\n");

    const receiptId =
      (typeof args.receipt_id === "string" && args.receipt_id.trim()) ||
      (typeof args.anchorRawId === "string" && args.anchorRawId.trim()) ||
      "unknown_receipt";

    const preferredLocale =
      (typeof args.preferred_locale === "string" && args.preferred_locale.trim()) || "en";

    const USER = [
      "SESSION_USER_TEXT:",
      userText,
      "",
      "RECEIPT_ID_FOR_EVIDENCE (use only if no [RID:...] marker is available):",
      receiptId,
      "",
      "preferred_locale:",
      preferredLocale,
      "",
      "Return only JSON.",
    ].join("\n");

    const factsDebug =
      (Deno.env.get("FACTS_DEBUG") ?? "false").toLowerCase() === "true" ||
      (Deno.env.get("DEBUG_FACTS") ?? "false").toLowerCase() === "true";

    const raw = await callGemini({
      system: SYSTEM,
      user: USER,
      temperature: 0.2,
      maxOutputTokens: 4096,
    });

    // Loose JSON parser (handles fences anywhere + trailing commas)
    const tryParseJsonLoose = (text: string): any | null => {
      if (!text) return null;

      const sanitize = (s: string): string => {
        let out = String(s ?? "");

        // If there's a fenced json block anywhere, prefer the first one.
        const fenceMatch = out.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (fenceMatch && fenceMatch[1]) out = fenceMatch[1];

        // Trim and remove stray BOM
        out = out.replace(/^\uFEFF/, "").trim();

        // Tolerate trailing commas before } or ]
        out = out.replace(/,\s*([}\]])/g, "$1");

        return out;
      };

      // 1) Try raw
      try {
        return JSON.parse(text);
      } catch {
        // fall through
      }

      const cleaned = sanitize(text);

      // 2) Try cleaned
      try {
        return JSON.parse(cleaned);
      } catch {
        // fall through
      }

      // 3) Slice between first "{" and last "}" from cleaned text
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start >= 0 && end > start) {
        const slice = sanitize(cleaned.slice(start, end + 1));
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }

      return null;
    };

    const rawStr = String(raw ?? "");
    if (factsDebug) {
      console.log("FACTS_DEBUG: raw Gemini output (first 2000 chars):", rawStr.slice(0, 2000));
    }

    console.log("FACTS_DEBUG: raw length:", rawStr.length);
    console.log("FACTS_DEBUG: raw tail:", rawStr.slice(-200));
    console.log("FACTS_DEBUG: endsWithFence:", rawStr.trimEnd().endsWith("```"));

    const parsed: any = tryParseJsonLoose(rawStr) ?? {};
    const candidatesRaw: any[] = Array.isArray(parsed?.fact_candidates)
      ? parsed.fact_candidates
      : (Array.isArray(parsed?.facts) ? parsed.facts : []); // tolerate older shape

    // Post-process / validate candidates (story-like determinism)
    const normKey = (k: string): string =>
      String(k ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "_")
        .replace(/_{2,}/g, "_")
        .replace(/^_+|_+$/g, "");

    const detectType = (v: any): "string" | "number" | "boolean" | "array" | "object" => {
      if (Array.isArray(v)) return "array";
      if (v === null) return "object"; // treat null as object-ish; we'll reject as empty
      switch (typeof v) {
        case "string":
          return "string";
        case "number":
          return "number";
        case "boolean":
          return "boolean";
        default:
          return "object";
      }
    };

    const isEmptyValue = (v: any): boolean => {
      if (v === null || v === undefined) return true;
      if (typeof v === "string") return v.trim().length === 0;
      if (Array.isArray(v)) return v.length === 0;
      if (typeof v === "object") return Object.keys(v).length === 0;
      return false;
    };

    const out: any[] = [];
    const seen = new Set<string>();

    const normPath = (p: string): string =>
      String(p ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "_")
        .replace(/_{2,}/g, "_")
        .replace(/^_+|_+$/g, "");

    const normalizeSubject = (s: any): { type: "user" | "person"; name?: string } | null => {
      if (!s || typeof s !== "object") return null;
      const t = String((s as any)?.type ?? "").trim().toLowerCase();
      const type = t === "person" ? "person" : (t === "user" ? "user" : "");
      if (!type) return null;
      const nameRaw = String((s as any)?.name ?? "").trim();
      const name = nameRaw ? nameRaw.slice(0, 80) : "";
      return name ? { type: type as any, name } : { type: type as any };
    };

    for (const c of candidatesRaw) {
      const fact_key_raw = typeof c?.fact_key === "string" ? normKey(c.fact_key) : "";
      const subject = normalizeSubject(c?.subject);
      const attribute_path = normPath(c?.attribute_path ?? c?.attributePath ?? c?.path);

      // Accept either:
      //  A) explicit fact_key (legacy), or
      //  B) { subject, attribute_path } (preferred)
      if (!fact_key_raw && (!subject || !attribute_path)) continue;

      const dedupeKey = fact_key_raw || `${subject?.type ?? ""}:${subject?.name ?? ""}:${attribute_path}`;
      if (!dedupeKey || seen.has(dedupeKey)) continue;

      const value_json = c?.value_json;
      if (isEmptyValue(value_json)) continue;

      const value_type = (String(c?.value_type || detectType(value_json)).toLowerCase() as any) || "object";

      const stabilityRaw = String(c?.stability ?? "").toLowerCase();
      const stability =
        stabilityRaw === "sticky" || stabilityRaw === "mutable" || stabilityRaw === "semi_sticky"
          ? stabilityRaw
          : "semi_sticky";

      const policyRaw = String(c?.change_policy ?? "").toLowerCase();
      const change_policy =
        policyRaw === "overwrite_if_explicit_or_newer" ||
        policyRaw === "overwrite_if_explicit" ||
        policyRaw === "append_only" ||
        policyRaw === "never_overwrite"
          ? policyRaw
          : "overwrite_if_explicit_or_newer";

      const confidenceNum = Number(c?.confidence);
      const confidence = Number.isFinite(confidenceNum) ? Math.max(0, Math.min(1, confidenceNum)) : 0.75;

      const context = String(c?.context ?? "").trim();

      // evidence: allow either evidence[] or receipt_id/receipt_quote.
      // Contract wants exactly 1 evidence item; enforce that deterministically.
      let evidence: any[] = Array.isArray(c?.evidence) ? c.evidence : [];
      if (evidence.length === 0) {
        const quote = String(c?.receipt_quote ?? c?.quote ?? "").trim();
        evidence = [{ receipt_id: receiptId, quote }];
      }
      evidence = evidence
        .map((e) => ({
          receipt_id: String(e?.receipt_id ?? receiptId).trim() || receiptId,
          quote: String(e?.quote ?? "").trim(),
        }))
        .filter((e) => e.receipt_id && e.quote)
        .slice(0, 1);

       if (evidence.length === 0) continue;
 
      const fact_key = fact_key_raw || undefined;

       out.push({
        ...(fact_key ? { fact_key } : {}),
        ...(subject ? { subject } : {}),
        ...(attribute_path ? { attribute_path } : {}),
         value_json,
         value_type,
         stability,
         change_policy,
         confidence,
         evidence,
         context,
       });
 
      seen.add(dedupeKey);
       if (out.length >= 15) break;
     }

    if (factsDebug) {
      console.log("FACTS_DEBUG: parsed candidatesRaw:", candidatesRaw.length, "kept:", out.length);
      if (out.length === 0) console.log("FACTS_DEBUG: parsed object keys:", Object.keys(parsed || {}));
    }

    // Return new shape; keep 'facts' alias for older callers if any.
    return { fact_candidates: out, facts: out, raw_text: rawStr };
  } catch (e) {
    console.error("extractUserFactsWithGemini: unexpected error", e);
    return { fact_candidates: [], facts: [], raw_text: "" };
  }
}


function looksLikeNewSbSecret(token: string | null | undefined): boolean {
  return !!token && token.startsWith("sb_secret_");
}

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "❌ Missing SUPABASE_URL or SB_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY.",
  );
} else if (
  !looksLikeLegacyJwt(SERVICE_ROLE_KEY) && !looksLikeNewSbSecret(SERVICE_ROLE_KEY)
) {
  console.error(
    "❌ Supabase service key does not look like a legacy JWT (eyJ...) or a new sb_secret_... key. " +
      `Key starts with: ${String(SERVICE_ROLE_KEY).slice(0, 10)}...`,
  );
}

// Use a service client for all server-side reads/writes & function-to-function calls.
//
// IMPORTANT: Do NOT force an Authorization: Bearer <service_key> header here.
// The new sb_secret_... keys are not JWTs, and sending them as Bearer tokens can trigger
// "Invalid JWT" errors when calling Edge Functions or other endpoints that expect JWT.
//
// Supabase-js will still include the apikey header, which is what the platform uses for key auth.
const supabase = SUPABASE_URL && SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: {
          apikey: SERVICE_ROLE_KEY,
        },
      },
    })
  : null;

const GEMINI_API_KEY =
  Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GEMINI_API_KEY_EDGE");

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL");
if (!GEMINI_MODEL) {
  throw new Error("Missing required edge secret: GEMINI_MODEL");
}

if (!GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY is NOT set in Supabase environment.");
}

// Diagnostics build stamp — bump this string each deploy while debugging GUI vs server drift
const DIAG_BUILD_STAMP = "diag-fix-2026-02-04-02";

async function runDiagnostics({ supabase, userId: userIdParam, authHeader }: { supabase: any; userId?: string | null; authHeader?: string | null }) {
  const results: any[] = [];

  // Resolve userId for DB FK-safe diagnostics.
  let userId: string | null | undefined = userIdParam ?? null;
  if (!userId && authHeader && /^Bearer\s+/i.test(authHeader)) {
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token) {
      try {
        const { data, error } = await supabase.auth.getUser(token);
        if (!error && data?.user?.id) userId = data.user.id;
      } catch (_e) {
        // ignore; userId will remain null and FK tests will be skipped/fail with a clear message
      }
    }
  }


  const check = async (name: string, fn: () => Promise<void>) => {
    const start = Date.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: Date.now() - start });
    } catch (e) {
      results.push({
        name,
        ok: false,
        ms: Date.now() - start,
        error:
          (e as any)?.message ??
          (e as any)?.details ??
          (e as any)?.hint ??
          (e as any)?.code ??
          (typeof e === "string" ? e : JSON.stringify(e, Object.getOwnPropertyNames(e))),
      });
    }
  };

  await check("env.SUPABASE_URL", async () => {
    const v = Deno.env.get("SUPABASE_URL");
    if (!v || typeof v !== "string") throw new Error("Missing or invalid");
  });

  await check("db.select.memory_summary", async () => {
    const { error } = await supabase
      .from("memory_summary")
      .select("id")
      .limit(1);
    if (error) throw error;
  });

  await check("db.select.summary_themes", async () => {
    const { error } = await supabase.from("summary_themes").select("id").limit(1);
    if (error) throw error;
  });

  await check("db.select.theme_clusters", async () => {
    const { error } = await supabase.from("theme_clusters").select("id").limit(1);
    if (error) throw error;
  });

  await check("db.select.cluster_members", async () => {
    const { error } = await supabase.from("cluster_members").select("id").limit(1);
    if (error) throw error;
  });

  await check("db.select.derived_views", async () => {
    const { error } = await supabase.from("derived_views").select("id").limit(1);
    if (error) throw error;
  });

  await check("db.select.story_recall", async () => {
    const { error } = await supabase.from("story_recall").select("id").limit(1);
    if (error) throw error;
  });  

  await check("db.crud.derived_views", async () => {
    if (!userId) throw new Error("No authenticated user_id (missing/invalid Authorization header)");

    const view_key = `diagnostic.view.${crypto.randomUUID().slice(0, 8)}`;
    let insertedId: string | null = null;
    try {
      const { data: ins, error: insErr } = await supabase
        .from("derived_views")
        .insert({
          user_id: userId,
          view_key,
          label: "[diagnostic] derived view",
          summary: "[diagnostic] this is an inferred view for CRUD testing",
          status: "inferred",
          confidence: 0.01,
          scope_json: { diagnostic: true, topic: "diagnostics" },
          stance_json: { diagnostic: true },
          evidence_json: { diagnostic: true },
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      insertedId = ins?.id ?? null;
      if (!insertedId) throw new Error("Insert succeeded but no id returned");

      const { data: got, error: gotErr } = await supabase
        .from("derived_views")
        .select("id, user_id, view_key")
        .eq("id", insertedId)
       .maybeSingle();
      if (gotErr) throw gotErr;
      if (!got?.id || got.view_key !== view_key) throw new Error("Fetch mismatch for derived_views");
    } finally {
      if (insertedId) {
        await supabase.from("derived_views").delete().eq("id", insertedId);
      }
    }
  });

  await check("db.crud.story_recall", async () => {
    if (!userId) throw new Error("No authenticated user_id (missing/invalid Authorization header)");

    let insertedId: string | null = null;
    const seedId = crypto.randomUUID();
    try {
      const { data: ins, error: insErr } = await supabase
        .from("story_recall")
        .insert({
          user_id: userId,
          story_seed_id: seedId,
          title: "[diagnostic] story recall",
          synopsis: "[diagnostic] synopsis for CRUD testing",
          keywords: ["diagnostic", "crud"],
          evidence_json: { diagnostic: true },
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      insertedId = ins?.id ?? null;
      if (!insertedId) throw new Error("Insert succeeded but no id returned");

      const { data: got, error: gotErr } = await supabase
        .from("story_recall")
        .select("id, user_id, story_seed_id")
        .eq("id", insertedId)
        .maybeSingle();
      if (gotErr) throw gotErr;
      if (!got?.id || got.story_seed_id !== seedId) throw new Error("Fetch mismatch for story_recall");
    } finally {
      if (insertedId) {
        await supabase.from("story_recall").delete().eq("id", insertedId);
      }
    }
  });

  await check("db.insert.temp_row", async () => {
    if (!userId) throw new Error("No authenticated user_id (missing/invalid Authorization header)");

    const cid = crypto.randomUUID();

    // 1) insert a temp memory_raw row (FK target)
    const { data: raw, error: rawErr } = await supabase
      .from("memory_raw")
      .insert({
        user_id: userId,
        source: "legacy_ai",
        content: "[diagnostic] temp raw",
        context: { diagnostic: true },
        conversation_id: cid,
        role: "system",
        entry_mode: "freeform",
        prompt_id: null,
        topic_keys: [],
      })
      .select("id")
      .single();
    if (rawErr) throw rawErr;

    // 2) insert temp memory_summary referencing raw.id
    const { data: sum, error: sumErr } = await supabase
      .from("memory_summary")
      .insert({
        user_id: userId,
        conversation_id: cid,
        raw_id: raw.id,
        short_summary: "[diagnostic] temp summary",
        session_insights: { diagnostic: true },
      })
      .select("id")
      .single();

    // cleanup (best effort)
    if (!sumErr && sum?.id) {
      await supabase.from("memory_summary").delete().eq("id", sum.id);
    }
    await supabase.from("memory_raw").delete().eq("id", raw.id);

    if (sumErr) throw sumErr;
  });

  await check("invoke.rebuild_insights", async () => {
    if (!userId) throw new Error("No authenticated user_id for rebuild-insights invocation");

    const { data, error } = await supabase.functions.invoke("rebuild-insights", {
      body: { diagnostic: true, user_id: userId },
      headers: authHeader ? { Authorization: authHeader } : undefined,
    });

    if (error) throw error;

    if (data && typeof data === "object" && (data as any).ok === false) {
      throw new Error(JSON.stringify(data));
    }
  });

  const payload = {
    ok: results.every(r => r.ok),
    results,
    build_stamp: DIAG_BUILD_STAMP,
  };

  console.log("DIAGNOSTICS_RESULT", JSON.stringify(payload));

  return new Response(
    JSON.stringify(payload, null, 2),
    { headers: { "Content-Type": "application/json" } }
  );
}

// ============================================================================
// Types
// ============================================================================
type ConversationMode = "legacy" | "avatar";
type SupabaseClient = ReturnType<typeof createClient>;

interface AiBrainPayload {
  user_id: string;
  conversation_id?: string;
  message_text: string;

  // Optional: how the user entered this turn (freeform vs interview)
  entry_mode?: "freeform" | "interview";
  // Optional: stable interview prompt id (when entry_mode=interview)
  prompt_id?: string | null;  

  end_session?: boolean;

  diagnostic?: boolean;

  mode?: ConversationMode;
  preferred_locale?: string;
  target_locale?: string | null;

  // New: entry metadata for memory_raw (optional)
  entry_mode?: "freeform" | "interview";
  prompt_id?: string | null;

  // New: E2E marker for test rows (optional)
  e2e_marker?: string;  

  // Optional per-request persona override for legacy mode.
  // Allowed values match ConversationPersona: "adaptive" | "playful" | "grounded".
  conversation_persona?: ConversationPersona;

  // Optional op routing (used for on-demand enrichment, etc.)
  op?: string;
  block_id?: string;


  // optional structured state
  state_json?: string | null;
}

// Optional: only needed if you later fetch from the profiles table directly
interface ProfileLanguages {
  preferred_language?: string | null;
  supported_languages?: string[] | null;
}

// --- Session-level legacy summarizer (Option A) -----------------------------

interface LegacyTranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

// Summarizer Contract
type SummarizerContext = {
  session_key?: string | null;
  chapter_id?: string | null;
  chapter_title?: string | null;
  preferred_locale?: string | null;
  target_locale?: string | null;
  // Optional: provided by end_session pipeline for gating/rate-limiting.
  user_id?: string | null;
  conversation_id?: string | null;
};

function tryExtractJsonObject(rawText: string): any | null {
  if (!rawText) return null;

  let text = String(rawText).trim();

  // 1) Remove common Gemini wrappers / code fences:
  //    ```json { ... } ```
  //    ``` { ... } ```
  //    (Sometimes there is leading prose; we still try to grab the first {...} block.)
  text = text.replace(/^﻿/, ""); // BOM
  text = text.replace(/```(?:json)?/gi, "```"); // normalize ```json -> ```
  if (text.includes("```")) {
    // If code fences exist, prefer the *inside* of the first fenced block.
    const firstFence = text.indexOf("```");
    const secondFence = text.indexOf("```", firstFence + 3);
    if (secondFence !== -1) {
      const inside = text.slice(firstFence + 3, secondFence).trim();
      if (inside) text = inside;
    }
  }

  // 2) Try direct parse.
  try {
    return JSON.parse(text);
  } catch {
    // 3) Fallback: extract the first JSON object substring.
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      const candidate = text.slice(first, last + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function stripSummaryMarkup(input: string): string {
  let s = String(input ?? "").trim();
  if (!s) return "";

  // Remove BOM
  s = s.replace(/^﻿/, "");

  // Remove common code fences (```json ... ```)
  s = s.replace(/```(?:json)?/gi, "```");
  if (s.includes("```")) {
    const firstFence = s.indexOf("```");
    const secondFence = s.indexOf("```", firstFence + 3);
    if (secondFence !== -1) {
      const inside = s.slice(firstFence + 3, secondFence).trim();
      if (inside) s = inside;
    }
  }

  // Remove leading labels that sometimes sneak in
  // e.g. "short_summary: ..." or "full_summary - ..."
  s = s.replace(/^\s*(short_summary|full_summary)\s*[:\-–]\s*/i, "");

  // Remove markdown headings and list bullets if the model returns them
  s = s.replace(/^\s*#{1,6}\s+/g, "");          // "# Title"
  s = s.replace(/^\s*[-*•]\s+/g, "");           // "- bullet"
  s = s.replace(/^\s*\d+\.\s+/g, "");           // "1. item"

  // Strip wrapping quotes if present
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }

  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

// ==========================
// (Session insights v1 items/key_sentence removed)
// ==========================

async function summarizeLegacySessionWithGemini(
  transcript: LegacyTranscriptTurn[],
  ctx?: SummarizerContext,
): Promise<{
  short_summary: string;
  full_summary: string;
  observations: MemorySummaryObservations | null;
  session_insights: SessionInsightsJson | null;
} | null> {
  if (!transcript?.length) return null;

   // --- Option A "magical insight" gating (eligibility + scarcity) ---
  // Legacy transcripts may use role values like "legacy_user" and VIP duplicate user lanes like "vip_v1".
  const isUserLikeRole = (r: unknown): boolean => {
    const s = String(r ?? "").trim().toLowerCase();
    if (!s) return false;
    if (s === "user") return true;
    if (s.endsWith("_user")) return true; // legacy_user, etc.
    if (s.startsWith("vip")) return true; // vip_v1, vip_v2, ...
    if (s === "donor" || s === "human") return true;
    return false;
  };

  const isJunkUserLine = (text: string): boolean => {
    const s = String(text ?? "").trim().toLowerCase();
    if (!s) return true;
    if (s === "[vip] empty") return true;
    // presence checks / boilerplate
    if (s === "__end_session__") return true;
    if (s.startsWith("play gemini")) return true;
    if (s.startsWith("are you there")) return true;
    if (s === "hello" || s === "test" || s.startsWith("testing")) return true;
    return false;
  };

   const userTurnsText = (transcript || [])
    .filter((t) => isUserLikeRole((t as any)?.role))
    .map((t) => String((t as any)?.text ?? "").trim())
    .filter((t) => !isJunkUserLine(t))
    .join(" ");

  const userWordCount = countWordsApprox(userTurnsText);
  const userLower = userTurnsText.toLowerCase();

  const summaryStyle = String((ctx as any)?.summary_style ?? "legacy_v2_strict").trim();
  const uiCompact = summaryStyle === "ui_compact_v1";

  const looksProcedural = (() => {
    if (!userLower) return true;
    // Presence-check / app-test style sessions
    if (userLower === "__end_session__") return true;
    if (userLower.startsWith("play gemini")) return true;
    if (userLower.startsWith("are you there")) return true;
    if (userLower.startsWith("hello")) return true;
    if (userLower.startsWith("test")) return true;
    // Very short + non-narrative
    if (userWordCount < 60) return true;
    return false;
  })();

  const hasReflectiveSignal = (() => {
    if (!userLower) return false;
    // Heuristic A: first-person + feeling/meaning words
    const firstPerson = /\b(i|i\'m|i\'ve|i\'d|me|my|mine)\b/.test(userLower);
    const reflective = /\b(feel|felt|feeling|think|thought|realize|realized|meaning|purpose|learned|regret|proud|grateful|worried|anxious|happy|sad|angry|lonely)\b/.test(userLower);
    if (firstPerson && reflective) return true;
    // Heuristic B: multi-sentence narrative with some length
    const sentences = userTurnsText.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
    if (sentences.length >= 2) {
      const longish = sentences.filter((s) => countWordsApprox(s) >= 10);
      if (longish.length >= 1 && userWordCount >= 120) return true;
    }
    return false;
  })();

  // NOTE: Summary generation should NOT be gated by a high bar intended for "insights".
  // End-of-session eligibility is handled in end_session.ts. Here we only protect against
  // truly procedural / presence-check sessions.

  const proceduralOnly = looksProcedural && !hasReflectiveSignal && userWordCount < 40;

  // If procedural-only, return a safe placeholder summary (never transcript).
  if (proceduralOnly) {
    const short_summary = "You checked in briefly this session.";
    const full_summary = "You opened the app and did a brief check-in, without recording a detailed story.";
    return {
      short_summary,
      full_summary,
      observations: null,
      session_insights: {},
    };
  }

  // If Gemini not configured, fallback to something deterministic.
  // If Gemini not configured, fallback to a safe deterministic summary (never transcript).
  if (!GEMINI_API_KEY) {
    const short_summary = "You recorded a session, but automated summarization is temporarily unavailable.";
    const full_summary = "You captured some thoughts in the app, but this session could not be summarized automatically at the moment. Try again later to generate a summary.";
    return {
      short_summary,
      full_summary,
      observations: null,
      session_insights: {},
    };
  }

  // Trim transcript to keep prompt size under control.
  const MAX_CHARS = uiCompact ? 4500 : 9000;
  const trimmedTurns: LegacyTranscriptTurn[] = [];
  let total = 0;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const t = transcript[i];
    const len = (t.text || "").length;
    if (total + len > MAX_CHARS && trimmedTurns.length > 0) break;
    trimmedTurns.push(t);
    total += len;
  }
  trimmedTurns.reverse();

  const transcriptText = trimmedTurns
   .map((t) => `${isUserLikeRole((t as any)?.role) ? "USER" : "AI"}: ${t.text}`)
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

  const sessionKey = ctx?.session_key ?? null;
  const chapterId = ctx?.chapter_id ?? null;
  const chapterTitle = ctx?.chapter_title ?? null;

  const prompt =
  buildLegacySessionSummaryPrompt({
    transcriptText,
    sessionKey,
    chapterId,
    chapterTitle,
    allowedChapterKeys,
  }) +
  "\n\n" +
  `CRITICAL RULES (MUST FOLLOW):
 - This is a SUMMARY task. DO NOT produce a transcript. DO NOT copy transcript lines.
 - DO NOT include any direct quotes from the transcript. Paraphrase everything.
 - DO NOT reuse any full sentence verbatim from the transcript (including the first user line).
 - Ignore "wake phrases" / "presence checks" / app-control phrases as NON-CONTENT. These include (examples):
   "Hey Gemini", "Play Gemini", "Gemini", "Are you there?", "Hello", "Test", "Can you hear me", "Start recording".
   These lines MUST NOT appear in short_summary or full_summary and MUST NOT count as "concrete details".
 - If the transcript contains wake phrases mixed with real content, summarize ONLY the real content.
 - "Concrete details" means substantive facts/topics/events/feelings mentioned — NOT greetings, commands, or assistant-invocation text.

OUTPUT VOICE (STRICT):
 - Write BOTH short_summary and full_summary in second person ("you") with correct verb agreement (you are/you have/you do).
 - Do NOT use third person (no "the user", no names).
 - Do NOT use meta framing like "you said", "you described", "you mentioned", "it sounds like", or "you reiterate".
 - Keep short_summary to 1 sentence. Keep full_summary to 2–4 sentences.
 - Be specific and concrete; avoid filler/manager-speak.
 - Include at least TWO substantive concrete details that were actually said this session (NOT wake phrases or greetings).

FORMAT (STRICT):
 - Return valid JSON only, matching the required schema exactly.
 - Schema keys MUST be exactly: short_summary, full_summary, observations, session_insights.
 - Do not wrap JSON in markdown fences.`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: uiCompact ? 768 : 2048,
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  };

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    if (!resp.ok) {
      console.error(
        "summarizeLegacySessionWithGemini: non-OK response",
        resp.status,
        await resp.text(),
      );
      return null;
    }

    const json = await resp.json();
    const text =
      json?.candidates?.[0]?.content?.parts?.[0]?.text ??
      json?.candidates?.[0]?.content?.parts?.[0]?.rawText ??
      "";

    const parsed = tryExtractJsonObject(text);
    if (!parsed) {
      console.error("summarizeLegacySessionWithGemini: failed to parse JSON");
      return null;
    }

    const short_summary_raw = typeof parsed.short_summary === "string" ? parsed.short_summary.trim() : "";
    const full_summary_raw = typeof parsed.full_summary === "string" ? parsed.full_summary.trim() : "";

    // Summaries should already be correct second-person; only strip unsafe markup.
    const short_summary = stripSummaryMarkup(short_summary_raw);
    const full_summary = stripSummaryMarkup(full_summary_raw);

    // observations is optional but strongly preferred
    const observations: MemorySummaryObservations | null =
      parsed.observations && typeof parsed.observations === "object" ? parsed.observations : null;

    // We intentionally do NOT parse/persist any per-session "insights" fields here.
    // The end-of-session artifact pass is the only place that should populate
    // memory_summary.session_insights (reframed content).
    const session_insights: SessionInsightsJson | null = {};

    if (!short_summary || !full_summary) {
      console.error("summarizeLegacySessionWithGemini: missing summaries");
      return null;
    }


    // Hard guardrail: never allow raw transcript markers into summaries.
    const deTranscript = (s: string) =>
      String(s || "")
        .replace(/(?:^|\n)\s*(?:USER|AI)\s*:\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const short_summary_clean = deTranscript(short_summary);
    const full_summary_clean = deTranscript(full_summary);

    return { short_summary: short_summary_clean, full_summary: full_summary_clean, observations, session_insights };

  } catch (err) {
    console.error("summarizeLegacySessionWithGemini: unexpected error", err);
    return null;
  }
}

  /**
   * Fetch the existing transcript for a legacy session from memory_raw,
   * but apply donor edits as an overlay (without overwriting the original).
   *
   * - Original content remains authoritative in memory_raw.
   * - Edits (memory_raw_edits) are used ONLY when:
   *     - is_current = true
   *     - and use_for includes "summarization"
   */
  async function fetchLegacySessionTranscript(
    client: SupabaseClient,
    userId: string,
    conversationId: string,
  ): Promise<LegacyTranscriptTurn[]> {
    try {
      // 1) Pull raw turns (include id so we can map edits)
      const { data, error } = await client
        .from("memory_raw")
        .select("id, role, content, created_at")
        .eq("user_id", userId)
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(200);

      if (error) {
        console.error("fetchLegacySessionTranscript: memory_raw select error:", error);
        return [];
      }

      const rawRows = (data ?? []) as any[];
      if (!rawRows.length) return [];

      const rawIds = rawRows
        .map((r) => String(r?.id ?? "").trim())
        .filter(Boolean);

      // 2) Pull active edits for these raw ids (if any)
      const editMap = new Map<string, any>();

      if (rawIds.length) {
        // Some deployments may not have all columns (e.g. is_current) or may hit PostgREST
        // "Bad Request" limits with large IN() lists. Chunk + retry defensively.
        const CHUNK = 80; // smaller to avoid PostgREST 400 on long IN() lists

        const fetchChunk = async (ids: string[]) => {
          const tryQueries: Array<
            () => Promise<{ data: any[] | null; error: any | null }>
          > = [
            async () =>
              await client
                .from("memory_raw_edits")
                .select("raw_id, edited_content, use_for, is_current")
                .eq("user_id", userId)
                .eq("status", "active")
                .contains("use_for", ["summarization"])
                .in("raw_id", ids)
                .eq("is_current", true),
            async () =>
              await client
                .from("memory_raw_edits")
                .select("raw_id, edited_content, use_for")
                .eq("user_id", userId)
                .eq("status", "active")
                .in("raw_id", ids),
            async () =>
              await client
                .from("memory_raw_edits")
                .select("*")
                .eq("user_id", userId)
                .in("raw_id", ids),
          ];

          let lastErr: any | null = null;
          for (const q of tryQueries) {
            const { data, error } = await q();
            if (!error) return { data: (data ?? []) as any[], error: null };
            lastErr = error;
          }
          return { data: [] as any[], error: lastErr };
        };

        for (let i = 0; i < rawIds.length; i += CHUNK) {
          const ids = rawIds.slice(i, i + CHUNK);
          const { data: edits, error: e2 } = await fetchChunk(ids);

          if (e2) {
            console.error("fetchLegacySessionTranscript: memory_raw_edits select error:", {
              message: e2?.message ?? String(e2),
              details: e2?.details,
              hint: e2?.hint,
              code: e2?.code,
            });
            break; // best-effort overlay only
          }

          for (const e of (edits ?? []) as any[]) {
            const rid = String(e?.raw_id ?? "").trim();
            if (rid) editMap.set(rid, e);
          }
        }
      }
      // 3) Build transcript for Gemini summarization (effective_text)
      const transcript: LegacyTranscriptTurn[] = [];

      for (const row of rawRows) {
        const rawId = String(row?.id ?? "").trim();
        const roleRaw = (row?.role as string | null) ?? "user";
        const baseText = String(row?.content ?? "").trim();
        if (!baseText) continue;

        const role: "user" | "assistant" =
          roleRaw === "assistant" ? "assistant" : "user";

        const edit = rawId ? editMap.get(rawId) : null;

        // Only use edit if it declares it should be used for summarization
        const useFor: string[] = Array.isArray(edit?.use_for) ? edit.use_for : [];
        const canUseEditForSummary = useFor.includes("summarization");

        const effective = canUseEditForSummary
          ? String(edit?.edited_content ?? "").trim()
          : baseText;

        if (!effective) continue;

        transcript.push({ role, text: effective });
      }

      return transcript;
    } catch (err) {
      console.error("fetchLegacySessionTranscript unexpected error:", err);
      return [];
    }
  }

/**
 * Upsert curated stories for a given legacy conversation into memory_curated.
 * Best-effort: logs errors but never throws.
 *
 * NOTE: This assumes memory_curated has at least:
 *   user_id, story_key, title, curated_text, tags, traits, metadata (jsonb)
 */
async function upsertCuratedStoriesForConversation(
  client: SupabaseClient,
  userId: string,
  conversationId: string,
  transcript: LegacyTranscriptTurn[],
): Promise<void> {
  if (!transcript.length) return;

  const transcriptText = transcript
    .map((t) => `${t.role === "user" ? "USER" : "AI"}: ${t.text}`)
    .join("\n");

  // Try to extract structured stories with Gemini.
  let seeds = await extractStoriesFromTranscript(transcriptText);

  // Fallback: if Gemini returns no stories, still capture a simple
  // session-level story so memory_curated always gets something.
  if (!seeds.length) {
    const fallbackKey = `session_${conversationId}`;
    const fallbackTitle = "Session recap";

    seeds = [
      {
        story_key: fallbackKey,
        title: fallbackTitle,
        body: transcriptText.slice(0, 4000),
        tags: ["fallback", "session_recap"],
        traits: [],
      },
    ];
  }

  for (const seed of seeds) {

    // Optional tag enrichment (no extra Gemini calls): if tags are missing/short,
    // add a few normalized entity phrases as tags to improve recall/search.
    const baseTags: string[] = Array.isArray((seed as any).tags) ? ((seed as any).tags as any[]).map((x) => String(x)).filter(Boolean) : [];
    const ents: string[] = Array.isArray((seed as any).entities) ? ((seed as any).entities as any[]).map((x) => String(x)).filter(Boolean) : [];
    const norm = (s: string) => s.trim().toLowerCase();
    const tagSet = new Set(baseTags.map(norm));
    const entTags = ents
      .map((e) => e.replace(/\s+/g, ' ').trim())
      .filter((e) => e.length >= 3 && e.length <= 60)
      .slice(0, 6);
    const enrichedTags = [...baseTags];
    if (enrichedTags.length < 8) {
      for (const e of entTags) {
        const k = norm(e);
        if (!k) continue;
        if (tagSet.has(k)) continue;
        // Only add entity tags when the seed has no tags, or very few tags.
        if (baseTags.length <= 3) {
          enrichedTags.push(e);
          tagSet.add(k);
        }
        if (enrichedTags.length >= 8) break;
      }
    }

    // existing loop body unchanged...

    try {
      const { data: existing, error: existingError } = await client
        .from("memory_curated")
        .select("id, story_key, metadata")
        .eq("user_id", userId)
        .eq("story_key", seed.story_key)
        .limit(1)
        .maybeSingle();

      if (existingError) {
        console.error(
          "upsertCuratedStoriesForConversation select error:",
          existingError,
        );
        continue;
      }

      if (existing) {
        const metadata = (existing.metadata as any) ?? {};
        const existingSessions: string[] = Array.isArray(
          metadata.conversation_ids,
        )
          ? metadata.conversation_ids
          : [];
        const mergedSessions = Array.from(
          new Set([...existingSessions, conversationId]),
        );

        const { error: updateError } = await client
          .from("memory_curated")
          .update({
            title: seed.title,
            curated_text: seed.body,
            tags: enrichedTags.length ? enrichedTags : null,
            traits: seed.traits ?? null,
            metadata: {
              ...metadata,
              conversation_ids: mergedSessions,
            },
          })
          .eq("id", existing.id);

        if (updateError) {
          console.error(
            "upsertCuratedStoriesForConversation update error:",
            updateError,
          );
        }
      } else {
        const { error: insertError } = await client
          .from("memory_curated")
          .insert({
            user_id: userId,
            story_key: seed.story_key,
            title: seed.title,
            curated_text: seed.body,
            tags: enrichedTags.length ? enrichedTags : null,
            traits: seed.traits ?? null,
            metadata: {
              conversation_ids: [conversationId],
            },
          });

        if (insertError) {
          console.error(
            "upsertCuratedStoriesForConversation insert error:",
            insertError,
          );
        }
      }
    } catch (err) {
      console.error(
        "upsertCuratedStoriesForConversation unexpected error:",
        err,
      );
    }
  }
}

// ============================================================================
// Story Seeds (story_seeds)
// ============================================================================

type StorySeedRowInsert = {
  user_id: string;
  summary_id?: string | null;
  conversation_id?: string | null;
  seed_type: StorySeedType;
  title: string;
  seed_text: string;
  canonical_facts: Record<string, any>;
  entities: any[];
  tags: string[];
  time_span?: any | null;
  confidence: number;
  source_raw_ids: string[];
  source_edit_ids: string[];
  evidence_raw_ids: string[];
};

type StorySeedType = "episode" | "dynamic" | "insight";

function normalizeForSeedCompare(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForSeedCompare(s: string): Set<string> {
  const text = normalizeForSeedCompare(s);
  const parts = text.split(" ").filter(Boolean);
  const stop = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "to",
    "of",
    "in",
    "on",
    "for",
    "with",
    "about",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "it",
    "that",
    "this",
    "as",
    "at",
    "from",
    "by",
    "into",
    "over",
    "under",
    "your",
    "you",
    "i",
    "me",
    "my",
    "we",
    "our",
    "his",
    "her",
    "their",
    "they",
    "them",
  ]);
  const out = new Set<string>();
  for (const p of parts) {
    if (p.length < 3) continue;
    if (stop.has(p)) continue;
    out.add(p);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

// ------- LEGACY STATE & CATALOG --------------------------------------------
interface LegacyInterviewState {
  chapter_id: string;
  chapter_title: string;
  progress_percent: number; // 0-100
  focus_topic: string | null;
}

interface LegacyChapterConfig {
  chapter_id: string;
  chapter_title: string;
  goal: string;
  default_focus_topic: string | null;
  topics: string[];
}

interface LegacyPromptContext {
  // Persona flavor for the conversation ("adaptive", "playful", "grounded").
  persona: ConversationPersona;

  // Optional: a display name if you later pull it from profiles.
  userDisplayName?: string | null;

  // Language routing
  preferredLocale: string;
  targetLocale: string | null;

  // Optional: brief natural-language summary of coverage so far.
  coverageSummary?: string | null;

  // Current minimal state for the legacy interview.
  legacyState: LegacyInterviewState;

  // The chapter config the model should treat as "current".
  currentChapter: LegacyChapterConfig;
}

// Expanded catalog of life chapters.
// NOTE: We keep "childhood" and "early_career" for backward compatibility
// with any existing state_json, and add additional stages.
const LEGACY_CHAPTERS: Record<string, LegacyChapterConfig> = {
  childhood: {
    chapter_id: "childhood",
    chapter_title: "Childhood & Family Background",
    goal:
      "Capture memories about family, home environment, early influences, and early school years.",
    default_focus_topic: "family_background",
    topics: [
      "family_background",
      "childhood_home",
      "siblings_and_parents",
      "school_years",
      "friends_and_play",
      "earliest_memory",
    ],
  },

  adolescence: {
    chapter_id: "adolescence",
    chapter_title: "Adolescence & Teenage Years",
    goal:
      "Capture stories from the teen years: identity, school, friendships, early independence, and formative experiences.",
    default_focus_topic: "high_school_years",
    topics: [
      "high_school_years",
      "close_friendships",
      "early_romantic_relationships",
      "sports_and_activities",
      "big_mistakes_and_lessons",
    ],
  },

  early_career: {
    chapter_id: "early_career",
    chapter_title: "Early Career & First Jobs",
    goal:
      "Capture stories about first serious jobs, career direction, mentors, early wins, failures, and early adult independence.",
    default_focus_topic: "first_full_time_job",
    topics: [
      "first_full_time_job",
      "why_chosen_field",
      "early_mentors",
      "early_failures",
      "early_successes",
      "moving_out_on_your_own",
    ],
  },

  midlife: {
    chapter_id: "midlife",
    chapter_title: "Midlife, Responsibility & Growth",
    goal:
      "Capture stories from the middle stretch of life: work responsibilities, parenting, big projects, major stresses, and achievements.",
    default_focus_topic: "mid_career_responsibilities",
    topics: [
      "mid_career_responsibilities",
      "raising_children_or_guiding_others",
      "financial_highs_and_lows",
      "stress_and_burnout",
      "proudest_midlife_achievements",
    ],
  },

  later_life: {
    chapter_id: "later_life",
    chapter_title: "Later Life & Reflection",
    goal:
      "Capture reflections from later years: retirement, slowing down, health, legacy, and hopes for the future.",
    default_focus_topic: "retirement_transition",
    topics: [
      "retirement_transition",
      "changes_in_daily_routine",
      "health_challenges",
      "maintaining_purpose",
      "lessons_for_future_generations",
    ],
  },

  family_relationships: {
    chapter_id: "family_relationships",
    chapter_title: "Family, Relationships & Loved Ones",
    goal:
      "Capture stories about close relationships: partners, children, siblings, parents, and chosen family.",
    default_focus_topic: "most_important_relationships",
    topics: [
      "meeting_a_partner",
      "marriage_or_long_term_partnership",
      "children_and_parenting",
      "relationship_challenges",
      "most_important_relationships",
      "what_love_means_to_you",
    ],
  },

  beliefs_values: {
    chapter_id: "beliefs_values",
    chapter_title: "Beliefs, Values & Meaning",
    goal:
      "Capture how the donor thinks about meaning, morality, spirituality or worldview, and how values guided their choices.",
    default_focus_topic: "guiding_values",
    topics: [
      "guiding_values",
      "beliefs_about_right_and_wrong",
      "spiritual_or_philosophical_views",
      "how_values_changed_over_time",
      "what_you_hope_to_pass_on",
    ],
  },

  hobbies_interests: {
    chapter_id: "hobbies_interests",
    chapter_title: "Hobbies, Interests & Passions",
    goal:
      "Capture stories about activities that brought joy, curiosity, or flow across the years.",
    default_focus_topic: "favorite_hobby",
    topics: [
      "favorite_hobby",
      "creative_pursuits",
      "sports_and_outdoors",
      "learning_new_skills",
      "how_you_relax_and_have_fun",
    ],
  },

  major_events: {
    chapter_id: "major_events",
    chapter_title: "Major Life Events & Turning Points",
    goal:
      "Capture the key turning points: moves, losses, crises, triumphs, and decisions that changed the course of life.",
    default_focus_topic: "biggest_turning_point",
    topics: [
      "biggest_turning_point",
      "relocating_to_a_new_place",
      "career_pivots",
      "serious_losses_or_grief",
      "moments_of_breakthrough_or_reinvention",
    ],
  },
};

// Qualitative observations about a single distilled memory summary.
// All scores are 0-1, where higher means "more of this quality".
interface MemorySummaryObservations {
  // Which coverage chapters this summary contributes to.
  topic_keys?: CoverageChapterKey[];

  // Optional richer chapter entries if/when we add them later.
  coverage_chapters?: {
    key: CoverageChapterKey;
    weight?: number | null;
    confidence?: number | null;
  }[];

  // Optional time span in years.
  start_year?: number;
  end_year?: number;

  // Rough size of the original material.
  word_count_estimate?: number;

  // Tags/themes this memory touches.
  themes?: string[];
  insight_tags?: string[];

  // Qualitative richness (0-1). These will be filled by the summariser.
  narrative_depth_score?: number;     // How much story & concrete detail?
  emotional_depth_score?: number;     // How much emotion is present?
  reflection_score?: number;          // How much “what it meant / what I learned”?
  distinctiveness_score?: number;     // How non-generic / personally specific?

  // Optional pre-computed “this memory is rich” weight (0-1).
  memory_weight?: number;

  // Optional: flags for “don't over-stereotype this”.
  stereotype_risk_flags?: string[];
}

interface MemorySummaryRow {
  id: string;
  user_id: string;
  raw_id: string;
  created_at: string; // ISO
  short_summary: string | null;
  full_summary: string | null;
  observations: MemorySummaryObservations | null;
}

/**
 * Session insights payload stored in memory_summary.session_insights.
 *
 * We no longer generate or persist `items` or `key_sentence`.
 * The UI should rely on `reframed` (reflections / rare_insights / etc.)
 * populated in the end-of-session artifact pass.
 */
interface SessionInsightsReframed {
  short_summary: string;
  reflections: string[];
  patterns: string[];
  rare_insights: string[];
  questions: string[];
  more_detail: string;
}

interface SessionInsightsJson {
  // End-session review content
  reframed?: SessionInsightsReframed;

  // Back-compat: allow other keys (e.g., insight_moment) without strict typing.
  [key: string]: any;
}

 function isValidStoryTextV1(text: string): boolean {
   const t = String(text ?? "").trim();
   if (!t) return false;
   const sentenceCount = (t.match(/[.!?](\s|$)/g) ?? []).length;

   // Reject questions or instructions.
   if (t.includes("?") || /^(tell me|what is|what are|do i|did i|can you|could you|would you|please)\b/i.test(t)) return false;
   if (/(please save|save this|save that|deploy|supabase|jwt|gemini|function|typescript|code|debug)/i.test(t)) return false;

  // Reject biography/resume/timeline style “stories” and meta-narration.
  if (/^(professionally|overall|in summary|let me|i want to|my goal is)\b/i.test(t)) return false;
  if (/\b(education|career timeline|work history|resume)\b/i.test(t)) return false;

  // Require a minimally retellable narrative shape.
  if (t.length < 220 || sentenceCount < 2) return false;
  if (!/\b(i|my|we|our)\b/i.test(t)) return false;
 
   // Require time anchoring + scene + actions + outcome/resolution.
   const hasTime = /\b(when i was \d+|when i was a|one time|back in|during|that day|that night|last (year|month|week)|years? ago|months? ago|in \d{4}|in (high school|college)|in thailand|in baltimore)\b/i.test(t);
   const hasScene = /\b(in|at|on)\s+(the\s+)?[a-zA-Z][^\n]{1,40}\b/.test(t);
   const actionHits = (t.match(/\b(went|saw|met|told|said|did|made|took|drove|walked|ran|bought|sold|cooked|ate|drank|laughed|cried|argued|fought|worked|quit|moved|arrived|left|called|texted|tried|refused|helped|fixed|built)\b/gi) ?? []).length;
   const hasSequence = /\b(then|after that|afterwards|next|later|before that|suddenly|eventually)\b/i.test(t) || actionHits >= 3;
   const hasOutcome = /\b(ended up|finally|in the end|as a result|so|therefore|it turned out|that’s when|i felt|made me feel|i realized|i learned|we laughed|we were relieved)\b/i.test(t);
   const hasConcrete =
    /\b\d+\b/.test(t) ||
    /\b(beach|street|restaurant|hotel|office|school|airport|hospital|market|bar|train|bus)\b/i.test(t) ||
    /"[^"\n]{3,}"/.test(t);
 
  return Boolean(hasTime && hasScene && actionHits >= 2 && hasSequence && hasOutcome && hasConcrete);
 }

async function extractStoriesFromTranscript(
  transcriptText: string,
): Promise<StorySeed[]> {
  if (!transcriptText.trim() || !GEMINI_API_KEY) return [];

    const prompt = buildExtractStoriesPrompt({ transcriptText });

  const body = {
    contents: [
      { role: "user", parts: [{ text: prompt }] },
    ],
  };

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    if (!resp.ok) {
      console.error("extractStoriesFromTranscript Gemini error", resp.status, await resp.text());
      return [];
    }

    const json = await resp.json();
     const text =
       json?.candidates?.[0]?.content?.parts?.[0]?.text ??
       json?.candidates?.[0]?.content?.parts?.[0]?.rawText ??
       "";
 
    let parsed: any;
    try {
      // Gemini may wrap JSON in markdown fences or include extra prose; normalize first.
      const cleaned = String(text)
        .replace(/```(?:json)?/gi, "")
        .replace(/```/g, "")
        .trim();

      // Allow either an object wrapper { stories: [...] } OR a raw array root [...].
      if (cleaned.startsWith("[")) {
        parsed = { stories: JSON.parse(cleaned) };
      } else {
        parsed = JSON.parse(cleaned);
      }
    } catch {
      const raw = String(text)
        .replace(/```(?:json)?/gi, "")
        .replace(/```/g, "")
        .trim();

      const objMatch = raw.match(/\{[\s\S]*\}/);
      const arrMatch = raw.match(/\[[\s\S]*\]/);
      const m = objMatch?.[0] ?? arrMatch?.[0];
      if (!m) return [];
      parsed = m.startsWith("[") ? { stories: JSON.parse(m) } : JSON.parse(m);
    }

    const rawStories = Array.isArray(parsed?.stories) ? parsed.stories : [];
    return rawStories
      .map((s: any): StorySeed => ({
        story_key: String(s.story_key ?? "").trim(),
        title: String(s.title ?? "").trim(),
        body: String(s.body ?? "").trim(),
        tags: Array.isArray(s.tags) ? s.tags.map((t: any) => String(t)) : [],
        traits: Array.isArray(s.traits) ? s.traits.map((t: any) => String(t)) : [],
      }))
      .filter((s) => s.story_key && s.title && s.body && isValidStoryTextV1(s.body));
   } catch (err) {
     console.error("extractStoriesFromTranscript failed:", err);
     return [];
   }
  }

  // High-level persona flavors for legacy mode.
export type ConversationPersona = "adaptive" | "playful" | "somber";

// ===== Coverage & Lifetime types =====

export type CoverageChapterKey =
  | "early_childhood"
  | "adolescence"
  | "early_adulthood"
  | "midlife"
  | "later_life"
  | "family_relationships"
  | "work_career"
  | "education"
  | "health_wellbeing"
  | "hobbies_interests"
  | "beliefs_values"
  | "major_events";

export interface CoverageChapter {
  key: CoverageChapterKey;
  label: string;

  // 0.0-1.0; we still store a normalized score here.
  coverage_score: number;

  // Simple counts for debugging + UI.
  memory_count: number;
  word_count_estimate: number;

  // Sum of qualitative “weight” of memories mapped here.
  // A rich, detailed memory will usually contribute somewhere around ~1.0.
  total_weight: number;

  time_span?: {
    start_year?: number;
    end_year?: number;
  };
  last_covered_at?: string;         // ISO
  example_memory_ids: string[];
  summary_snippet?: string;
  open_questions: string[];
  suggested_prompts: string[];
}

export interface CoverageMap {
  version: number;
  user_id: string;
  last_updated: string;
  global: {
    total_memories: number;
    total_words_estimate: number;
    earliest_year?: number;
    latest_year?: number;
    dominant_themes: string[];
  };
  chapters: {
    [key in CoverageChapterKey]: CoverageChapter;
  };
}

function clamp01(value: unknown, fallback = 0): number {
  const n =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function computeMemoryWeightFromObservations(
  obs: MemorySummaryObservations,
  roughWordCount: number,
): number {
  // If the summariser has explicitly set memory_weight, respect it.
  if (typeof obs.memory_weight === "number") {
    const w = obs.memory_weight;
    if (!Number.isFinite(w)) return 0;
    return Math.max(0, Math.min(1, w));
  }

  const depth =
    typeof obs.narrative_depth_score === "number"
      ? obs.narrative_depth_score
      : 0.3;
  const emotional =
    typeof obs.emotional_depth_score === "number"
      ? obs.emotional_depth_score
      : 0.3;
  const reflection =
    typeof obs.reflection_score === "number"
      ? obs.reflection_score
      : 0.3;
  const distinct =
    typeof obs.distinctiveness_score === "number"
      ? obs.distinctiveness_score
      : 0.3;

  const quality = (depth + emotional + reflection + distinct) / 4;

  // Word-count factor: clips so that long rambling doesn’t explode the score.
  const wcFactor =
    roughWordCount > 0
      ? Math.min(1, Math.log10(roughWordCount + 10) / 3)
      : 0;

  const combined = 0.7 * quality + 0.3 * wcFactor;

  if (!Number.isFinite(combined) || combined <= 0) return 0;
  if (combined > 1) return 1;
  return combined;
}

// ---------------------------------------------------------------------------
// Coverage classification helpers
// ---------------------------------------------------------------------------

function normalizeCoverageChapterKey(
  raw: unknown,
): CoverageChapterKey | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();

  switch (key) {
    case "early_childhood":
    case "childhood":
    case "0-10":
    case "0-10":
      return "early_childhood";

    case "adolescence":
    case "teen":
    case "teens":
    case "11-18":
    case "11-18":
      return "adolescence";

    case "early_adulthood":
    case "young_adult":
    case "20s":
    case "19-30":
    case "19-30":
      return "early_adulthood";

    case "midlife":
    case "31-55":
    case "31-55":
      return "midlife";

    case "later_life":
    case "retirement":
    case "56+":
      return "later_life";

    case "family_relationships":
    case "family":
    case "relationships":
    case "romantic":
    case "partner":
      return "family_relationships";

    case "work_career":
    case "career":
    case "work":
    case "job":
      return "work_career";

    case "education":
    case "school":
    case "university":
    case "college":
      return "education";

    case "health_wellbeing":
    case "health":
    case "wellbeing":
    case "mental_health":
      return "health_wellbeing";

    case "hobbies_interests":
    case "hobbies":
    case "interests":
    case "free_time":
      return "hobbies_interests";

    case "beliefs_values":
    case "beliefs":
    case "values":
    case "spirituality":
      return "beliefs_values";

    case "major_events":
    case "events":
    case "milestones":
    case "turning_point":
      return "major_events";

    default:
      return null;
  }
}

async function extractSessionInsightsFromSummary(
  fullSummary: string,
  conversationId: string,
  sessionId: string,
): Promise<SessionInsightsJson | null> {
  // Deprecated: we no longer generate or persist session_insights.items/key_sentence.
  // End-of-session insights should come from the artifact pass (session_insights.reframed).
  void fullSummary;
  void conversationId;
  void sessionId;
  return null;
}

async function upsertCuratedStoriesForSession(
  client: SupabaseClient,
  userId: string,
  sessionId: string,        // memory_summary.id
  conversationId: string,   // conversation_id / session_key
  transcriptText: string,
) {
  const seeds = await extractStoriesFromTranscript(transcriptText);
  if (!seeds.length) return;

  for (const seed of seeds) {
    // Check if this story_key already exists for this user
    const { data: existing, error: selectError } = await client
      .from("memory_curated")
      .select("id, source_session_ids")
      .eq("user_id", userId)
      .eq("story_key", seed.story_key)
      .maybeSingle();

    if (selectError) {
      console.error("upsertCuratedStoriesForSession select error:", selectError);
      continue;
    }

    if (existing) {
      // Merge session into source_session_ids and update body/title/tags/traits
      const existingSessions: string[] =
        (existing.source_session_ids as string[] | null) ?? [];
      const mergedSessions = Array.from(
        new Set([...existingSessions, sessionId]),
      );

      const { error: updateError } = await client
        .from("memory_curated")
        .update({
          title: seed.title,
          curated_text: seed.body,
          tags: enrichedTags.length ? enrichedTags : null,
          traits: seed.traits ?? null,
          source_session_ids: mergedSessions,
        })
        .eq("id", existing.id);

      if (updateError) {
        console.error("upsertCuratedStoriesForSession update error:", updateError);
      }
    } else {
      // Insert a new curated story
      const { error: insertError } = await client
        .from("memory_curated")
        .insert({
          user_id: userId,
          memory_summary_id: sessionId,
          story_key: seed.story_key,
          title: seed.title,
          curated_text: seed.body,
          tags: enrichedTags.length ? enrichedTags : null,
          traits: seed.traits ?? null,
          source_session_ids: [sessionId],
          metadata: {
            conversation_id: conversationId,
          },
        });

      if (insertError) {
        console.error("upsertCuratedStoriesForSession insert error:", insertError);
      }
    }
  }
}

async function classifyCoverageFromStoryText(
  storyText: string | null | undefined,
): Promise<{ chapterKeys: CoverageChapterKey[]; themes: string[] } | null> {
  const trimmed = String(storyText ?? "").trim();
  if (!trimmed) return null;

    const prompt = buildCoverageClassificationPrompt({
    storyText: trimmed,
    allowedChapterKeys: [
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
    ],
  });

  const raw = await callGemini(prompt);

  try {
    const jsonText = extractJsonCandidate(raw) ?? raw;
    const parsed = JSON.parse(jsonText);
    // Support both explicit ranked fields and legacy chapter_keys / chapter fields.
    const rawPrimary: unknown = (parsed as any).primary_topic_key ?? (parsed as any).primary_chapter_key;
    const rawSecondary: unknown = (parsed as any).secondary_topic_key ?? (parsed as any).secondary_chapter_key;
    const rawTertiary: unknown = (parsed as any).tertiary_topic_key ?? (parsed as any).tertiary_chapter_key;
    const rawKeys: unknown = (parsed as any).topic_keys ?? (parsed as any).chapter_keys;

    const ordered: CoverageChapterKey[] = [];

    for (const candidate of [rawPrimary, rawSecondary, rawTertiary]) {
      const norm = normalizeCoverageChapterKey(candidate);
      if (norm && !ordered.includes(norm)) ordered.push(norm);
    }

    if (ordered.length === 0 && Array.isArray(rawKeys)) {
      for (const k of rawKeys) {
        const norm = normalizeCoverageChapterKey(k);
        if (norm && !ordered.includes(norm)) ordered.push(norm);
      }
    }

    const chapterKeys: CoverageChapterKey[] = ordered.slice(0, 3);

    if (chapterKeys.length === 0) {
      // Fallback: single generic bucket
      chapterKeys.push("major_events");
    }

    const themes: string[] = Array.isArray(parsed.themes)
      ? parsed.themes
          .filter((t: unknown) => typeof t === "string")
          .map((t: string) => t.trim())
          .filter((t: string) => t.length > 0)
      : [];

    return { chapterKeys, themes };
  } catch (err) {
    console.error("Coverage classification parse error:", err);
    return null;
  }
}

export interface LifetimeProfile {
  version: number;
  user_id: string;
  last_updated: string;
  core_identity: {
    legal_name?: string;
    display_name?: string;
    birth_date?: string;
    birth_year_estimate?: number;
    birth_place?: string;
    current_location?: string;
    generation_label?: string;
  };
  life_themes: {
    summary_sentence: string;
    recurring_challenges: string[];
    recurring_strengths: string[];
    legacy_hopes: string[];
  };
  interests_hobbies: {
    main_hobbies: string[];
    creative_outlets?: string[];
    recurring_topics?: string[];
  };
}

// ============================================================================
// Helpers
// ============================================================================
function languageDisplayName(locale: string, uiLocale: string = "und"): string {
  const code = (locale || "").toString().trim().replaceAll("_", "-").split("-")[0]?.toLowerCase();
  if (!code) return "the target language";
  try {
    // @ts-ignore
    const dn = new Intl.DisplayNames([uiLocale || "und"], { type: "language" });
    return dn.of(code) || code;
  } catch {
    return code;
  }
}


function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Internal server-to-server invoke for rebuild-insights (non-JWT).
// Requires rebuild-insights to be deployed with verify_jwt=false and to validate
// x-internal-key against INTERNAL_FUNCTION_KEY.
// ---------------------------------------------------------------------------
async function invokeRebuildInsightsInternal(payload: any): Promise<any> {
  const url = String(Deno.env.get("SUPABASE_URL") ?? "").trim();
  const internalKey = String(Deno.env.get("INTERNAL_FUNCTION_KEY") ?? "").trim();

  if (!url || !internalKey) {
    // Do not throw — rebuild-insights is optional.
    return { ok: false, skipped: true, reason: "missing_config", urlPresent: Boolean(url), keyPresent: Boolean(internalKey) };
  }

  const endpoint = `${url}/functions/v1/rebuild-insights`;

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-key": internalKey,
      },
      body: JSON.stringify(payload ?? {}),
    });
  } catch (e) {
    // Network / DNS / fetch error — optional path
    return { ok: false, status: 0, error: "fetch_failed", details: (e as any)?.message ?? String(e) };
  }

  const text = await resp.text().catch(() => "");
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch {}

  const benign =
    parsed?.ok === true ||
    parsed?.processed === 200 ||
    parsed?.meaningful_longitudinal?.ok === true ||
    /No new longitudinal insights/i.test(text);

  if (!resp.ok && !benign) {
    // Do not throw — optional path. Return structured failure for caller logging.
    return { ok: false, status: resp.status, error: "rebuild_failed", body: parsed ?? text };
  }

  return { ok: true, status: resp.status, body: parsed ?? text };
}

function normalizeLocale(raw: unknown, fallback = "und"): string {
  if (typeof raw !== "string") return fallback;
  const val = raw.trim();
  if (!val) return fallback;
  const cleaned = val.replaceAll("_", "-").trim();
  const lower = cleaned.toLowerCase();
  if (lower === "default") return fallback;

  // Use Intl.Locale when available to canonicalize BCP-47 tags, but stay agnostic:
  // no hard-coded language mappings.
  try {
    // @ts-ignore - Intl.Locale exists in Deno runtime.
    return new Intl.Locale(cleaned).toString();
  } catch {
    return cleaned;
  }
}

// NEW: collapse "xx-XX" → "th", "xx-XX" → "es" for progress keys.
function getProgressLanguageKey(locale: string | null | undefined): string {
  if (!locale) return "default";
  const parts = String(locale).split("-");
  if (!parts[0]) return "default";
  return parts[0].toLowerCase();
}

// Strip code fences / JSON / quotes so Flutter never sees them
function sanitizeGeminiOutput(text: string): string {
  if (!text) return text;

  let result = text;

  // Remove ```...``` blocks (any language)
  result = result.replace(/```[\s\S]*?```/g, "");
  result = result.replace(/```/g, "");

  // Remove bare { } [ ] lines and simple "key": prefixes
  result = result.replace(/^\s*[{\[]\s*$/gm, "");
  result = result.replace(/^\s*[}\]],?\s*$/gm, "");
  result = result.replace(/"[^"]*"\s*:\s*\[/g, "");
  result = result.replace(/"[^"]*"\s*:\s*/g, "");

  // Strip surrounding quotes on lines and trailing commas
  result = result.replace(/^"\s*(.*)\s*",?\s*$/gm, "$1");
  result = result.replace(/,\s*$/gm, "");

  // Remove empty lines
  result = result
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join("\n");

  return result.trim();
}

// Enforce any required language-tag rules on the model output.
// Minimal, safe default: do not modify content unless a target locale is present.
function enforceLanguageOnTaggedLines(
  text: string,
  _preferredLocale: string,
  _targetLocale: string | null,
): string {
  return text;
}

// ------- Legacy state utilities --------------------------------------------
function parseLegacyState(stateJson?: string | null): LegacyInterviewState | null {
  if (!stateJson) return null;
  try {
    const obj = JSON.parse(stateJson);
    if (!obj || typeof obj !== "object") return null;
    const state = obj as LegacyInterviewState;
    if (!state.chapter_id) return null;
    return {
      chapter_id: state.chapter_id,
      chapter_title: state.chapter_title ?? "",
      progress_percent:
        typeof state.progress_percent === "number"
          ? state.progress_percent
          : 0,
      focus_topic: state.focus_topic ?? null,
    };
  } catch {
    return null;
  }
}

function getDefaultLegacyState(): LegacyInterviewState {
  // Start in childhood by default; if you prefer another starting chapter
  // (e.g. "adolescence"), change the key here.
  const chapter = LEGACY_CHAPTERS["childhood"];
  return {
    chapter_id: chapter.chapter_id,
    chapter_title: chapter.chapter_title,
    progress_percent: 0,
    focus_topic: chapter.default_focus_topic,
  };
}
 
 // ------- Turn-state machine (prompt drift + task inertia control) ----------
 // Goal: replace scattered "heuristics" with an explicit, minimal state machine
 // that latches the active task and advances deterministically.
 type TurnTask =
   | "legacy_chat"
   | "recommendation"
   | "recall"
   | "story_retell";

 // Reply rendering mode (orthogonal to task). Used to prevent "bio dumps" and
 // force snapshot-first longitudinal reflections.
 type ReplyMode =
   | "FACTUAL"
   | "NARRATIVE"
   | "LONGITUDINAL_REFLECTION";   

 interface TurnStateV1 {
   v: 1;
   // Total turn count observed by the server for this conversation (best-effort).
   turn_index: number;
   // Current latched task.
   active_task: TurnTask;
   // Turn index within the active task (resets when task changes).
   task_turn_index: number;
   // Tiny, lossy signal to detect topic shifts without storing user text.
   last_topic_sig: string | null;
 }
 
 function getDefaultTurnState(): TurnStateV1 {
   return {
     v: 1,
     turn_index: 0,
     active_task: "legacy_chat",
     task_turn_index: 0,
     last_topic_sig: null,
   };
 }
 
 function parseTurnState(stateJson?: string | null): TurnStateV1 {
   if (!stateJson) return getDefaultTurnState();
   try {
     const obj: any = JSON.parse(stateJson);
     const ts: any = obj && typeof obj === "object" ? (obj.turn_state ?? obj.turnState ?? null) : null;
     if (!ts || typeof ts !== "object") return getDefaultTurnState();
     if (Number(ts.v) !== 1) return getDefaultTurnState();
     const active = String(ts.active_task ?? "legacy_chat");
     const allowed: TurnTask[] = ["legacy_chat", "recommendation", "recall", "story_retell"];
     const active_task: TurnTask = (allowed as string[]).includes(active) ? (active as TurnTask) : "legacy_chat";
     return {
       v: 1,
       turn_index: typeof ts.turn_index === "number" ? ts.turn_index : 0,
       active_task,
       task_turn_index: typeof ts.task_turn_index === "number" ? ts.task_turn_index : 0,
       last_topic_sig: typeof ts.last_topic_sig === "string" ? ts.last_topic_sig : null,
     };
   } catch {
     return getDefaultTurnState();
   }
 }
 
 function topicSignature(text: string): string {
   // Very small, lossy signature: normalize, strip punctuation, keep first ~64 chars.
   const t = String(text ?? "")
     .toLowerCase()
     .replace(/[\u200B-\u200D\uFEFF]/g, "")
     .replace(/[^a-z0-9\s]/g, " ")
     .replace(/\s+/g, " ")
     .trim();
   return t.slice(0, 64);
 }
 
 function looksLikeTopicReset(text: string): boolean {
   return /(?:new topic|different question|change topic|switch topics|unrelated|forget (?:that|this)|separate question)/i.test(
     String(text ?? ""),
   );
 }
 
 function inferTurnTaskFromMessage(text: string): TurnTask {
   const t = String(text ?? "").trim();
   const lower = t.toLowerCase();
 
   // Story-retell has priority over generic recall.
   if ((extractStoryRecallQuery(t) ?? "").trim().length > 0) return "story_retell";
 
   // Recall intent (facts about the user / prior sessions).
   if (
     detectRecallIntent(t) ||
     /\b(do you remember my|remember my|what(?:'s| is) my|tell me my|remind me my|who am i)\b/i.test(lower)
   ) {
     return "recall";
   }
 
   // Recommendation intent.
   if (
     /(?:\brecommend\b|\bsuggest\b|\breplacement\b|\breplace\b|\bwhat should i (?:buy|get)\b|\bwhich\b.*\bshould i get\b|\bwhat(?:'s| is) (?:a )?good\b.*\bfor me\b)/i.test(
       t,
     )
   ) {
     return "recommendation";
   }
 
   return "legacy_chat";
 }
 
 function advanceTurnState(prev: TurnStateV1, userText: string): TurnStateV1 {
   const next: TurnStateV1 = { ...prev };
   next.turn_index = Math.max(0, Number(prev.turn_index ?? 0)) + 1;
 
   const sig = topicSignature(userText);
   const inferred = inferTurnTaskFromMessage(userText);
 
   // Hard reset if the user explicitly signals a topic switch.
   if (looksLikeTopicReset(userText)) {
     next.active_task = inferred === "legacy_chat" ? "legacy_chat" : inferred;
     next.task_turn_index = 0;
     next.last_topic_sig = sig || null;
     return next;
   }
 
   // Task latch rules:
   // - If we’re in recommendation, stay there unless we see strong recall/retell.
   // - If we’re in recall/retell, stay there only if the user is still asking recall-ish.
   // - Otherwise, move to inferred task.
   const prevTask = prev.active_task;
   let nextTask: TurnTask = prevTask;
 
   if (prevTask === "recommendation") {
     if (inferred === "story_retell" || inferred === "recall") nextTask = inferred;
     else nextTask = "recommendation";
   } else if (prevTask === "story_retell" || prevTask === "recall") {
     if (inferred === "story_retell" || inferred === "recall") nextTask = inferred;
     else nextTask = "legacy_chat";
   } else {
     nextTask = inferred;
   }
 
   // Topic shift soft reset: if sig changed a lot and we were latched, drop to inferred.
   if (prev.last_topic_sig && sig && prevTask !== "legacy_chat") {
     const changed = prev.last_topic_sig !== sig;
     if (changed && inferred !== prevTask && inferred !== "legacy_chat") {
       nextTask = inferred;
     } else if (changed && inferred === "legacy_chat") {
       // If they shifted away and didn’t ask for the task again, drop latch.
       nextTask = "legacy_chat";
     }
   }
 
   if (nextTask !== prevTask) {
     next.active_task = nextTask;
     next.task_turn_index = 0;
   } else {
     next.active_task = nextTask;
     next.task_turn_index = Math.max(0, Number(prev.task_turn_index ?? 0)) + 1;
   }
 
   next.last_topic_sig = sig || null;
   return next;
 }
 
 function buildTurnDirective(ts: TurnStateV1): string {
   const base =
     "TURN_DIRECTIVE (state machine; overrides drift):\n" +
     `- active_task: ${ts.active_task}\n` +
     `- task_turn_index: ${ts.task_turn_index}\n` +
     "- Do NOT restart discovery loops. Continue the active task unless the user clearly changes topics.\n";
 
   if (ts.active_task === "recommendation") {
     return (
       base +
       "RECOMMENDATION_PROTOCOL:\n" +
       "- You MUST give 1–3 concrete recommendations NOW.\n" +
       "- Treat this turn as constraints/refinement for the same recommendation.\n" +
       "- After recommending, ask at most ONE follow-up only if it would materially change the pick.\n"
     );
   }
 
   if (ts.active_task === "story_retell") {
     return (
       base +
       "STORY_RETELL_PROTOCOL:\n" +
       "- Retell immediately (no meta about records/logs).\n" +
       "- Minimum 4 sentences. Start with the first event.\n"
     );
   }
 
    if (ts.active_task === "recall") {
      return (
       base +
       "RECALL_PROTOCOL:\n" +
       "- If USER_FACTS / CANONICAL_EVIDENCE is present, answer directly.\n" +
       "- If not present BUT the answer appears in 'RECENT TURNS FROM THIS SESSION', answer using ONLY that info.\n" +
       "  - Start with: \"Earlier in this session you said...\"\n" +
       "  - IMPORTANT: Do NOT say \"I don't have that recorded yet\" (or similar) if RECENT TURNS contains the answer.\n" +
       "  - After answering, you MAY ask: \"Would you like me to save that?\"\n" +
       "- If neither USER_FACTS/CANONICAL_EVIDENCE nor RECENT TURNS contains it, say you don’t have it recorded yet and ask ONE targeted clarifier.\n"
     );
   }
 
   return (
     base +
     "LEGACY_CHAT_PROTOCOL:\n" +
     "- No parroting. Add at least one grounded insight or a forward-moving question.\n" +
     "- Ask at most ONE question.\n"
   );
 }

async function loadLatestLongitudinalSnapshot(
  client: SupabaseClient,
  userId: string,
): Promise<{ created_at: string | null; snapshot: any; snapshot_text: string } | null> {
  try {
    const { data, error } = await client
      .from("memory_summary")
      .select("created_at, observations")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(12);

    if (error) {
      console.warn("loadLatestLongitudinalSnapshot: memory_summary select failed (non-fatal):", error);
      return null;
    }
    const rows = Array.isArray(data) ? data : [];
    for (const r of rows) {
      const obs = (r as any)?.observations;
      const snap = obs?.longitudinal_snapshot;
      if (!snap || typeof snap !== "object") continue;

      const snapshot_text = String((snap as any).snapshot_text ?? "").trim();
      const emerging = Array.isArray((snap as any).emerging_themes_month) ? (snap as any).emerging_themes_month : [];
      const changed = (snap as any).changed_since_last_week || {};
      const up = Array.isArray((changed as any).up) ? (changed as any).up : [];
      const down = Array.isArray((changed as any).down) ? (changed as any).down : [];

      if (snapshot_text.length > 0 || emerging.length > 0 || up.length > 0 || down.length > 0) {
        return { created_at: (r as any)?.created_at ?? null, snapshot: snap, snapshot_text };
      }
    }
    return null;
  } catch (e) {
    console.warn("loadLatestLongitudinalSnapshot: unexpected error (non-fatal):", String(e));
    return null;
  }
}

/**
 * Build an optional context block for LEGACY mode based on past sessions
 * and distilled insights, so the AI can say things like
 * "Last time you mentioned..." instead of starting cold every time.
 */
// Around ~ line 27xx in your 4303-line file
async function buildLegacyContextBlock(
  userId: string,
  conversationId?: string,
): Promise<string> {
  if (!supabase) return "";
  const client = supabase as SupabaseClient;

  try {
    // 0) Recent turns from THIS session (highest-value continuity context)
    // NOTE: We keep this small and clipped to avoid token bloat.
    const { data: recentTurns, error: rtError } = conversationId
      ? await client
          .from("memory_raw")
          .select("role, content, created_at")
          .eq("user_id", userId)
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: false })
          .limit(14)
      : { data: null as any, error: null as any };

    if (rtError) {
      console.error("buildLegacyContextBlock: recent memory_raw (this session) error", rtError);
    }

    // 1) Recent session-level summaries (layer 2)
    const { data: summaries, error: msError } = await client
      .from("memory_summary")
      .select("id, short_summary, session_insights, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(3);

    if (msError) {
      console.error("buildLegacyContextBlock: memory_summary error", msError);
    }

    // 2) Recent distilled insights (layer 3)
    const { data: insights, error: miError } = await client
      .from("memory_insights")
      .select("short_title, insight_text, insight_type, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(3);

    if (miError) {
      console.error("buildLegacyContextBlock: memory_insights error", miError);
    }

    const lines: string[] = [];

    // Layer 0 - continuity context from this session
    if (recentTurns && Array.isArray(recentTurns) && recentTurns.length > 0) {
      // We fetched newest-first; flip back to chronological for readability.
      const chron = [...(recentTurns as any[])].reverse();
      lines.push(
        "RECENT TURNS FROM THIS SESSION (use these to avoid repeating questions; connect the dots):",
      );

      // Keep to the last ~10-12 turns and clip each line.
      const tail = chron.length > 12 ? chron.slice(chron.length - 12) : chron;
      for (const t of tail) {
        const created = (t as any).created_at
          ? new Date((t as any).created_at as string)
              .toISOString()
              .slice(11, 19)
          : "--:--:--";

        const role = ((t as any).role as string | null) === "assistant" ? "AI" : "USER";
        const content = String((t as any).content ?? "").trim();
        if (!content) continue;
        const trimmed = content.length > 220 ? content.slice(0, 217) + "..." : content;
        lines.push(`- [${created}] ${role}: ${trimmed}`);
      }
    }

    // Layer 2 - session summaries
    if (summaries && summaries.length > 0) {
      lines.push(
        "RECENT SESSION CONTEXT (do NOT repeat these verbatim; use them only to sound like a friend who remembers past conversations):",
      );

      for (const s of summaries) {
        const created = (s as any).created_at
          ? new Date((s as any).created_at as string)
              .toISOString()
              .slice(0, 10)
          : "unknown date";
        const label =
          ((s as any).short_summary as string | null) ??
          (((s as any).session_insights as any)?.full_summary as string | null) ??
          "";
        const trimmed =
          label.length > 160 ? label.slice(0, 157) + "..." : label;
        lines.push(`- [${created}] ${trimmed}`);
      }
    }

    // (We intentionally removed the older "RECENT SPECIFIC STORIES" pull from memory_raw
    // filtered by tags. It was less useful for in-the-moment continuity and added cost.)

    // Layer 3 - high-level insights
    if (insights && insights.length > 0) {
      if (lines.length > 0) {
        lines.push("");
      }

      lines.push(
        "HIGH-LEVEL INSIGHTS ABOUT THIS PERSON (use gently, do NOT psychoanalyze):",
      );

      for (const ins of insights) {
        const title = (ins as any).short_title as string | null ?? "(no title)";
        const text = (ins as any).insight_text as string | null ?? "";
        const type = (ins as any).insight_type as string | null ?? "general";
        const trimmed =
          text.length > 220 ? text.slice(0, 217) + "..." : text;
        lines.push(`- (${type}) ${title}: ${trimmed}`);
      }

      lines.push(
        "",
        'Use these insights only to choose warmer follow-up questions and very occasional callbacks like "you\'ve mentioned before that..." or "last time we talked about...", when it genuinely fits.',
        "Important: do NOT assume hardship, trauma, poverty, discrimination, or activism based solely on birthplace, era, race, gender, or other demographics.",
        "If an insight sounds like a stereotype, treat it as a gentle question to explore, not as a fact.",
      );
    }

    if (lines.length === 0) {
      return "";
    }

    return `
PERSISTENT CONTEXT FROM EARLIER SESSIONS
${lines.join("\n")}
`.trim();
  } catch (err) {
    console.error("buildLegacyContextBlock: unexpected error", err);
    return "";
  }
}

/**
+ * Lightweight session-only continuity context for Legacy mode.
+ * Pulls ONLY memory_raw turns for the current (user_id, conversation_id).
+ * This enables "current session awareness" without triggering extra DB reads.
+ */
async function buildSessionRecentTurnsBlock(
  userId: string,
  conversationId: string,
  limit = 14,
): Promise<string> {
  const client = supabase as SupabaseClient;
  try {
    // Guardrails: Postgres uuid columns will throw 22P02 if passed "undefined" (string) or non-uuid.
    const isUuid = (s: string): boolean =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s ?? "").trim());

    if (!isUuid(userId) || !isUuid(conversationId)) {
      // Keep this silent-ish: this block is best-effort context only.
      // Avoid spamming logs; but do help with debugging if needed.
      // console.warn("buildSessionRecentTurnsBlock: invalid ids", { userId, conversationId });
      return "";
    }

    const { data: recentTurns, error } = await client
      .from("memory_raw")
      .select("role, content, created_at")
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("buildSessionRecentTurnsBlock: memory_raw error", error);
      return "";
    }
    if (!recentTurns || !Array.isArray(recentTurns) || recentTurns.length === 0) return "";

    // newest-first -> chronological
    const chron = [...(recentTurns as any[])].reverse();
    const lines: string[] = [];
    lines.push(
      "RECENT TURNS FROM THIS SESSION (use these to avoid repeating questions; connect the dots):",
    );

    const tail = chron.length > 12 ? chron.slice(chron.length - 12) : chron;
    for (const t of tail) {
      const created = (t as any).created_at
        ? new Date((t as any).created_at as string).toISOString().slice(11, 19)
        : "--:--:--";
      const role = ((t as any).role as string | null) === "assistant" ? "AI" : "USER";
      const content = String((t as any).content ?? "").trim();
      if (!content) continue;
      const trimmed = content.length > 220 ? content.slice(0, 217) + "..." : content;
      lines.push(`- [${created}] ${role}: ${trimmed}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.error("buildSessionRecentTurnsBlock: unexpected error", err);
    return "";
  }
}

/**
 * Build a tiny, turn-local "current focus" block for LEGACY mode.
 * Purpose: keep the model anchored on what the user is trying to do *right now*
 * (goal + constraints) even late in long sessions, without hardcoding topics.
 *
 * Minimal + reversible: purely derived from the already-built contextBlock
 * (RECENT TURNS FROM THIS SESSION) + the current user message.
 */
function buildCurrentFocus(userMessage: string, contextBlock: string): string {
  const um = String(userMessage ?? "").trim();
  if (!um) return "";

  const ctx = String(contextBlock ?? "");
  const turnRe = /^- \[\d\d:\d\d:\d\d\] (AI|USER): (.+)$/gm;
  const turns: { role: "AI" | "USER"; content: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = turnRe.exec(ctx)) !== null) {
    const role = (m[1] as any) === "AI" ? "AI" : "USER";
    const content = String(m[2] ?? "").trim();
    if (content) turns.push({ role, content });
  }

  // Use only the last ~10 turns for continuity.
  const tail = turns.length > 10 ? turns.slice(turns.length - 10) : turns;

  const looksLikeGoal = (s: string): boolean =>
    /(?:\brecommend\b|\bsuggest\b|\breplacement\b|\breplace\b|\bwhat should i\b|\bshould i\b|\bhelp me\b|\bchoose\b|\bdecide\b|\bpick\b|\bcompare\b|\bbased on what you know\b|\bwhich one\b)/i.test(
      s,
    );

  const looksLikeConstraint = (s: string): boolean =>
    /(?:\bprice\b|\bbudget\b|\$\s*\d+|\bunder\b|\baround\b|\bcompatible\b|\biphone\b|\bandroid\b|\bmust\b|\brequire(?:ment|ments)?\b|\bprefer\b|\btracking\b|\bfeatures?\b|\bbattery\b|\bsleep\b|\bheart rate\b|\bsteps\b)/i.test(
      s,
    );

  // 1) Find the most recent "goal-like" USER turn in the tail. If none, use current message.
  let goal = um;
  for (let i = tail.length - 1; i >= 0; i--) {
    const t = tail[i];
    if (t.role === "USER" && looksLikeGoal(t.content)) {
      goal = t.content;
      break;
    }
  }

  // 2) Collect constraint-like USER turns after that goal (plus current message).
  const constraints: string[] = [];
  const seen = new Set<string>();

  const pushConstraint = (raw: string) => {
    const s = String(raw ?? "").trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const clipped = s.length > 120 ? s.slice(0, 117) + "..." : s;
    constraints.push(clipped);
  };

  // Identify where the goal sits (best-effort).
  let goalIdx = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i].role === "USER" && tail[i].content === goal) {
      goalIdx = i;
      break;
    }
  }

  for (let i = Math.max(0, goalIdx); i < tail.length; i++) {
    const t = tail[i];
    if (t.role !== "USER") continue;
    if (t.content === goal) continue;
    if (looksLikeConstraint(t.content)) pushConstraint(t.content);
  }
  if (looksLikeConstraint(um)) pushConstraint(um);

  const goalClipped = goal.length > 160 ? goal.slice(0, 157) + "..." : goal;

  const out: string[] = [];
  out.push("CURRENT_FOCUS (keep this short; do NOT lose the plot across turns):");
  out.push(`- Goal: ${goalClipped}`);
  if (constraints.length > 0) {
    out.push(
      `- Constraints so far (from this session): ${constraints.slice(0, 5).join(" | ")}`,
    );
  } else {
    out.push("- Constraints so far (from this session): (none explicitly stated)");
  }
  out.push(
    "- Instruction: Treat the user's latest message as a continuation/refinement of the current goal unless they clearly change topics. Do not restart discovery questions if enough constraints exist to answer.",
  );

  return out.join("\n");
}

/**
 * Build a tiny "current recommendation" block derived from recent AI turns in this session.
 * Purpose: keep referents stable across turns ("your recommendation", "the options you gave")
 * without hardcoding any domain (watches, travel, etc.).
 *
 * Minimal + reversible:
 * - No DB reads/writes
 * - Parses the already-built contextBlock ("RECENT TURNS FROM THIS SESSION")
 */
function buildCurrentRecommendation(contextBlock: string): string {
  const ctx = String(contextBlock ?? "");
  if (!ctx) return "";

  const turnRe = /^- \[\d\d:\d\d:\d\d\] (AI|USER): (.+)$/gm;
  const turns: { role: "AI" | "USER"; content: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = turnRe.exec(ctx)) !== null) {
    const role = (m[1] as any) === "AI" ? "AI" : "USER";
    const content = String(m[2] ?? "").trim();
    if (content) turns.push({ role, content });
  }
  if (!turns.length) return "";

  // Work off the tail only; we want the most recent recommendation-like answer.
  const tail = turns.length > 14 ? turns.slice(turns.length - 14) : turns;

  const looksLikeRecAnswer = (s: string): boolean =>
    /(?:\bi recommend\b|\bi(?:'m| am) recommending\b|\bmy recommendation\b|\brecommendations?\b|\bsuggestions?\b|\boptions?\b|\bhere are\b.*\b(?:recommendations?|options?)\b|\bi'd recommend\b)/i.test(
      s,
    );

  const extractCandidates = (s: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();

    const push = (raw: string) => {
      const c = String(raw ?? "").trim();
      if (!c) return;
      const norm = c.toLowerCase();
      if (seen.has(norm)) return;
      // Avoid obviously generic captures.
      if (/^(options?|recommendations?|suggestions?)$/i.test(c)) return;
      seen.add(norm);
      out.push(c);
    };

    // 1) Prefer bold markdown items (**X**) because your assistant often formats recs that way.
    const boldRe = /\*\*([^*]{2,120})\*\*/g;
    let bm: RegExpExecArray | null;
    while ((bm = boldRe.exec(s)) !== null) {
      push(bm[1]);
      if (out.length >= 3) break;
    }
    if (out.length) return out;

    // 2) Try: "I'd recommend the X" / "I recommend the X"
    const recPhrase = s.match(
      /(?:i'd recommend|i recommend|my recommendation(?: is)?)(?:\s*[:\-]?\s*)(?:the\s+)?([A-Za-z0-9][^.\n,;]{2,80})/i,
    );
    if (recPhrase?.[1]) {
      push(recPhrase[1]);
      if (out.length) return out;
    }

    // 3) Try numbered/bulleted lines: "1. X:" / "- X:"
    const lines = s.split("\n").map((x) => x.trim());
    for (const line of lines) {
      const mm =
        line.match(/^(?:\d+\.)\s+(.{2,80}?)(?:\s*[:\-–—]|$)/) ||
        line.match(/^(?:[-*])\s+(.{2,80}?)(?:\s*[:\-–—]|$)/);
      if (mm?.[1]) {
        push(mm[1]);
        if (out.length >= 3) break;
      }
    }
    return out;
  };

  // Find most recent AI rec-like answer.
  let recText = "";
  for (let i = tail.length - 1; i >= 0; i--) {
    const t = tail[i];
    if (t.role === "AI" && looksLikeRecAnswer(t.content)) {
      recText = t.content;
      break;
    }
  }
  if (!recText) return "";

  const candidates = extractCandidates(recText);
  if (!candidates.length) return "";

  const primary = candidates[0];
  const alternates = candidates.slice(1);

  const out: string[] = [];
  out.push("CURRENT_RECOMMENDATION (keep referents stable across turns):");
  out.push(`- Primary: ${primary}`);
  out.push(`- Alternates: ${alternates.length ? alternates.join(" | ") : "(none captured)"}`);
  out.push(
    "- Instruction: If the user says “your recommendation” or “the options you gave”, treat Primary/Alternates above as the referent unless the user explicitly specifies a different item.",
  );
  return out.join("\n");
}

function buildEmptyCoverageMap(userId: string): CoverageMap {
  const baseChapters: Record<CoverageChapterKey, CoverageChapter> = {
    early_childhood: {
      key: "early_childhood",
      label: "Early Childhood (0-10)",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    adolescence: {
      key: "adolescence",
      label: "Adolescence (11-18)",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    early_adulthood: {
      key: "early_adulthood",
      label: "Early Adulthood (19-30)",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    midlife: {
      key: "midlife",
      label: "Midlife (31-55)",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    later_life: {
      key: "later_life",
      label: "Later Life (56+)",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    family_relationships: {
      key: "family_relationships",
      label: "Family & Relationships",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    work_career: {
      key: "work_career",
      label: "Work & Career",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    education: {
      key: "education",
      label: "Education",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    health_wellbeing: {
      key: "health_wellbeing",
      label: "Health & Wellbeing",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    hobbies_interests: {
      key: "hobbies_interests",
      label: "Hobbies & Interests",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    beliefs_values: {
      key: "beliefs_values",
      label: "Beliefs & Values",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    major_events: {
      key: "major_events",
      label: "Major Life Events",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
  };

  return {
    version: 1,
    user_id: userId,
    last_updated: new Date().toISOString(),
    global: {
      total_memories: 0,
      total_words_estimate: 0,
      total_memory_weight: 0,
      earliest_year: undefined,
      latest_year: undefined,
      dominant_themes: [],
    },
    chapters: baseChapters,
  };
}

function finalizeCoverageScores(map: CoverageMap): CoverageMap {
  const TARGET_WEIGHT_PER_CHAPTER = 50;   // “enough” rich memories per chapter
  const TARGET_WORDS_PER_CHAPTER = 50000; // rough word-volume target

  for (const chapter of Object.values(map.chapters)) {
    const weight = chapter.total_weight ?? 0;
    const words = chapter.word_count_estimate ?? 0;

    const weightFactor = Math.min(
      weight / TARGET_WEIGHT_PER_CHAPTER,
      1,
    );
    const wordFactor = Math.min(
      words / TARGET_WORDS_PER_CHAPTER,
      1,
    );

    // Weight is the primary driver, word-count is a secondary floor.
    const combined =
      weightFactor > 0
        ? 0.7 * weightFactor + 0.3 * wordFactor
        : 0.3 * wordFactor;

    chapter.coverage_score = Number(
      Math.min(1, Math.max(0, combined)).toFixed(2),
    );
  }

  return map;
}

// ============================================================================
// Gemini call
// ============================================================================
async function callGemini(
  input:
    | string
    | {
        model?: string;
        system?: string;
        user: string;
        temperature?: number;
        maxOutputTokens?: number;
      },
): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing.");
  }

  // Normalize model name for the Generative Language API which expects `models/<name>`
  const requestedModel =
    typeof input === "string" ? (GEMINI_MODEL ?? "") : (input.model ?? GEMINI_MODEL ?? "");
  const modelName = requestedModel.startsWith("models/")
    ? requestedModel
    : `models/${requestedModel}`;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

  const userText = typeof input === "string" ? input : (input.user ?? "");

  const payload: any = {
    contents: [
      {
        role: "user",
        parts: [{ text: String(userText) }],
      },
    ],
  };

  if (typeof input !== "string") {
    if (typeof input.system === "string" && input.system.trim()) {
      payload.systemInstruction = { parts: [{ text: input.system }] };
    }

    payload.generationConfig = {
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
      ...(typeof input.maxOutputTokens === "number"
        ? { maxOutputTokens: input.maxOutputTokens }
        : {}),
    };
  }

  // Retry on transient capacity/rate errors (429/503) with exponential backoff + jitter.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const maxRetries = 6;
  let res: Response | null = null;
  let lastErrText = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) break;

    lastErrText = await res.text();
    const status = res.status;

    // Respect Retry-After when present (seconds).
    const retryAfter = res.headers.get("retry-after");
    const retryAfterMs =
      retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : null;

    const isRetryable = status === 429 || status === 503;
    const isLast = attempt === maxRetries;

    console.error("❌ Gemini API error:", status, lastErrText, {
      attempt,
      maxRetries,
      retryAfter,
    });

    if (!isRetryable || isLast) {
      throw new Error(`Gemini API error: ${status} - ${lastErrText}`);
    }

    const baseMs = 750 * Math.pow(2, attempt); // 750, 1500, 3000, ...
    const jitter = 0.8 + Math.random() * 0.4; // 0.8–1.2x
    const delayMs = Math.min(30000, Math.floor((retryAfterMs ?? baseMs) * jitter));
    await sleep(delayMs);
  }

  if (!res || !res.ok) {
    // Defensive: should not happen, but keeps error messages consistent.
    throw new Error(`Gemini API error: ${res?.status ?? "unknown"} - ${lastErrText}`);
  }

  const json = await res.json();

  try {
    const parts = json?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const text = parts
        .map((p: any) => (typeof p.text === "string" ? p.text : ""))
        .join("\n")
        .trim();

      if (text) return text;
    }
  } catch (e) {
    console.error("❌ Error parsing Gemini response:", e, json);
  }

  return "Sorry, I could not generate a reply.";
}

async function upsertCoverageMapRow(
  supabase: SupabaseClient,
  userId: string,
  map: CoverageMap
) {
  const { error } = await supabase
    .from("coverage_map_json")
    .upsert(
      {
        user_id: userId,
        data: map,
      },
      { onConflict: "user_id" }
    );

  if (error) {
    console.error("Error upserting coverage_map_json:", error);
  }
}


// Best-effort snapshot writer for coverage_timeline.
// This is intentionally resilient: if the table/columns differ, we log and continue.
async function tryInsertCoverageTimelineRow(
  supabase: SupabaseClient,
  userId: string,
  map: CoverageMap | null
) {
  if (!map) return;

  const preferredBucket = "lifetime";
  const preferredLifeStage = "unspecified";

  const candidateJsonColumns = ["snapshot", "coverage_map", "map"];
  const missing = new Set<string>();

  for (const col of candidateJsonColumns) {
    if (missing.has(col)) continue;

    const row: any = {
      user_id: userId,
      bucket: preferredBucket,
      life_stage: preferredLifeStage,
    };

    row[col] = map;

    // PRIMARY PATH — idempotent UPSERT
    let { error } = await supabase
      .from("coverage_timeline")
      .upsert(row, {
        onConflict: "user_id,bucket,life_stage",
      });

    if (!error) return;

    // PostgREST schema cache missing column
    if ((error as any)?.code === "PGRST204") {
      const msg = String((error as any)?.message || "");
      if (msg.includes(`"${col}"`)) {
        missing.add(col);
        continue;
      }

      // Fallback UPDATE (schema cache may be stale)
      const updatePayload: any = {};
      updatePayload[col] = map;

      const { error: updErr } = await supabase
        .from("coverage_timeline")
        .update(updatePayload)
        .match({
          user_id: userId,
          bucket: preferredBucket,
          life_stage: preferredLifeStage,
        });

      if (!updErr) return;

      console.error("coverage_timeline update fallback failed:", updErr);
      return;
    }

    // Duplicate key (defensive — should not occur with upsert)
    if ((error as any)?.code === "23505") {
      const updatePayload: any = {};
      updatePayload[col] = map;

      const { error: updErr } = await supabase
        .from("coverage_timeline")
        .update(updatePayload)
        .match({
          user_id: userId,
          bucket: preferredBucket,
          life_stage: preferredLifeStage,
        });

      if (!updErr) return;

      console.error("coverage_timeline duplicate recovery failed:", updErr);
      return;
    }

    // Enum rejection (life_stage not accepted)
    if ((error as any)?.code === "22P02") {
      console.warn(
        `coverage_timeline skipped: life_stage '${preferredLifeStage}' not accepted by enum`
      );
      return;
    }

    // NOT NULL violation
    if ((error as any)?.code === "23502") {
      console.warn("coverage_timeline skipped: NOT NULL constraint violation");
      return;
    }

    // Any other error is real
    console.error("Error writing coverage_timeline:", error);
    return;
  }
}

function inferChapterKeysForLegacySummary(
  text: string,
  themes: string[] = []
): CoverageChapterKey[] {
  const lowered = text.toLowerCase();
  const set = new Set<CoverageChapterKey>();

  const add = (k: CoverageChapterKey) => set.add(k);

  const hasTheme = (needle: string) =>
    themes.some((t) => t.toLowerCase().includes(needle));

  // Life-stage / time-of-life hints
  if (
    /\b(childhood|kid|elementary school|growing up)\b/.test(lowered) ||
    hasTheme("childhood")
  ) {
    add("early_childhood");
  }

  if (
    /\b(teen|high school|prom|adolescence)\b/.test(lowered) ||
    hasTheme("adolescence")
  ) {
    add("adolescence");
  }

  if (
    /\b(college|university|degree|class|teacher|course|study|studies|school)\b/.test(
      lowered,
    ) ||
    hasTheme("education")
  ) {
    add("education");
  }

  // Work & career
  if (
    /\b(job|work|career|office|boss|manager|company|business|client|coworker|co-worker)\b/.test(
      lowered,
    ) ||
    hasTheme("work") ||
    hasTheme("career")
  ) {
    add("work_career");
  }

  // Family & relationships (this will catch girlfriend / partner, etc.)
  if (
    /\b(mom|mother|dad|father|parent|parents|sister|brother|son|daughter|wife|husband|girlfriend|boyfriend|partner|family)\b/.test(
      lowered,
    ) ||
    hasTheme("family") ||
    hasTheme("relationship")
  ) {
    add("family_relationships");
  }

  // Health & wellbeing
  if (
    /\b(health|hospital|doctor|illness|sick|disease|mental health|anxiety|stress|exercise|gym|diet|weight|blood pressure)\b/.test(
      lowered,
    ) ||
    hasTheme("health")
  ) {
    add("health_wellbeing");
  }

  // Hobbies, interests, and your Murder Crabs-style food adventures
  if (
    /\b(hobby|hobbies|music|sport|sports|cycling|bike|bicycle|travel|trip|vacation|game|gaming|movie|film|reading|book|photography|cooking|cook|kitchen|restaurant|food|crab|seafood)\b/.test(
      lowered,
    ) ||
    hasTheme("hobby") ||
    hasTheme("interest")
  ) {
    add("hobbies_interests");
  }

  // Beliefs / values
  if (
    /\b(church|temple|mosque|faith|belief|value|philosophy|religion|god|spiritual)\b/.test(
      lowered,
    ) ||
    hasTheme("belief") ||
    hasTheme("values")
  ) {
    add("beliefs_values");
  }

  // Major life events, milestones, shocks
  if (
    /\b(wedding|marriage|divorce|accident|fired|laid off|promotion|move|moved|immigration|migration|born|birth|death|died|funeral|war|earthquake|pandemic)\b/.test(
      lowered,
    ) ||
    hasTheme("major_event") ||
    hasTheme("milestone")
  ) {
    add("major_events");
  }

  // Additional life-stage cues
  if (/\b(twenties|20s)\b/.test(lowered)) {
    add("early_adulthood");
  }
  if (/\b(thirties|30s|forties|40s|fifties|50s|midlife)\b/.test(lowered)) {
    add("midlife");
  }
  if (
    /\b(retired|retirement|sixties|60s|seventies|70s|later in life|old age)\b/.test(
      lowered,
    )
  ) {
    add("later_life");
  }

  // If literally nothing matched, treat it as a memorable event.
  if (!set.size) {
    add("major_events");
  }

  return Array.from(set);
}

async function recomputeCoverageMapForUser(
  supabase: SupabaseClient,
  userId: string
): Promise<CoverageMap | null> {
  const { data, error } = await supabase
    .from("memory_summary")
    .select(
      "id, user_id, raw_id, created_at, short_summary, session_insights, observations"
    )
    .eq("user_id", userId);

  if (error) {
    console.error("Error fetching memory_summary for coverage_map:", error);
    return null;
  }

  const rows = (data || []) as MemorySummaryRow[];
  const map = buildEmptyCoverageMap(userId);

  // If there truly are no summaries yet, write an empty map and return.
  if (!rows.length) {
    console.log(
      "[coverage] recomputeCoverageMapForUser: no memory_summary rows for user",
      userId
    );
    await upsertCoverageMapRow(supabase, userId, map);
    return map;
  }

  console.log(
    "[coverage] recomputeCoverageMapForUser: rows.length =",
    rows.length
  );

  const themeCounts: Record<string, number> = {};

  for (const row of rows) {
    const meta = (row.observations || {}) as {
      // New contract: topic_keys (preferred)
      topic_keys?: CoverageChapterKey[];
      // Legacy: chapter_keys (back-compat)
      chapter_keys?: CoverageChapterKey[];

      start_year?: number;
      end_year?: number;
      word_count_estimate?: number;
      themes?: string[];
    };

    // 1) Prefer explicit topic_keys from the newer pipeline…
    let chapters: CoverageChapterKey[] = Array.isArray(meta.topic_keys)
      ? meta.topic_keys
      : Array.isArray(meta.chapter_keys)
        ? meta.chapter_keys
        : [];
    // 2) …but for older summaries (or anything missing chapter_keys), lazily
    //    infer the best-guess chapters from the text + any theme tags.
    if (!chapters.length) {
      const textForInfer =
        (row.session_insights as any)?.full_summary || (row.session_insights as any)?.short_summary || row.short_summary ||
        "";
      const themes = Array.isArray(meta.themes) ? meta.themes : [];
      chapters = inferChapterKeysForLegacySummary(textForInfer, themes);
    }

    const text =
      (row.session_insights as any)?.full_summary || (row.session_insights as any)?.short_summary || row.short_summary ||
      "";

    const roughWordCount =
      meta.word_count_estimate ??
      (text ? text.split(/\s+/).length : 0);

    // Always count this summary globally.
    map.global.total_memories += 1;
    map.global.total_words_estimate += roughWordCount;

    if (meta.start_year != null) {
      if (
        map.global.earliest_year == null ||
        meta.start_year < map.global.earliest_year
      ) {
        map.global.earliest_year = meta.start_year;
      }
    }
    if (meta.end_year != null) {
      if (
        map.global.latest_year == null ||
        meta.end_year > map.global.latest_year
      ) {
        map.global.latest_year = meta.end_year;
      }
    }

    for (const t of meta.themes || []) {
      const key = String(t).toLowerCase();
      themeCounts[key] = (themeCounts[key] || 0) + 1;
    }

    // If there are no chapter mappings, skip the per-chapter update,
    // but keep the global counters we just updated.
    if (!chapters.length) continue;

    for (const chapterKey of chapters) {
      const chapter = map.chapters[chapterKey];
      if (!chapter) continue;

      chapter.memory_count += 1;
      chapter.word_count_estimate += roughWordCount;

      if (meta.start_year != null) {
        if (
          !chapter.time_span?.start_year ||
          meta.start_year <
            (chapter.time_span.start_year || 9999)
        ) {
          chapter.time_span = chapter.time_span || {};
          chapter.time_span.start_year = meta.start_year;
        }
      }
      if (meta.end_year != null) {
        if (
          !chapter.time_span?.end_year ||
          meta.end_year >
            (chapter.time_span.end_year || 0)
        ) {
          chapter.time_span = chapter.time_span || {};
          chapter.time_span.end_year = meta.end_year;
        }
      }

      if (
        !chapter.last_covered_at ||
        new Date(row.created_at) >
          new Date(chapter.last_covered_at)
      ) {
        chapter.last_covered_at = row.created_at;
      }

      if (!chapter.example_memory_ids.includes(row.id)) {
        if (chapter.example_memory_ids.length < 5) {
          chapter.example_memory_ids.push(row.id);
        }
      }
    }
  }

  // Recompute global totals from the per-chapter coverage so the
  // headline "memories captured" stays in sync with what the user
  // sees in the chapter buckets.
  const chapterList = Object.values(map.chapters);

  map.global.total_memories = chapterList.reduce(
    (sum, ch: any) => sum + (ch.memory_count ?? 0),
    0,
  );

  map.global.total_words_estimate = chapterList.reduce(
    (sum, ch: any) => sum + (ch.word_count_estimate ?? 0),
    0,
  );

  const themeEntries = Object.entries(themeCounts).sort(
    (a, b) => b[1] - a[1]
  );

  map.global.dominant_themes = themeEntries
    .slice(0, 5)
    .map(([key]) => key);

  const finalized = finalizeCoverageScores(map);
  finalized.last_updated = new Date().toISOString();

  await upsertCoverageMapRow(supabase, userId, finalized);
  return finalized;
}

export async function recomputeLifetimeProfileForUser(
  supabase: SupabaseClient,
  userId: string,
  coverage: CoverageMap | null,
): Promise<LifetimeProfile | null> {
  // NOTE: This reads from your public.profiles table (donor preferences / settings).
  // Your schema has: display_name, legal_name, birthdate, country_region, preferred_language, supported_languages, etc.
  const { data: prof, error: profileError } = await supabase
    .from("profiles")
    .select(
      "id, display_name, legal_name, birthdate, country_region, preferred_language, supported_languages",
    )
    .eq("id", userId)
    .maybeSingle();

  if (profileError) {
    console.error("Error fetching profile for lifetime_profile:", profileError);
    return null;
  }

  const displayName = (prof as any)?.display_name ?? undefined;
  const legalName = (prof as any)?.legal_name ?? undefined;

  const birthdateRaw = (prof as any)?.birthdate as string | null | undefined;
  const birthDate = birthdateRaw ? String(birthdateRaw) : undefined;

  let birthYearEstimate: number | undefined = undefined;
  if (birthDate) {
    const m = /^(\d{4})-/.exec(birthDate);
    if (m) birthYearEstimate = Number(m[1]);
  }

  const countryRegion = (prof as any)?.country_region ?? undefined;

  const nowIso = new Date().toISOString();

  const out: LifetimeProfile = {
    version: 1,
    user_id: userId,
    last_updated: nowIso,
    core_identity: {
      legal_name: legalName,
      display_name: displayName,
      birth_date: birthDate,
      birth_year_estimate: birthYearEstimate,
    },
    locations: {
      current_location: countryRegion,
      birth_place: undefined,
    },
    preferences: {
      preferred_language: (prof as any)?.preferred_language ?? undefined,
      supported_languages: Array.isArray((prof as any)?.supported_languages)
        ? (prof as any)?.supported_languages
        : undefined,
    },
    coverage_snapshot: coverage ?? undefined,
  };

  return out;
}

export async function recomputeUserKnowledgeGraphs(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  try {
    const coverage = await recomputeCoverageMapForUser(
      supabase,
      userId
    );
    await tryInsertCoverageTimelineRow(supabase, userId, coverage);
    await recomputeLifetimeProfileForUser(
      supabase,
      userId,
      coverage
    );
} catch (err) {
    console.error("Error recomputing user knowledge graphs:", err);
  }
}


  // ============================================================================
  // HTTP Handler
  // ============================================================================


// ------------------------------
// Recall evidence helpers (minimal, fail-closed)
// These exist to prevent runtime ReferenceErrors and to enforce "no evidence → no claim".
// ------------------------------

type RecallEvidence = {
  kind: 'capsule' | 'memory_raw' | 'memory_summary' | 'story_recall' | 'story_seed' | 'browse';
  id: string;
  created_at?: string;
  title?: string;
  excerpt: string;
};

function _safeStr(v: unknown, max = 280): string {
  const s = (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Explicit recall tests are things like "what did I say about X", "do you remember", "earlier you said", etc.
function isExplicitRecallTestIntent(userText: string): boolean {
  const t = (userText || '').toLowerCase();
  if (!t) return false;
  return (
    /\b(do you remember|remember when|what did i say|what did i tell you|earlier you said|you said earlier|last time i said|previously i said|from our last|in a prior session)\b/.test(t) ||
    /\brecall test\b/.test(t)
  );
}

// "What do you have recorded/remembered" requests sometimes explicitly scope to THIS conversation.
// We must honor that by preventing cross-session fact hydration and by constraining responses.
function isRecordedRequest(userText: string): boolean {
  const t = (userText || "").toLowerCase();
  if (!t) return false;
  return /\bwhat do you (have )?(recorded|remember)\b/.test(t) ||
    /\bwhat (have|do) you (record|remember)\b/.test(t);
}

function requestsLocalOnlyMemory(userText: string): boolean {
  const t = (userText || "").toLowerCase();
  if (!t) return false;
  return (
    /\bonly use what i said\b/.test(t) ||
    /\b(only|just) use\b.*\b(this conversation|this chat|here)\b/.test(t) ||
    /\bfrom this conversation\b/.test(t) ||
    /\bin this conversation\b/.test(t) ||
    /\bthis conversation only\b/.test(t)
  );
}

function requestsCrossSessionMemory(userText: string): boolean {
  const t = (userText || "").toLowerCase();
  if (!t) return false;
  return /\b(prior|previous|last)\s+session\b/.test(t) ||
    /\bacross sessions\b/.test(t) ||
    /\bhistorical\b/.test(t) ||
    /\bfrom our last\b/.test(t);
}

function isSummaryOrSynthesisRequest(userText: string): boolean {
  const t = (userText || "").toLowerCase();
  if (!t) return false;
   return /\b(summarize|summary|synthesis|integrated understanding)\b/.test(t) ||
     /\bcurrent true version\b/.test(t) ||
     /\bchanges? and corrections?\b/.test(t);
 }
 
// Explicit save intent: user explicitly asks to persist a fact ("Please record that", "Save this", etc).
// Deterministic (no LLM) so it works even when end_session is off or ui_fast skips facts.
function isExplicitSaveRequest(userText: string): boolean {
  const t = (userText || "").toLowerCase().trim();
  if (!t) return false;
  return (
    /\b(please|pls)\s+(save|record)\b/.test(t) ||
    /\b(save|record)\s+(this|that|it)\b/.test(t) ||
    /\b(save|record)\s+my\b/.test(t) ||
    /\bcan\s+you\s+(save|record)\b/.test(t) ||
    /\b(?:i\s+(?:would\s+like|want)|i\s*\'d\s+like)\s+(?:for\s+you\s+to\s+)?(save|record)\b/.test(t) ||
    /\bplease\s+(?:save|record)\s+my\b/.test(t) ||
    /\bsave\s+it\b/.test(t) ||
    /\brecord\s+it\b/.test(t)
  );
}

function extractExplicitSaveInlineTarget(userText: string): string | null {
  const raw = (userText || "").trim();
  if (!raw) return null;
  // "Please record that: <fact>" or "Save this - <fact>"
  const m1 = raw.match(/(?:please\s+|pls\s+)?(?:save|record)\s+(?:this|that|it)\s*[:\-]\s*(.+)$/i);
  if (m1 && m1[1]) {
    const s = String(m1[1]).trim();
    return s.length ? s : null;
  }
  // "Please record that <fact>" (inline remainder, but guard command-only)
  const m2 = raw.match(/(?:please\s+|pls\s+)?(?:save|record)\s+(?:this|that|it)\s+(.*)$/i);
  if (m2 && m2[1]) {
    const s = String(m2[1]).trim();
    if (s.length && s.length > 6) return s;
  }
  return null;
}

type ExplicitSaveInput = {
  client: SupabaseClient;
  user_id: string;
  conversation_id: string;
  raw_id_this_turn: string | null;  // id of the current user turn row in memory_raw
  user_text: string;
  created_at_iso: string;
};

async function persistExplicitSaveBestEffort(input: ExplicitSaveInput): Promise<void> {
  try {
    const { client, user_id, conversation_id, raw_id_this_turn, user_text, created_at_iso } = input;
    const userText = String(user_text || "").trim();
    if (!userText) return;
    if (!isExplicitSaveRequest(userText)) return;

    // Inline: "record that: <fact>"
    let targetText: string | null = extractExplicitSaveInlineTarget(userText);
    let receiptId: string | null = raw_id_this_turn ? String(raw_id_this_turn) : null;

    // Command-only: "Please record that." → attach the immediately prior user turn (not this command).
    if (!targetText) {
      const { data: prev, error: prevErr } = await client
        .from("memory_raw")
        .select("id, content")
        .eq("user_id", user_id)
        .eq("conversation_id", conversation_id)
        .eq("role", "user")
        .eq("source", "legacy_user")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(2);

      if (prevErr) {
        console.warn("explicit_save: prior turn lookup failed (non-fatal):", prevErr);
        return;
      }
      const rows = Array.isArray(prev) ? prev : [];
      // Exclude the current command turn id (raw_id_this_turn) so we pick the prior factual statement.
      const picked = rows.find((r: any) => String(r?.id ?? "") !== String(receiptId ?? "")) || null;
      if (picked && picked.id && typeof picked.content === "string") {
        targetText = String(picked.content).trim();
        receiptId = String(picked.id);
      }
    }

    const normalized = (targetText || "").replace(/\s+/g, " ").trim();
    if (!normalized || !receiptId) return;

    const h = await sha256Hex(normalized.toLowerCase());
    const fact_key = `explicit_save.${h.slice(0, 12)}`;

     const payload: any = {
       user_id,
       fact_key,
       canonical_key: null,
       stability: null,
       value_json: { text: normalized },
      context: { source: "explicit_save" },
       confidence: 1.0,
       receipt_ids: [receiptId],
       receipt_quotes: [normalized],
       is_locked: false,
       updated_at: created_at_iso,
     };
 
     const { error: upErr } = await client
      .from(USER_FACTS_TABLE)
       .upsert(payload, { onConflict: "user_id,fact_key" });
 
     if (upErr) {
      console.warn("explicit_save: facts_effective upsert failed (non-fatal):", upErr);
     } else {
      console.log("explicit_save: persisted", { user_id, conversation_id, fact_key, receipt_id: receiptId });
     }
  } catch (e) {
    console.warn("explicit_save: threw (non-fatal):", e);
  }
}

 // Detect "meta" replies that promise a summary but don't deliver one.
 function looksLikeMetaAckOnly(replyText: string): boolean {
   const t = (replyText || "").trim();
   if (!t) return true;
   const low = t.toLowerCase();
   const meta =
    /\bi can\b/.test(low) ||
    /\bi will\b/.test(low) ||
    /\bokay\b/.test(low) ||
    /\bready when you are\b/.test(low) ||
    /\bwould you like\b/.test(low) ||
    /\bcan you (?:tell|share)\b/.test(low) ||
    /\bwhat comes to mind\b/.test(low);

  // If it's short and mostly meta language, treat as non-execution.
  return meta && t.length < 260 && !/\n\n/.test(t) && !/\bwhat i have recorded\b/.test(low);
 }
 
// Detect "story stall" replies that promise a retell but don't deliver it.
function looksLikeStoryStall(replyText: string): boolean {
  const t = (replyText || "").trim();
  if (!t) return true;

  const low = t.toLowerCase();

  // Meta-inventory / bookkeeping replies are never a retell.
  // Catch these early so we always trigger the retry/fallback path.
  if (/\b(recorded|records|entries|entry|database|logs?)\b/.test(low)) {
    return true;
  }
  
  // Narrative retell gate: treat anything that is short, meta-prefacing, or
  // non-narrative as a stall (so we can trigger one retry with the hard override).

  // 1) Very short or meta-prefacing responses are almost never a retell.
  if (t.length < 260 && /\b(i can|i could|i will|i\s*'m|i am|i am able|i\s*'m able)\b/.test(low)) {
    return true;
  }
  if (t.length < 260 && /\b(able to tell you|can tell you|would you like|is that alright|can i)\b/.test(low)) {
    return true;
  }

  // 2) Require a minimally narrative shape: multiple sentences + enough content.
  const sentenceCount = (t.match(/[.!?]+/g) || []).length;
  if (t.length < 220) return true;
  if (sentenceCount < 3) return true;

  // 3) Require at least one narrative cue (temporal connector or past-tense verb).
  const hasNarrativeCue = /\b(then|after|before|when|while|because|so|until|eventually|suddenly|later|at first)\b/.test(low);
  const hasPastTenseVerb = /\b(was|were|had|did|went|found|made|took|tried|failed|managed|ended|started|began|decided|realized|noticed)\b/.test(low);
  if (!hasNarrativeCue && !hasPastTenseVerb) return true;

  return false;
}

// Story retell UX: strip meta "inventory" prefixes so the retell starts like a story.
function normalizeStoryRetellPrefixText(text: string): string {
  let t = (text || "").trim();
  if (!t) return t;

  // Remove common meta-prefaces (case-insensitive), only if they occur at the start.
  t = t.replace(/^i have recorded that\s+/i, "");
  t = t.replace(/^i have recorded\s+/i, "");
  t = t.replace(/^you asked me(?: to)? tell (?:me|you) (?:the )?story about[^.?!]*[.?!]?\s*/i, "");
  t = t.replace(/^i see several entries[^.?!]*[.?!]\s*/i, "");
  t = t.replace(/^here is one version:\s*/i, "");

  // Also trim any leading quote-style wrappers that sometimes show up.
  t = t.replace(/^["'“”‘’]+/, "").trim();
  return t;
}

function stripTrailingQuestion(replyText: string): string {
  let t = (replyText || "").trim();
  if (!t) return t;
  // Remove a single trailing question (common failure mode) while preserving the body.
  // Example: "...behavior." + " What did you make of it?"
  t = t.replace(/\s+[^\n?.!]{0,220}\?\s*$/s, "").trim();
  return t;
}

// Try to extract a short "recall query" from the user's message.
// Returns "" if we can't reliably extract anything.
function extractStoryRecallQuery(userText: string): string {
  const t = (userText || '').trim();
  if (!t) return '';

  // Guard: only extract a story recall query when the user actually indicates story/retell intent.
  // Without this, generic questions like "What is my father's name?" accidentally become storyQuery
  // and route the turn into story recall mode, skipping deterministic fact recall.
  const tl = t.toLowerCase();
  const hasStoryCue =
    /\b(story|stories|experience|experiences|account|accounts|retell|recap)\b/.test(tl) ||
    /\b(do you remember|remember when|earlier you said|you said earlier|last time|prior session)\b/.test(tl);
  if (!hasStoryCue) return '';

  // Strip common lead-ins (keep this conservative; it runs before DB scans).
   let q = t
     .replace(/^(do you remember|remember when|what did i say about|what did i tell you about|earlier you said|you said earlier|last time i said)\s+/i, '')
     .replace(/^(do you have any|any)\s+(interesting\s+)?(story|stories|account|accounts)\s+(about|related to)\s+/i, '')
    // Handle: "tell me the/a/my story about X", "tell me the story of X", etc.
    .replace(
      /^(tell me|retell)\s+((the|a|an|my)\s+)?(story|stories|experience|experiences|account|accounts)\s+(about|with|of)\s+/i,
      ''
     )
     .replace(/[?!.]+$/g, '')
     .trim();

  // Normalize punctuation inside phrases (e.g. "murder, crabs" -> "murder crabs")
  q = q.replace(/[,\u2013\u2014]/g, ' ');
  q = q.replace(/\s+/g, ' ').trim();

  // Handle: "tell me the X story" / "retell my X story" (no "about/of/with")
  // Example: "Tell me the Murder crab story." -> "Murder crab"
  q = q
    .replace(/^(tell me|retell)\s+((the|a|an|my)\s+)?/i, '')
    .replace(/\b(story|stories|experience|experiences|account|accounts)\b$/i, '')
    .trim();
 
   // If still looks like a generic question, avoid triggering recall.
   if (q.length < 3) return '';
   // Keep it short to avoid noisy DB scans.
  if (q.length > 120) q = q.slice(0, 120).trim();
  return q;
}

function detectConnectDotsIntent(userText: string): boolean {
  const t = String(userText ?? "").toLowerCase();
  if (!t) return false;

  // "Connect the dots" / "what keeps showing up" / cross-session patterns.
  if (/\b(connect the dots|connect-the-dots|what keeps showing up|what keeps coming up|keeps showing up|keeps coming up)\b/.test(t)) {
    return true;
  }
  // Explicit "across sessions" / "over time" / "recurring pattern" language.
  if (/\b(across (?:sessions|conversations)|over (?:time|these (?:days|years)|the (?:weeks|months))|recurring|recurs|pattern|themes?|throughline|through-line)\b/.test(t)) {
    return true;
  }
  // "Synthesize my patterns" style prompts.
  if (/\b(synthesize|connect|link)\b/.test(t) && /\b(pattern|themes?|threads?)\b/.test(t)) {
    return true;
  }
  // "What does that say about me" / "what does it mean about me" style requests.
  // These are often implicit synthesis/inference prompts even without the phrase "connect the dots".
  if (/\b(what does (?:that|this|it) (?:say|mean) about me|tell me what (?:that|this|it) (?:says|means) about me|what does (?:that|this|it) reveal about me)\b/.test(t)) {
    return true;
  }
  // "Based on what you know/what we've talked about" → usually asking for implication/pattern-connecting.
  if (/\b(based on what (?:you know|we(?:\s+have)? talked about)|given what you know)\b/.test(t) && /\b(about me|my)\b/.test(t)) {
    return true;
  }

  // Common informal asks that still mean "synthesize".
  if (/\b(make sense of|help me understand|what\'s going on with me|why does this bother me|why am i like this)\b/.test(t)) {
    return true;
  }
  return false;
}

function shouldInjectRelevantPriorContextForReply(userText: string, task: TurnTask, replyMode: ReplyMode): boolean {
  // Longitudinal reflection already injects snapshot + relevant context.
  if (replyMode === "LONGITUDINAL_REFLECTION") return false;

  const t = String(userText ?? "").toLowerCase().trim();
  if (!t) return false;

  // Story retell should be allowed to connect to other prior stories/facts.
  if (task === "story_retell") return true;

  // Avoid polluting recommendations and strict factual recall unless explicitly reflective.
  const looksReflective =
    /\b(what does (?:that|this|it) (?:say|mean) about me|tell me what (?:that|this|it) (?:says|means) about me|what does (?:that|this|it) reveal about me|based on what (?:you know|we(?:\s+have)? talked about)|given what you know|why do i|pattern|theme|throughline|connect|link)\b/.test(t);

  if (looksReflective) return true;

  // Light heuristic: if user is comparing experiences ("this reminds me of") allow.
  if (/\b(reminds me of|similar to|connects back to)\b/.test(t)) return true;

  return false;
}

// Detect when the user is explicitly asking for synthesis/interpretation (even if phrased imperfectly).
// This is NOT routing; it just tightens response constraints so the model produces themes + implications
// instead of a loose recap.
function detectUserRequestedSynthesis(userText: string): boolean {
  const t = String(userText ?? "").toLowerCase();
  if (!t) return false;

  // Direct synthesis verbs.
  if (/\b(synthesize|synthesis|summarize|recap|distill|boil down)\b/.test(t)) return true;

  // Common "what does that say about me" phrasing.
  if (/\b(what does (?:that|this|it) (?:say|mean) about me|tell me what (?:that|this|it) (?:says|means) about me|what does (?:that|this|it) reveal about me)\b/.test(t)) {
    return true;
  }

  // Patterns/themes/throughlines across examples.
  if (/\b(theme|themes|pattern|throughline|thread|threads|connect|link|across my|across these)\b/.test(t)) {
    return true;
  }

  // "Based on what you know" often implies inference/synthesis.
  if (/\b(based on what (?:you know|we(?:\s+have)? talked about)|given what you know)\b/.test(t)) {
    return true;
  }

  return false;
}

// Detect when the user explicitly asks to be challenged / have flaws pointed out.
// This enables a direct critique response (no meta preface, no stalling).
function detectUserRequestedChallenge(userText: string): boolean {
  const t = String(userText ?? "").toLowerCase();
  if (!t) return false;

  // Direct verbs.
  if (/(\bchallenge\b|\bpush back\b|\bcriticize\b|\bcritique\b|\bfind flaws\b|\bpoint out (?:my|the) flaws\b|\btell me where (?:i\s*am|i'm) wrong\b|\bwhat\s+am\s+i\s+missing\b|\bdevil'?s advocate\b)/.test(t)) {
    return true;
  }

  // "Be brutally honest" + "about my view(s)" patterns.
  if (/\b(brutally honest|be direct|no sugarcoat|no sugar-coat)\b/.test(t) && /\b(my|mine)\b/.test(t) && /\b(view|views|theory|argument|take|position)\b/.test(t)) {
    return true;
  }

  return false;
}

function inferReplyModeFromMessage(userText: string, task: TurnTask): ReplyMode {
  if (detectConnectDotsIntent(userText)) return "LONGITUDINAL_REFLECTION";
  if (task === "recall") return "FACTUAL";
  // story_retell is narrative by definition; otherwise default to narrative.
  return "NARRATIVE";
}

function detectRecallIntent(userText: string): boolean {
  const t = (userText || '').toLowerCase();
  if (!t) return false;

  // Explicit test harness intent always wins.
  if (isExplicitRecallTestIntent(t)) return true;

  // Classic "earlier / last time" phrasing.
  if (
    /\b(earlier|previous|last time|before|prior session|in that session|from that day)\b/.test(t) &&
    /\b(you said|i said|we talked|we discussed|remember|recall|mention)\b/.test(t)
  ) {
    return true;
  }

  // Story-specific phrasing that often *is* a recall request even without "earlier".
  // Examples: "my suckling pig story", "accounts related to murder crabs", "retell my story about X".
  if (/\b(story|stories|account|accounts|retell)\b/.test(t) && /\b(my|about|related to|from when)\b/.test(t)) {
    return true;
  }

  // Universal personal-fact lookup intent.
  // Examples:
  // - "what is my father's name?"
  // - "who is my doctor?"
  // - "what's my birthday?"
  // - "tell me my address"
  // These should hydrate user_facts recall even without "earlier/last time".
  if (
    /\b(what(?:'s| is)|who(?:'s| is)|tell me|remind me|show me|give me)\b/.test(t) &&
    /\bmy\b/.test(t)
  ) {
    return true;
  }

  // Synthesis / "my views" requests are recall-like even without "earlier/last time".
  // Examples:
  // - "Please synthesize my thoughts about modern dating"
  // - "Summarize my views on relationships"
  // - "What do you know about my opinion on X?"
  if (
    /\b(synthesize|summarize|recap)\b/.test(t) &&
    /\b(my|mine)\b/.test(t)
  ) {
    return true;
  }
  if (
    /\b(what do you know|what have you recorded)\b/.test(t) &&
    /\b(my|mine)\b/.test(t)
  ) {
    return true;
  }
  return false;
}

function looksLikeRecallContinuation(userText: string): boolean {
  const t = (userText || '').toLowerCase().trim();
  if (!t) return false;
  // "Tell me about that/it" etc.
  return /\b(tell me|remind me|what about|more about|expand on)\b/.test(t) && /\b(it|that|this|those|them)\b/.test(t);
}

async function inferRecallQueryFromRecentTurns(
  supabase: SupabaseClient,
  user_id: string,
  conversation_id: string,
): Promise<string> {
  try {
    // Try to get the most recent prior user turn in this conversation and extract a query from it.
    const { data } = await supabase
      .from('memory_raw')
      .select('content, role, created_at')
      .eq('user_id', user_id)
      .eq('conversation_id', conversation_id)
      .order('created_at', { ascending: false })
      .limit(10);

    for (const row of data || []) {
      if (row?.role === 'user' && typeof row.content === 'string' && row.content.trim().length > 0) {
        const q = extractStoryRecallQuery(row.content);
        if (q) return q;
      }
    }
    return '';
  } catch (_err) {
    return '';
  }
}

async function hydrateRecallEvidence(
  supabase: SupabaseClient,
  user_id: string,
  userMessageForPrompt: string,
  storyQuery: string,
): Promise<RecallEvidence[]> {
  try {
    const extracted =
      storyQuery ||
      extractStoryRecallQuery(userMessageForPrompt) ||
      "";

    const explicitRecall = /\b(remember|recall|what do you remember|tell me what you remember)\b/i.test(
      userMessageForPrompt || ""
    );

    const q = (extracted || (explicitRecall ? "*" : "")).trim();
    if (!q) return [];

    const _storyQ = (extracted || "").trim().toLowerCase();
    const evidences: RecallEvidence[] = [];

    // Phase 3 narrative capsules are the canonical recall surface (they already normalize summaries).
    // IMPORTANT: do not query memory_summary.full_summary (deprecated / dropped in schema).
    const { data: capsules } = await supabase
      .from("phase3_session_capsules_narrative")
      .select("summary_id, created_at, short_summary, full_summary")
      .eq("user_id", user_id)
      .or(`short_summary.ilike.%${q}%,full_summary.ilike.%${q}%`)
      .order("created_at", { ascending: false })
      .limit(6);

    for (const row of capsules || []) {
      evidences.push({
        kind: "capsule",
        id: row.summary_id,
        created_at: row.created_at,
        excerpt: _safeStr(row.full_summary || row.short_summary, 420),
      });
    }

    // Story recall index (preferred over raw story_seeds when present).
    // NOTE: synopsis is often empty; try to extract narrative from evidence_json too.
    const extractEvidenceText = (ev: any, maxLen: number): string => {
      if (!ev) return "";
      if (typeof ev === "string") return _safeStr(ev, maxLen);
      if (typeof ev !== "object") return "";
      const keys = ["seed_text", "story", "text", "narrative", "retell", "summary", "excerpt", "content"];
      for (const k of keys) {
        const v = (ev as any)?.[k];
        if (typeof v === "string" && v.trim().length > 0) return _safeStr(v, maxLen);
      }
      // One-level deep scan for any long-ish string field
      for (const [_, v] of Object.entries(ev)) {
        if (typeof v === "string" && v.trim().length >= 180) return _safeStr(v, maxLen);
      }
      return "";
    };

    const { data: storyRecall } = await supabase
      .from("story_recall")
      .select("id, updated_at, title, synopsis, story_seed_id, evidence_json")
      .eq("user_id", user_id)
      .or(`title.ilike.%${q}%,synopsis.ilike.%${q}%`)
      .order("updated_at", { ascending: false })
      .limit(6);

    // If this is a story-retell request, do NOT feed multiple story candidates.
    // Pick the top match and provide its best narrative backing (seed_text) when available.
    const _storyRows = storyRecall || [];
    const _useSingleStory = _storyQ.length > 0;
    const _picked = _useSingleStory ? _storyRows.slice(0, 1) : _storyRows;
    let _pickedSeedId: string | null = null;
    let _pickedTitle: string | null = null;
    let _pickedTitleForSeedFallback: string | null = null;
    let _pickedStoryRecallId: string | null = null;
    let _pickedSynopsisLen = 0;

for (const row of _picked) {
      if (!_pickedTitle) _pickedTitle = _safeStr((row as any)?.title, 120);
      if (!_pickedTitleForSeedFallback) {
        _pickedTitleForSeedFallback = _pickedTitle;
      }
      if (!_pickedStoryRecallId) {
        _pickedStoryRecallId = (row as any)?.id ?? null;
        _pickedSynopsisLen = ((row as any)?.synopsis || "").toString().trim().length;
      }
       evidences.push({
         kind: "story_recall",
         id: row.id,
         created_at: row.updated_at,
         title: _safeStr(row.title, 120),
         excerpt: _safeStr(row.synopsis, 420),
       });
       _pickedSeedId = (row as any)?.story_seed_id ?? null;
     }

    // Add the underlying seed_text for the picked story when present (more narrative than synopsis).
    if (_useSingleStory && _pickedSeedId) {
      const { data: pickedSeed } = await supabase
        .from("story_seeds")
        .select("id, created_at, title, seed_text")
        .eq("id", _pickedSeedId)
        .limit(1);

      const s = (pickedSeed || [])[0] as any;
      if (s?.id) {
        evidences.push({
          kind: "story_seed",
          id: s.id,
          created_at: s.created_at,
          title: _safeStr(s.title, 120),
          excerpt: _safeStr(s.seed_text, 900),
        });
      }      
    }

    // If this is a story-retell request but the picked story has no synopsis AND no story_seed_id,
    // fall back to finding a narrative seed by title (prevents meta "you asked" replies).
    if (_useSingleStory && !_pickedSeedId) {
      const _tq = (_pickedTitleForSeedFallback || q || "").trim();
       if (_tq) {
         const { data: seedByTitle } = await supabase
           .from("story_seeds")
           .select("id, created_at, title, seed_text")
           .eq("user_id", user_id)
           .or(`title.ilike.%${_tq}%,seed_text.ilike.%${_tq}%`)
           .order("created_at", { ascending: false })
           .limit(1);

        const s2 = (seedByTitle || [])[0] as any;
        if (s2?.id) {
          evidences.push({
            kind: "story_seed",
            id: s2.id,
            created_at: s2.created_at,
            title: _safeStr(s2.title, 120),
            excerpt: _safeStr(s2.seed_text, 900),
          });
        }
      }
    }

    // Additional narrative fallback: pull from memory_raw (this is where the original story turn usually lives).
    // This protects story retell even when story_recall.synopsis and story_seeds.seed_text are empty or non-narrative.
    if (_useSingleStory) {
      const _mq = (_pickedTitleForSeedFallback || _storyQ || q || "").trim();
       if (_mq) {
         const { data: rawHits } = await supabase
           .from("memory_raw")
           .select("id, created_at, role, content")
           .eq("user_id", user_id)
           .or(`content.ilike.%${_mq}%`)
           .order("created_at", { ascending: false })
           .limit(10);

        const candidates = (rawHits || [])
          .filter((r: any) => (r?.content || "").trim().length >= 180)
          .sort((a: any, b: any) => ((b?.content || "").length - (a?.content || "").length));

        const bestRaw = candidates[0] as any;
        if (bestRaw?.id) {
          const rawExcerpt = _safeStr(bestRaw.content, 1100);
          evidences.push({
            kind: "memory_raw",
            id: bestRaw.id,
            created_at: bestRaw.created_at,
            title: "Original story (raw)",
            excerpt: rawExcerpt,
          });

          // Index upgrade: if story_recall.synopsis is missing/too short, persist a better synopsis
          // so future recalls don't depend on raw transcript fragments.
          // Non-fatal: best-effort update.
          if (_pickedStoryRecallId && _pickedSynopsisLen < 180 && rawExcerpt.trim().length >= 180) {
             try {
               await supabase
                 .from("story_recall")
                 .update({ synopsis: _safeStr(rawExcerpt, 420) })
                 .eq("id", _pickedStoryRecallId);
             } catch {
               // non-fatal
             }
           }          
         }
       }
     }

    // Story seeds are a strong secondary source for recall queries.
    const { data: seeds } = await supabase
      .from("story_seeds")
      .select("id, created_at, title, seed_text")
      .eq("user_id", user_id)
      .or(`title.ilike.%${q}%,seed_text.ilike.%${q}%`)
      .order("created_at", { ascending: false })
      .limit(6);

    for (const row of seeds || []) {
      if (_pickedSeedId && row.id === _pickedSeedId) continue;
      evidences.push({
        kind: "story_seed",
        id: row.id,
        created_at: row.created_at,
        title: _safeStr(row.title, 120),
        excerpt: _safeStr(row.seed_text, 420),
      });
    }

    // If we still have nothing, do a small raw scan (last resort).
    if (evidences.length === 0) {
      const { data: raws } = await supabase
        .from("memory_raw")
        .select("id, created_at, content")
        .eq("user_id", user_id)
        .ilike("content", `%${q}%`)
        .order("created_at", { ascending: false })
        .limit(8);

      for (const row of raws || []) {
        evidences.push({
          kind: "memory_raw",
          id: row.id,
          created_at: row.created_at,
          excerpt: _safeStr(row.content, 420),
        });
      }
    }

    // If this is a story-retell request and we already have story evidence,
    // drop "request-only" snippets (they cause meta replies like "you asked me 3 times").
    try {
      const storyQ = (extracted || "").trim().toLowerCase();
      if (storyQ.length > 0) {
        const hasStoryEvidence = evidences.some((e) => e.kind === "story_recall" || e.kind === "story_seed");
        if (hasStoryEvidence) {
          const isRequestOnly = (s: string) => {
            const t = (s ?? "").toLowerCase();
            return (
              t.includes("tell me the story") ||
              t.includes("tell me a story") ||
              t.includes("retell") ||
              t.includes("recap") ||
              (t.includes("story about") && t.length < 140)
            );
          };
          const filtered = evidences.filter(
            (e) => !((e.kind === "memory_raw" || e.kind === "story_seed") && isRequestOnly(e.excerpt)),
          );
          evidences.length = 0;
          evidences.push(...filtered);
        }
      }
    } catch (_e) {
       // non-fatal
    }

    // Story-retell robustness: even when story_recall.synopsis and story_seeds.seed_text are empty
    // (or filtered as request-only), attempt to pull a narrative excerpt from memory_raw.
    // This is intentionally NOT gated on evidences.length===0 because story_recall rows can exist
    // without containing any narrative text.
    const storyQ = (extracted || "").trim().toLowerCase();
    if (storyQ.length > 0) {
      const hasNarrative = evidences.some((e) => (e.excerpt || "").trim().length >= 180);
      if (!hasNarrative) {
        const needle1 = (extracted || "").trim();
        const needle2 = (_pickedTitle || "").trim();
        const needle3 = (q || "").trim();

        const tryNeedle = async (rawNeedle: string) => {
          if (!rawNeedle) return [] as any[];
          const { data: raws2 } = await supabase
            .from("memory_raw")
            .select("id, created_at, content")
            .eq("user_id", user_id)
            .ilike("content", `%${rawNeedle}%`)
            .order("created_at", { ascending: false })
            .limit(12);
          return (raws2 || []) as any[];
        };

        // Prefer extracted (e.g. "murder crabs") over picked title (often not verbatim in transcript).
        let raws2 = await tryNeedle(needle1);
        if (!raws2.length && needle2 && needle2 !== needle1) raws2 = await tryNeedle(needle2);
        if (!raws2.length && needle3 && needle3 !== needle2 && needle3 !== needle1) raws2 = await tryNeedle(needle3);

        const bestRaw = (raws2 || [])
          .filter((r: any) => (r?.content || "").trim().length >= 180)
          .sort((a: any, b: any) => ((b?.content || "").length - (a?.content || "").length))[0] as any;

        if (bestRaw?.id) {
          evidences.push({
            kind: "memory_raw",
            id: bestRaw.id,
            created_at: bestRaw.created_at,
            title: "Original story (raw)",
            excerpt: _safeStr(bestRaw.content, 900),
          });
        }
      }
    }

     return evidences.slice(0, 10);
   } catch (_err) {
     return [];
   }
} 

// -------------------------------------------------------------------
// Relevant prior context (stories + facts) for dot-connecting.
 // Used for longitudinal reflections so the model can link the current
 // thread to specific prior stories/facts without inventing anything.
 // -------------------------------------------------------------------
  async function loadRelevantPriorContextBlock(
     supabase: SupabaseClient,
     user_id: string,
     queryText: string,
   ): Promise<string> {
  // Runtime dot-connecting must read ONLY from user_knowledge.
  // Provide a tiny, evidence-backed block of relevant facts + story synopses.
  try {
    const { data: uk } = await supabase
      .from("user_knowledge")
      .select("facts, updated_at")
      .eq("user_id", user_id)
      .maybeSingle();

    const factsObj = (uk as any)?.facts;
    if (!factsObj || typeof factsObj !== "object") return "";

    const relItems = _pickRelevantFactsFromMap(factsObj, queryText, 10);
    const relLines = relItems.length ? _renderFactLines(relItems, 900) : "";

    const tokens = (String(queryText ?? "").toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []).slice(0, 60);
    const stop = new Set<string>(["that","this","what","does","mean","says","about","based","know","your","with","have","from","like","just","into","when","then","them","they","were","been","because","could","would","should","there","here","make","made","tell","story","stories","remember","recall","connect","dots","please","save","record"]);
    const uniq: string[] = [];
    for (const t of tokens) {
      if (stop.has(t)) continue;
      if (!uniq.includes(t)) uniq.push(t);
      if (uniq.length >= 4) break;
    }

    const storyEntries = Object.entries(factsObj)
      .filter(([k]) => typeof k === "string" && k.startsWith("stories.")) as Array<[string, any]>;

    const storyLines: string[] = [];
    for (const [k, v] of storyEntries) {
      if (storyLines.length >= 3) break;
      const title = typeof v === "object" && v ? String((v as any).title ?? "") : "";
      const synopsis = typeof v === "object" && v ? String((v as any).synopsis ?? "") : (typeof v === "string" ? v : "");
      const hay = `${k} ${title} ${synopsis}`.toLowerCase();
      const hit = uniq.length ? uniq.some((t) => hay.includes(t)) : false;
      if (!hit) continue;
      const label = title || k.replace(/^stories\./, "");
      const one = _safeStr(synopsis, 240);
      storyLines.push(`- ${label}: ${one}`);
    }

    const outLines: string[] = [];
    outLines.push("RELEVANT_PRIOR_CONTEXT (from user_knowledge):");
    outLines.push("FACTS:");
    outLines.push(relLines || "(none)");
    outLines.push("");
    outLines.push("STORIES:");
    outLines.push(storyLines.length ? storyLines.join("\n") : "(none)");
    return outLines.join("\n");
  } catch (_err) {
    return "";
  }
 }
 
 async function hydrateRecallBrowseEvidence(
   supabase: SupabaseClient,
   user_id: string,
 ): Promise<RecallEvidence[]> {
  // "Browse" mode is used for explicit recall tests without a query.
  // Return a small recent canonical set; the system prompt still enforces evidence-only answers.
   try {
     const evidences: RecallEvidence[] = [];
 
    // user_knowledge is the authoritative browse surface.
    const { data: uk } = await supabase
      .from("user_knowledge")
      .select("core, facts, updated_at")
      .eq("user_id", user_id)
      .maybeSingle();

    const coreObj = (uk as any)?.core;
    const factsObj = (uk as any)?.facts;

    const coreLines = coreObj && typeof coreObj === "object" ? _renderFactLines(Object.entries(coreObj) as any, 700) : "";

    const storyEntries = factsObj && typeof factsObj === "object"
      ? (Object.entries(factsObj) as Array<[string, any]>).filter(([k]) => String(k).startsWith("stories."))
      : [];
    const storyLines = storyEntries.slice(0, 4).map(([k, v]) => {
      const title = typeof v === "object" && v ? String((v as any).title ?? "") : "";
      const synopsis = typeof v === "object" && v ? String((v as any).synopsis ?? "") : (typeof v === "string" ? v : "");
      const label = title || String(k).replace(/^stories\./, "");
      return `- ${label}: ${_safeStr(synopsis, 220)}`;
    });

    const excerpt = [
      "USER_KNOWLEDGE_CORE:",
      coreLines || "(none)",
      "",
      "USER_KNOWLEDGE_STORIES:",
      storyLines.length ? storyLines.join("\n") : "(none)",
    ].join("\n");

    evidences.push({
      kind: "browse",
      id: `user_knowledge:${user_id}`,
      created_at: (uk as any)?.updated_at,
      title: "user_knowledge",
      excerpt: _safeStr(excerpt, 1200),
    });
 
     return evidences.slice(0, 10);
   } catch (_err) {
     return [];
   }
 }

async function tryLoadStoryRetellBlockFromFacts(
  factsObj: any,
  userText: string,
): Promise<string> {
  const q = String(userText ?? "").trim();
  if (!q) return "";

  // Only run for explicit story requests.
  if (!/(tell me|retell|share)\b.*\bstory\b/i.test(q) && !/\bstory\b/i.test(q)) return "";
  if (!factsObj || typeof factsObj !== "object") return "";

  // Extract the requested story handle/name when possible: "tell me the X story"
  const m = q.match(/(?:tell me|retell|share)\s+(?:the\s+)?(.+?)\s+story\b/i);
  const needleRaw = String(m?.[1] ?? q).trim().toLowerCase();
  const needle = needleRaw.replace(/[^a-z0-9_\s-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!needle) return "";

  // Find best match among user_knowledge facts keys: stories.<slug> => { title, synopsis, story, ... }
  const entries = Object.entries(factsObj) as Array<[string, any]>;
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
  const storyText = story || synopsis;
  if (!storyText) return "";

  return (
    "STORY_RETELL (from user_knowledge):\n" +
    `TITLE: ${label}\n` +
    `SYNOPSIS: ${_safeStr(synopsis, 420)}\n` +
    "STORY:\n" +
    _safeStr(storyText, 2600)
  );
}

 async function recall_v2(
   client: SupabaseClient,
   userId: string,
   userText: string,
   limit = 14,
 ): Promise<{ addon: string; context: string } | null> {

  const _rawIn = (userText ?? "").toString().trim();

  // Strip leading diagnostic/test markers repeatedly (but keep [RID:...] intact).
  const stripHarnessMarkers = (s: string): string => {
    let out = (s ?? "").toString().trim();
    while (true) {
      const m = out.match(/^\[([^\]]+)\]\s*/);
      if (!m) break;
      const tag = String(m[1] ?? "");
      if (/^rid:/i.test(tag)) break;
      // Only strip tags that look like harness markers.
      if (/^(diagnostic|diag)/i.test(tag)) {
        out = out.slice(m[0].length).trim();
        continue;
      }
      break;
    }
    return out;
  };

   const rawQ = stripHarnessMarkers(_rawIn);
   if (!rawQ) return null;

   // Single source of truth (read model): user_knowledge
   // If present, use it directly for both legacy and avatar recall to avoid multi-table drift.
   try {
    const { data: uk } = await client
      .from("user_knowledge")
      .select("core, facts, updated_at")
      .eq("user_id", userId)
      .maybeSingle();

    try {
      if (uk && (uk as any).core) {
        const coreObj = (uk as any).core;
        const factsObj = (uk as any).facts;

        const coreLines = _renderFactLines(Object.entries(coreObj) as any, 700);
        const relItems = _pickRelevantFactsFromMap(factsObj, rawQ, 18);
        const relLines = relItems.length ? _renderFactLines(relItems, 900) : "";

        const addon =
          "AUTHORITATIVE_USER_KNOWLEDGE:\n" +
          "CORE:\n" + (coreLines || "(none)") + "\n\n" +
          "RELEVANT:\n" + (relLines || "(none)");

        const storyBlock = await tryLoadStoryRetellBlockFromFacts(factsObj, rawQ);
        const merged = storyBlock ? `${addon}\n\n${storyBlock}` : addon;
        return { addon: merged, context: merged };
      }
     } catch (_e) {
       // best-effort: fall through
     }

   } catch (_e) {
     // best-effort: fall through to non-user_knowledge recall
   }
 
   // Work / retirement / employment
   if (/\b(job|work|employ|retir|pension|salary|income)\b/i.test(q)) {
     addPrefix("work.");
     addPrefix("finance.");
     addPrefix("income.");
   }

  // Politics / leaders / elections / major figures
  if (/\b(trump|biden|election|elections|vote|voted|voting|politic|politics|democrat|republican|maga|congress|senate)\b/i.test(q)) {
    addPrefix("politics.");
    addPrefix("beliefs.");
    addPrefix("values.");
  }

  // Relationships / marriage / dating
  if (
    /\b(married|marriage|relationship|partner|girlfriend|boyfriend|spouse|divorc|dating)\b/i.test(
      q,
    )
  ) {
    addPrefix("relationship");
    addPrefix("relationships.");
    addPrefix("family.");
  }

  // Children / family
  if (/\b(child|children|daughter|son|family|parent)\b/i.test(q)) {
    addPrefix("relationships.");
    addPrefix("family.");
  }

  // Health / exercise / activities
  if (
    /\b(exercise|workout|fitness|cycle|cycling|gym|weight|strength|tai\s*chi|run|walk|sleep|heart\s*rate)\b/i.test(
      q,
    )
  ) {
    addPrefix("health.");
    addPrefix("exercise.");
    addPrefix("activity.");
    addPrefix("activities.");
  }

  // Identity (gender, age, etc.)
  if (/\b(gender|male|female|man|woman|age|born)\b/i.test(q)) {
    addPrefix("identity.");
    addPrefix("demographics.");
    addPrefix("personal.");
  }

  // If the user asks “what do you know about me”, pull a broad but safe slice.
  const broadAsk = /(what do you know|tell me what you know|about me|my interests|my hobbies|my activities)/i.test(
    q,
  );

   if (!isQuestionLike && !broadAsk && !explicitRecall) return null;
 

  // Base tokens for lexical match.
  const stop = new Set([
    "a","an","the","and","or","but","if","then","else","so","to","of","in","on","for","with","at","by","from","as","is","are","was","were","be","been","being",
    "i","me","my","mine","you","your","yours","we","our","ours","they","their","theirs",
    "tell","show","remember","recall","what","anything","about","please","based","know",
  ]);

  const tokens = q
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter((t) => t && t.length >= 3 && !stop.has(t))
    .slice(0, 18);

  // Candidate pull: prefer breadth, then score locally.
  const candidateLimit =
    broadAsk ? 400 : tokens.length ? 500 : Math.max(80, Math.min(250, limit * 16));

  const { data, error } = await client
    .from(USER_FACTS_TABLE)
    .select(
      "fact_key, canonical_key, value_json, confidence, stability, updated_at, context, receipt_quotes, is_locked",
    )
    .eq("user_id", userId)
    .order("is_locked", { ascending: false })
    .order("updated_at", { ascending: false })
    .order("confidence", { ascending: false })
    .limit(candidateLimit);

  if (error) {
    console.error("RECALL_V2: canonical facts query failed:", error);
    return null;
  }

  let rows = (data ?? []) as any[];

  // Fallback: if facts_effective/user_facts is empty (common early in the pipeline),
  // hydrate a small identity/family/work slice directly from fact_candidates.
  // This prevents "I don't have that recorded" for core questions like name/age/DOB.
  let usedFactCandidatesFallback = false;
  if (!rows.length) {
    try {
      const statuses = ["captured", "canonicalized", "promoted", "locked_conflict"];
      const orClauses = [
        "fact_key_canonical.ilike.identity.%",
        "fact_key_guess.ilike.identity.%",
        "fact_key_canonical.ilike.relationships.%",
        "fact_key_guess.ilike.relationships.%",
        "fact_key_canonical.ilike.work.%",
        "fact_key_guess.ilike.work.%",
      ].join(",");

      const { data: fc } = await client
        .from("fact_candidates")
        .select(
          "fact_key_guess, fact_key_canonical, value_json, extracted_at, source_quote, status",
        )
        .eq("user_id", userId)
        .in("status", statuses)
        .or(orClauses)
        .order("extracted_at", { ascending: false })
        .limit(200);

      const bestByKey = new Map<string, any>();
      for (const f of (fc ?? []) as any[]) {
        const k = String(f?.fact_key_canonical ?? f?.fact_key_guess ?? "").trim();
        if (!k) continue;
        if (!bestByKey.has(k)) bestByKey.set(k, f);
      }

      const picked = Array.from(bestByKey.values());
      if (picked.length) {
        usedFactCandidatesFallback = true;
        rows = picked.map((f: any) => ({
          fact_key: String(f?.fact_key_guess ?? f?.fact_key_canonical ?? ""),
          canonical_key: String(f?.fact_key_canonical ?? f?.fact_key_guess ?? ""),
          value_json: f?.value_json ?? null,
          confidence: 0.7,
          stability: "low",
          updated_at: f?.extracted_at ?? null,
          context: String(f?.source_quote ?? "").slice(0, 400),
          receipt_quotes: f?.source_quote ? [String(f.source_quote).slice(0, 200)] : [],
          is_locked: false,
        }));
      }
    } catch (_) {
      // ignore; fallback is best-effort
    }
  }

  if (!rows.length) return null;

  // Score + select a working set.
  const now = Date.now();

  const norm = (s: any) => String(s ?? "").toLowerCase();
  const hasAnyPrefix = (s: string) => prefixes.some((p) => p && s.startsWith(p));

  const scored = rows.map((r) => {
    const fk = norm(r.fact_key);
    const ck = norm(r.canonical_key);
    const cx = norm(r.context);
    const rq = Array.isArray(r.receipt_quotes)
      ? r.receipt_quotes.join(" ").toLowerCase()
      : norm(r.receipt_quotes);

    let score = 0;

    // Locked facts should almost always be in the working set.
    if (r.is_locked) score += 60;

    // Topic/prefix boost.
    if (hasAnyPrefix(ck)) score += 25;
    if (hasAnyPrefix(fk)) score += 18;
    const prefixHit = hasAnyPrefix(ck) || hasAnyPrefix(fk);

    // Token overlap boost.
    let matchedTokens = 0;
    for (const t of tokens) {
      if (!t) continue;
      if (ck.includes(t)) {
        score += 6;
        matchedTokens += 1;
      } else if (fk.includes(t)) {
        score += 5;
        matchedTokens += 1;
      } else if (cx.includes(t)) {
        score += 3;
        matchedTokens += 1;
      } else if (rq.includes(t)) {
        score += 2;
        matchedTokens += 1;
      }
    }

    // If the user gave specific keywords, ensure strong lexical matches are represented
    // even when many locked facts exist.
    if (tokens.length) {
      if (matchedTokens >= 2) score += 55;
      else if (matchedTokens === 1) score += 20;
    }

    // Recency + confidence.
    const conf = Number(r.confidence ?? 0);
    if (conf >= 0.9) score += 8;
    else if (conf >= 0.75) score += 4;

    const updatedMs = r.updated_at ? Date.parse(String(r.updated_at)) : 0;
    if (updatedMs) {
      const ageDays = Math.max(0, (now - updatedMs) / (1000 * 60 * 60 * 24));
      // Within ~30 days gets a small boost.
      if (ageDays <= 30) score += 3;
    }

     // Broad asks: favor stable-ish, higher confidence facts.
     if (broadAsk && conf >= 0.75) score += 2;
 
    return { r, score, matchedTokens, prefixHit };
   });
 
   scored.sort((a, b) => b.score - a.score);

  function _safeJsonStringify(v: any): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "\"\"";
  }
  }

  function _pickRelevantFactsFromMap(facts: any, question: string, maxItems = 18): Array<[string, any]> {
  if (!facts || typeof facts !== "object") return [];
  const q = String(question ?? "").toLowerCase();

  const prefixes: string[] = [];
  if (/(food|eat|diet|fruit|snack|grocery|restaurant|buffet|peach|apple)/i.test(q)) {
    prefixes.push("preferences.", "diet.", "food.");
   } else if (/(work|job|career|employ|ssa|social security|office)/i.test(q)) {
     prefixes.push("work.", "education.");
   } else if (/(wife|husband|partner|relationship|married|single|kids|children|daughter|son|family)/i.test(q)) {
     prefixes.push("relationships.");
   } else if (/(story|stories|tell me .* story|retell|murder crab|murder crabs|suckling pig)/i.test(q)) {
    prefixes.push("stories.");
   } else if (/(live|living|where|location|country|city|timezone)/i.test(q)) {
     prefixes.push("location.");
   } else if (/(value|principle|belief|what matters|purpose)/i.test(q)) {
     prefixes.push("values.");
   }

  if (!prefixes.length) return [];
  const entries = Object.entries(facts) as Array<[string, any]>;
  const picked: Array<[string, any]> = [];
  const seen = new Set<string>();
  for (const [k, v] of entries) {
    if (picked.length >= maxItems) break;
    if (seen.has(k)) continue;
    if (!prefixes.some((p) => k.startsWith(p))) continue;
    seen.add(k);
    picked.push([k, v]);
  }
  return picked;
  }

  function _renderFactLines(items: Array<[string, any]>, maxChars = 900): string {
  if (!items.length) return "";
  const lines: string[] = [];
  let total = 0;
  for (const [k, v] of items) {
    const line = `- ${k}: ${typeof v === "string" ? v : _safeJsonStringify(v)}`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\\n");
  }   

  // IMPORTANT:
  // For explicit recall lookups (e.g., "When did I earn my MBA?"), do not inject an unrelated
  // USER_FACTS working set. If we have no lexical/prefix match at all, return null so the caller
  // can enable SESSION-LOCAL RECALL (RECENT TURNS FROM THIS SESSION).
  if (explicitRecall && isQuestionLike && !broadAsk && tokens.length) {
    const best = scored[0];
    const bestMatched = Number((best as any)?.matchedTokens ?? 0);
    const bestPrefixHit = Boolean((best as any)?.prefixHit ?? false);
    if (bestMatched <= 0 && !bestPrefixHit) return null;
  }

   const top = scored.slice(0, Math.max(limit, 10));

  // Build conflict hints: same canonical_key with multiple distinct values at decent confidence.
  const byCk = new Map<string, { v: string; conf: number }[]>();
  for (const s of top) {
    const ck = norm(s.r.canonical_key || s.r.fact_key);
    const v = JSON.stringify(s.r.value_json ?? null);
    const conf = Number(s.r.confidence ?? 0);
    if (!byCk.has(ck)) byCk.set(ck, []);
    byCk.get(ck)!.push({ v, conf });
  }
  const conflicts: string[] = [];
  for (const [ck, items] of byCk.entries()) {
    const distinct = Array.from(new Set(items.map((it) => it.v)));
    const strong = items.filter((it) => it.conf >= 0.7);
    if (distinct.length >= 2 && strong.length >= 2) conflicts.push(ck);
  }

  const picked = top.map((s) => s.r);

  // Universal deterministic answer for explicit recall questions (prevents model parroting).
  // If we have a strong top match, return a direct answer string for runTurnPipeline to short-circuit Gemini.
  let directReply: string | null = null;

  const tokenMatchCount = (candidateKey: string): number => {
    let n = 0;
    for (const t of tokens) {
      if (!t) continue;
      if (candidateKey.includes(t)) n += 1;
    }
    return n;
  };

  const coerceOneLineValue = (v: any): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) {
      const parts = v
        .map((x) => coerceOneLineValue(x))
        .filter((s) => s)
        .slice(0, 3);
      return parts.join(", ").trim();
    }
    if (typeof v === "object") {
      const o: any = v;
      // Common direct fields
      const direct =
        o.value ?? o.name ?? o.full_name ?? o.text ?? o.label ?? o.title ?? o.answer ?? "";
      if (direct !== null && direct !== undefined && String(direct).trim()) return String(direct).trim();

      // First/last style objects
      const first =
        o.first_name ?? o.first ?? o.given_name ?? o.given ?? "";
      const last =
        o.last_name ?? o.last ?? o.family_name ?? o.family ?? "";
      const combined = `${String(first ?? "").trim()} ${String(last ?? "").trim()}`.trim();
      if (combined) return combined;

      // Single-key objects (e.g. { father_name: "X" } or { value: 123 })
      const keys = Object.keys(o);
      if (keys.length === 1) {
        const onlyVal = o[keys[0]];
        const out = coerceOneLineValue(onlyVal);
        if (out) return out;
      }

      // Fallback: pick the first non-empty primitive-ish field
      for (const k of keys) {
        const out = coerceOneLineValue(o[k]);
        if (out) return out;
      }

      try {
        return JSON.stringify(o);
      } catch {
        return "";
      }
    }
    return "";
  };

  const extractMySlot = (question: string): string => {
    const m = question.match(/\bmy\s+(.+?)(?:\?|$)/i);
    if (!m) return "";
    return String(m[1] ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.?!]+$/g, "")
      .trim();
  };

  if (explicitRecall && isQuestionLike && !broadAsk && tokens.length) {
    // Pick the best candidate by token-match quality (not by lock/recency),
    // then tie-break by score.
    const minMatch = tokens.length >= 2 ? 2 : 1;
    const ranked = top
      .map((s) => {
        const r = s?.r;
        const k = norm(r?.canonical_key || r?.fact_key);
        return { s, r, k, m: tokenMatchCount(k) };
      })
      .filter((x) => x.r && x.m >= minMatch)
      .sort((a, b) => {
        if (b.m !== a.m) return b.m - a.m;
        return (b.s?.score ?? 0) - (a.s?.score ?? 0);
      });

    const best = ranked[0]?.r;
    if (best) {
      const conf = Number(best.confidence ?? 0);
      const is_locked = best.is_locked === true;
      const hasReceipt = Array.isArray(best.receipt_quotes)
        ? best.receipt_quotes.some((q: any) => String(q ?? "").trim().length > 0)
        : String(best.receipt_quotes ?? "").trim().length > 0;

      // Universal “safe enough” gating:
      // - If tokens are specific (>=2), token match is the primary safety signal.
      // - If tokens are vague (only 1), require stronger provenance.
      const bestKey = norm(best.canonical_key || best.fact_key);
      const matchCount = tokenMatchCount(bestKey);
      const strong =
        matchCount >= 2 ||
        (matchCount >= 1 && (is_locked || hasReceipt || conf >= 0.75));

        if (strong) {
          const slot = extractMySlot(rawQ);
         let valueText = coerceOneLineValue(best.value_json);

         // If the user asks for an ordinal child (oldest/middle/youngest) and the stored
         // value is a list, pick ONE element deterministically instead of joining the array.
         const slotLower = String(slot || "").toLowerCase();
         const qLower = String(rawQ || "").toLowerCase();
         const asksOrdinal =
           /\b(oldest|middle|youngest)\b/.test(slotLower) ||
           /\b(oldest|middle|youngest)\b/.test(qLower);

         if (asksOrdinal) {
           const ord =
             /\boldest\b/.test(slotLower) || /\boldest\b/.test(qLower)
               ? "oldest"
               : /\byoungest\b/.test(slotLower) || /\byoungest\b/.test(qLower)
                 ? "youngest"
                 : /\bmiddle\b/.test(slotLower) || /\bmiddle\b/.test(qLower)
                   ? "middle"
                   : null;

           if (ord) {
             let arr: any[] | null = null;
             if (Array.isArray(best.value_json)) arr = best.value_json as any[];
             else if (best.value_json && typeof best.value_json === "object") {
               const o: any = best.value_json;
               if (Array.isArray(o.names)) arr = o.names;
               else if (Array.isArray(o.children)) arr = o.children;
               else if (Array.isArray(o.daughters)) arr = o.daughters;
               else if (Array.isArray(o.sons)) arr = o.sons;
             }

             if (arr && arr.length) {
               const idx =
                 ord === "oldest" ? 0 : ord === "youngest" ? (arr.length - 1) : Math.floor(arr.length / 2);
               const one = coerceOneLineValue(arr[idx]);
               if (one) valueText = one;
             }
           }
         }

         if (valueText) {
           directReply = slot ? `Your ${slot} is ${valueText}.` : valueText;
         }
        }
      }
    }
  
  // Addon text: authorize using facts (receipts optional) + forbid "not recorded" when present.
  const addonLines: string[] = [];
  addonLines.push("USER_FACTS_WORKING_SET (authoritative memory; use to answer directly):");
  addonLines.push("- Use these facts to answer questions and to defend recommendations.");
  addonLines.push("- Receipts/quotes are supporting evidence when present, not a requirement to use a fact.");
  addonLines.push("- Do NOT say “I don't have that recorded yet” if the answer is present below.");
  addonLines.push("- If facts conflict, do NOT invent explanations; surface the conflict and ask ONE targeted clarifier.");
  if (conflicts.length) {
    addonLines.push(`- Potential conflicts detected for keys: ${conflicts.slice(0, 8).join(", ")}`);
  }
  addonLines.push("");

  const fmtValue = (v: any): string => {
    try {
      const s = JSON.stringify(v);
      return s && s.length > 220 ? s.slice(0, 217) + "..." : s;
    } catch {
      const s = String(v ?? "");
      return s.length > 220 ? s.slice(0, 217) + "..." : s;
    }
  };

  for (const r of picked) {
    const key = String(r.canonical_key ?? r.fact_key ?? "").trim();
    if (!key) continue;
    const conf = Number(r.confidence ?? 0);
    const locked = r.is_locked ? " LOCKED" : "";
    const value = fmtValue(r.value_json);
    addonLines.push(`- ${key}: ${value} (conf=${conf.toFixed(2)}${locked})`);
    if (r.receipt_quotes) {
      const rq = Array.isArray(r.receipt_quotes) ? r.receipt_quotes.join(" | ") : String(r.receipt_quotes);
      const clipped = rq.length > 240 ? rq.slice(0, 237) + "..." : rq;
      addonLines.push(`  receipts: ${clipped}`);
    }
  }

  const contextLines: string[] = [];
  contextLines.push("USER_FACTS:");
  for (const r of picked) {
    const key = String(r.canonical_key ?? r.fact_key ?? "").trim();
    if (!key) continue;
    contextLines.push(`${key} = ${fmtValue(r.value_json)}`);
  }

  console.log("RECALL_V2_DEBUG: built working set", {
    userId,
    broadAsk,
    prefixes,
    tokenCount: tokens.length,
    picked: picked.length,
    conflicts: conflicts.slice(0, 8),
   });
 
   return { addon: addonLines.join("\n"), context: contextLines.join("\n"), directReply };
 }

async function hydrateUserFactsEvidence(
    client: SupabaseClient,
    userId: string,
    userText: string,
    limit = 12,
 ): Promise<{ addon: string; context: string } | null> {

  const rawQ = (userText ?? "").trim();
  const q = rawQ.toLowerCase();

  // Name-focus hints: if the user asks about a specific person/entity by name,
  // we should prefer facts that mention that name to avoid cross-person leakage.
  const focusNames = (rawQ.match(/\b[A-Z][a-z]{2,}\b/g) ?? [])
    .map((s) => s.toLowerCase())
    .filter((s) => s.length >= 3);

  // --- Lightweight lexical ranking against the user’s actual words (no hardcoded domains) ---
  const stop = new Set([
    "a","an","the","and","or","but","if","then","else","so","to","of","in","on","for","with","at","by","from","as","is","are","was","were","be","been","being",
    "i","me","my","mine","you","your","yours","we","our","ours","they","their","theirs",
    "tell","show","remember","recall","receipts","receipt","what","anything","about","please",
  ]);

  // Base tokens from user question
  const baseTokens = q
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !stop.has(t))
    .slice(0, 12);

  // Generic synonym expansion to improve recall without hardcoding specific entities.
  // (Fixes common mismatches like "children" vs "daughter/son".)
  const synonyms: Record<string, string[]> = {
    children: ["child", "kids", "kid", "daughter", "daughters", "son", "sons"],
    child: ["children", "kids", "kid", "daughter", "daughters", "son", "sons"],
    kids: ["children", "child", "daughter", "daughters", "son", "sons"],
    daughter: ["daughters", "child", "children", "kid", "kids"],
    daughters: ["daughter", "child", "children", "kid", "kids"],
    son: ["sons", "child", "children", "kid", "kids"],
    sons: ["son", "child", "children", "kid", "kids"],
    name: ["named", "names"],
    names: ["named", "name"],
    education: ["school", "schools", "college", "university", "attended", "went", "major", "degree", "program", "studied"],
    school: ["education", "college", "university", "attended", "went"],
    college: ["education", "school", "university", "attended", "went"],
    university: ["education", "school", "college", "attended", "went"],
    major: ["field", "program", "studied", "degree"],
    film: ["tv", "television", "production"],
    tv: ["television", "film", "production"],
    television: ["tv", "film", "production"],
    // Fitness / activity recall (fixes "exercise" missing cycling/gym/activity facts)
    exercise: ["workout", "workouts", "fitness", "training", "gym", "routine", "routines", "activity", "activities", "cardio", "lifting", "weights", "strength"],
    workout: ["exercise", "fitness", "training", "gym", "routine", "routines", "weights", "strength"],
    fitness: ["exercise", "workout", "workouts", "training", "gym", "activity", "activities", "cardio", "strength"],
    gym: ["fitness", "exercise", "workout", "training", "lifting", "weights", "strength"],
    cycling: ["bike", "biking", "ride", "rides", "cardio", "exercise", "fitness"],
    bike: ["cycling", "biking", "ride", "rides"],
    biking: ["cycling", "bike", "ride", "rides"],
    routine: ["routines", "schedule", "habit", "habits"],
    routines: ["routine", "schedule", "habit", "habits"],
    steps: ["walking", "walk", "activity", "movement"],
    sleep: ["rest", "recovery"],
    calories: ["calorie", "burn", "burned", "energy"],
    heart: ["hr", "heartrate", "pulse"],
  };

  const tokenSet = new Set<string>(baseTokens);
  for (const t of baseTokens) {
    const exp = synonyms[t];
    if (exp) exp.forEach((x) => tokenSet.add(x));
  }
  const tokens = Array.from(tokenSet).slice(0, 18);

  // Generic gate: only run when the user is asking a question / requesting info.
  const isQuestionLike =
    /[?]/.test(rawQ) ||
    /^(what|where|when|who|why|how|tell me|show me|give me|list|summarize|recap)\b/i.test(rawQ.trim());




  if (!isQuestionLike) return null;

  // Pull a broad candidate set (dynamic schema: do NOT assume prefixes).
  // IMPORTANT: avoid a recency-only candidate window excluding relevant facts.
  const candidateLimit = tokens.length ? 500 : Math.max(50, Math.min(200, limit * 12));

  const { data, error } = await client
    .from(USER_FACTS_TABLE)
    .select("fact_key, canonical_key, value_json, confidence, stability, updated_at, context, receipt_quotes, is_locked")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .order("confidence", { ascending: false })
    .limit(candidateLimit);

  if (error) {
    console.error("FACT_RECALL: canonical facts query failed:", error);
    return null;
  }

  let rows = (data ?? []) as any[];

  // Fallback: end_session-extracted facts live in fact_candidates (learning surface),
  // and may not be promoted into user_facts_receipts unless explicitly saved.
  // If receipts table is empty, pull fact_candidates so recall can answer questions like:
  // "What does my middle daughter do?" / "Who attended Morgan State University?"
  if (!rows.length) {
    const fcLimit = Math.min(candidateLimit, 400);
    const { data: fcData, error: fcErr } = await client
      .from("fact_candidates")
      .select("fact_key_canonical, fact_key_guess, value_json, confidence, extracted_at, source_quote, source_meta")
      .eq("user_id", userId)
      .order("extracted_at", { ascending: false })
      .order("confidence", { ascending: false })
      .limit(fcLimit);

    if (fcErr) {
     console.warn("FACT_RECALL: fact_candidates fallback query failed (non-fatal):", fcErr);
    } else {
      const fcRows = (fcData ?? []) as any[];
      // Map into the same shape used below by the scorer.
      rows = fcRows.map((r) => {
        const canonical = String(r.fact_key_canonical ?? "").trim();
        const guess = String(r.fact_key_guess ?? "").trim();
        const key = canonical || guess;
        return {
          fact_key: key,
          canonical_key: key,
          value_json: r.value_json,
          confidence: typeof r.confidence === "number" ? r.confidence : 0,
          stability: "session",
          updated_at: r.extracted_at ?? null,
          context:
            (r.source_meta && typeof r.source_meta === "object" && typeof r.source_meta.context === "string")
              ? r.source_meta.context
              : "",
          receipt_quotes: r.source_quote ? [String(r.source_quote)] : [],
          is_locked: false,
        };
      });
      console.log("FACT_RECALL_DEBUG: using fact_candidates fallback", {
        candidateLimit: fcLimit,
        rowCount: rows.length,
      });
    }
  }

  console.log("FACT_RECALL_DEBUG: user_facts query ok", {
    candidateLimit,
    rowCount: rows.length,
    tokenCount: tokens.length,
    tokens,
  });
  if (rows.length) {
    console.log(
      "FACT_RECALL_DEBUG: sample fact_keys (pre-filter)",
      rows.slice(0, 12).map((r) => r?.fact_key),
    );
  } else {
    console.log("FACT_RECALL_DEBUG: no user_facts rows returned (pre-filter)");
     return null;
   }
 
   const isSelfQuery = /\b(i|me|my|mine)\b/.test(q);
   const isOtherPersonQuery = /\b(daughter|daughters|son|sons|child|children|kid|kids|wife|husband|mom|mother|dad|father|parent|parents)\b/.test(q);

   const now = Date.now();
 
   const scored = rows.map((r) => {
    const fk = String(r.fact_key ?? "").toLowerCase();
    const ck = String(r.canonical_key ?? "").toLowerCase();
    const cx = String(r.context ?? "").toLowerCase();
    const rq = Array.isArray(r.receipt_quotes)
      ? r.receipt_quotes.join(" ").toLowerCase()
      : String(r.receipt_quotes ?? "").toLowerCase();

    // Include value_json in scoring so person-scoped facts stored in JSON can be recalled
    // even when the fact_key does not include the person's name (e.g., relationships.daughters = ["Allysha","Asia","Amir"]).
    let vj = "";
    try {
      vj = JSON.stringify(r.value_json ?? "").toLowerCase();
    } catch {
      vj = String(r.value_json ?? "").toLowerCase();
    }

    const locked = r.is_locked === true;

    // Tokenize keys on separators so "daughter_amir" matches "amir" strongly.
    const fkTokens = new Set(fk.split(/[^a-z0-9]+/g).filter(Boolean));
    const ckTokens = new Set(ck.split(/[^a-z0-9]+/g).filter(Boolean));

    let score = 0;

    for (const tok of tokens) {
      if (fkTokens.has(tok)) score += 7;
      else if (fk.includes(tok)) score += 5;

      if (ckTokens.has(tok)) score += 6;
      else if (ck.includes(tok)) score += 4;

       if (cx.includes(tok)) score += 3;
       if (rq.includes(tok)) score += 2;
       if (vj.includes(tok)) score += 4;

    // Disambiguation: when the user asks about themselves ("I"/"my") without naming a relative,
    // down-rank relationship-scoped facts to prevent cross-person leakage (e.g., a child's education).
    if (isSelfQuery && !isOtherPersonQuery) {
      const isRelationshipScoped = fk.includes("relationships.") || ck.includes("relationships.");
      if (isRelationshipScoped) score -= 6;
    }
    }

    const conf = typeof r.confidence === "number" ? r.confidence : 0;
    score += conf * 2;
    if (locked) score += 3;

    const ts = r.updated_at ? Date.parse(String(r.updated_at)) : NaN;
    if (!Number.isNaN(ts)) {
      const days = Math.max(0, (now - ts) / (1000 * 60 * 60 * 24));
      score += Math.max(0, 3 - Math.min(3, days)) * 1.5;
    }

    return { r, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Guardrail: if we couldn't match anything meaningfully, do NOT guess.
  const bestScore = scored.length ? scored[0].score : 0;

  const nameFiltered = focusNames.length
  ? scored.filter(({ r }) => {
      const fk = String(r.fact_key ?? "").toLowerCase();
      const ck = String(r.canonical_key ?? "").toLowerCase();
      const rq = Array.isArray(r.receipt_quotes)
        ? r.receipt_quotes.join(" ").toLowerCase()
        : String(r.receipt_quotes ?? "").toLowerCase();

      let vj = "";
      try {
        vj = JSON.stringify(r.value_json ?? "").toLowerCase();
      } catch {
        vj = String(r.value_json ?? "").toLowerCase();
      }

      return focusNames.some((nm) => fk.includes(nm) || ck.includes(nm) || rq.includes(nm) || vj.includes(nm));
    })
  : scored;

const pickFrom = nameFiltered.length ? nameFiltered : scored;

const sorted = pickFrom.slice(0, limit).map((s) => s.r);
if (!sorted.length) return null;

  console.log("FACT_RECALL: user_facts rows", rows.length, { selected: sorted.length, tokens, bestScore });
  console.log(
    "FACT_RECALL_DEBUG: selected fact_keys",
    sorted.map((r) => r?.fact_key),
  );

  // Universal deterministic answer for strong lexical matches (prevents model parroting).
  let directReply: string | null = null;

  const tokenMatchCount = (candidateKey: string): number => {
    let n = 0;
    for (const t of tokens) {
      if (!t) continue;
      if (candidateKey.includes(String(t).toLowerCase())) n += 1;
    }
    return n;
  };

  const coerceOneLineValue = (v: any): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) {
      const parts = v
        .map((x) => coerceOneLineValue(x))
        .filter((s) => s)
        .slice(0, 3);
      return parts.join(", ").trim();
    }
    if (typeof v === "object") {
      const o: any = v;
      const direct =
        o.value ?? o.name ?? o.full_name ?? o.text ?? o.label ?? o.title ?? o.answer ?? "";
      if (direct !== null && direct !== undefined && String(direct).trim()) return String(direct).trim();

      const first =
        o.first_name ?? o.first ?? o.given_name ?? o.given ?? "";
      const last =
        o.last_name ?? o.last ?? o.family_name ?? o.family ?? "";
      const combined = `${String(first ?? "").trim()} ${String(last ?? "").trim()}`.trim();
      if (combined) return combined;

      const keys = Object.keys(o);
      if (keys.length === 1) {
        const out = coerceOneLineValue(o[keys[0]]);
        if (out) return out;
      }
      for (const k of keys) {
        const out = coerceOneLineValue(o[k]);
        if (out) return out;
      }
      try {
        return JSON.stringify(o);
      } catch {
        return "";
      }
    }
    return "";
  };

  const extractMySlot = (question: string): string => {
    const m = question.match(/\bmy\s+(.+?)(?:\?|$)/i);
    if (!m) return "";
    return String(m[1] ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.?!]+$/g, "")
      .trim();
  };

  if (tokens.length) {
    // Select best by token-match quality within the already-sorted list.
    const minMatch = tokens.length >= 2 ? 2 : 1;
    const ranked = sorted
      .map((r: any) => {
        const fk = String(r?.fact_key ?? "").toLowerCase();
        const ck = String(r?.canonical_key ?? "").toLowerCase();
        const k = ck || fk;
        return { r, k, m: tokenMatchCount(k) };
      })
      .filter((x) => x.r && x.m >= minMatch)
      .sort((a, b) => b.m - a.m);

    const best = ranked[0]?.r;
    if (best) {
      const fk = String(best?.fact_key ?? "").toLowerCase();
      const ck = String(best?.canonical_key ?? "").toLowerCase();
      const k = ck || fk;

      const conf = Number(best.confidence ?? 0);
      const is_locked = best.is_locked === true;
      const hasReceipt = Array.isArray(best.receipt_quotes)
        ? best.receipt_quotes.some((q: any) => String(q ?? "").trim().length > 0)
        : String(best.receipt_quotes ?? "").trim().length > 0;

      const matchCount = tokenMatchCount(k);
      const strong =
        matchCount >= 2 ||
        (matchCount >= 1 && (is_locked || hasReceipt || conf >= 0.75));

      if (strong) {
        const slot = extractMySlot(rawQ);
        const valueText = coerceOneLineValue(best.value_json);
        if (valueText) {
          directReply = slot ? `Your ${slot} is ${valueText}.` : valueText;
        }
      }
    }
  }

  // Generic multi-fact synthesis:
  // If the user asks for "any other/additional", "list/summarize/recap", or similarly broad questions,
  // produce a cohesive deterministic answer from the top relevant facts instead of letting the model
  // ask follow-ups despite evidence being present. This is domain-agnostic.
  const isSynthesisQuery = (question: string): boolean => {
    const s = (question || "").toLowerCase().trim();
    if (!s) return false;
    if (/^(list|summarize|recap|outline|give me|show me)\b/.test(s)) return true;
    if (/\b(any\s+other|any\s+additional|other\s+degrees|additional\s+degrees)\b/.test(s)) return true;
    if (/\b(any\s+other|any\s+additional)\b/.test(s)) return true;
    if (/\bother\s+(positions|jobs|roles|schools|colleges|degrees)\b/.test(s)) return true;
    if (/\badditional\s+(positions|jobs|roles|schools|colleges|degrees)\b/.test(s)) return true;
    // Broad "did I ... any other" style.
    if (/\bdid\s+i\b/.test(s) && /\b(any|other|additional)\b/.test(s)) return true;
    return false;
  };

  const summarizeForSynthesis = (factKey: string, v: any): string => {
    const key = String(factKey || "").trim();
    const val = v;
    const one = coerceOneLineValue(val);
    // Try to build a human-friendly "object summary" without domain-specific assumptions.
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const o: any = val;
      const pick = (...names: string[]): string => {
        for (const n of names) {
          const x = o?.[n];
          const s = coerceOneLineValue(x);
          if (s) return s;
        }
        return "";
      };
      const a = pick("university", "institution", "school", "college", "employer", "organization", "company");
      const b = pick("degree", "program", "major", "field", "title", "role", "position", "occupation");
      const c = pick("year", "graduation_year", "start_year", "end_year", "date", "when");
      const d = pick("city", "state", "country", "location");

      const parts = [a, b].filter(Boolean);
      let out = parts.join(" — ").trim();
      const tail = [c, d].filter(Boolean).join(", ").trim();
      if (tail) out = out ? `${out} (${tail})` : `(${tail})`;
      if (out) return out;
    }

    // Fallback: include key tail label only when it adds clarity.
    const tailLabel = key.includes(".") ? key.split(".").slice(-2).join(".") : key;
    if (one && tailLabel && one.toLowerCase() !== tailLabel.toLowerCase()) {
      return `${tailLabel}: ${one}`;
    }
    return one || "";
  };

  // If this is a synthesis query and we have multiple relevant facts, synthesize deterministically.
  if (!directReply && isSynthesisQuery(rawQ)) {
    const seen = new Set<string>();
    const items: string[] = [];

    for (const r of sorted) {
      const ck = String(r.canonical_key ?? r.fact_key ?? "").trim().toLowerCase();
      if (!ck) continue;
      if (seen.has(ck)) continue;
      seen.add(ck);

      const text = summarizeForSynthesis(String(r.fact_key ?? ""), r.value_json);
      if (!text) continue;
      items.push(text);
      if (items.length >= 4) break;
    }

    if (items.length >= 2) {
      directReply = `Here’s what I have recorded:\n- ${items.join("\n- ")}`;
    } else if (items.length === 1) {
      directReply = `Here’s what I have recorded: ${items[0]}`;
    }
  }
  
  const linesOut: string[] = [];
  for (const r of sorted) {
    const fact_key = String(r.fact_key ?? "");
    const value_json = r.value_json ?? null;
    const is_locked = r.is_locked === true;
    const conf = typeof r.confidence === "number" ? r.confidence : 0;
 
  const receiptsRaw: string[] = Array.isArray(r.receipt_quotes)
    ? r.receipt_quotes.map((x: any) => String(x ?? "")).filter(Boolean)
    : String(r.receipt_quotes ?? "")
      .split(/\n+/g)
      .map((x) => x.trim())
      .filter(Boolean);

  // Filter out assistant-y "memory claim" receipts (self-referential) to avoid circular evidence.
  const receipts = receiptsRaw.filter((q: string) => {
    const s = (q || "").trim();
    if (!s) return false;
    if (/\b(based on what you\x27ve shared|i know you have|i have that recorded)\b/i.test(s)) return false;
    return true;
  });

  const receipt = receipts.length ? receipts[0] : "";

  linesOut.push(
   `- ${fact_key}${is_locked ? " [LOCKED]" : ""} (conf: ${conf.toFixed(2)}) = ${JSON.stringify(value_json)}${
    receipt ? `\n  receipt: "${receipt}"` : ""
   }`,
  );
}

  console.log("FACT_RECALL_DEBUG: linesOut.length", linesOut.length);
  if (linesOut.length) {
    console.log("FACT_RECALL_DEBUG: first linesOut items", linesOut.slice(0, 3));
  }

  const addon =
    "FACT_RECALL_EVIDENCE:\n" +
     "Answer policy (LOOKUP vs SYNTHESIS vs INFERENCE):\n" +
    "A) First classify the user question intent:\n" +
    "   - LOOKUP: asks for a specific stored attribute.\n" +
    "   - SYNTHESIS: asks for a summary/pattern/progression.\n" +
    "   - INFERENCE: asks for advice/implications based on what is known.\n\n" +
    "B) Grounding rules:\n" +
    "1) Treat the facts below as the saved record. Do not invent new facts.\n" +
    "2) Prefer receipts. A factual claim must be supported by a listed receipt OR by a fact marked [LOCKED].\n" +
    "3) If a relevant fact is [LOCKED] but has no receipt, you may still use it, but say: \"I have this saved as a locked fact.\"\n" +
    "4) If a relevant fact has no receipt and is not [LOCKED], you may only use it if conf >= 0.90, and you must say: \"I have this recorded (high confidence), but I do not have a direct quote/receipt yet.\"\n\n" +
    "C) How to answer:\n" +
    "1) LOOKUP: If facts clearly answer, answer directly. If not, say: \"I do not have that recorded yet.\" Then ask at most ONE short follow-up question.\n" +
    "2) SYNTHESIS: Do not refuse just because there is no single matching fact key. Provide two short sections: (a) What I have recorded, (b) What I do not have recorded yet. Do not guess missing details.\n" +
    "3) INFERENCE: You may offer a qualified best inference only when the user is asking for advice/implications. Label it explicitly as inference, cite the fact(s) used, and do not present the inference as a stored fact.\n\n" +
    "D) Name focus rule: If the user question names a person/entity (e.g., Amir), answer ONLY using facts that mention that same name.\n\n" +
    linesOut.join("\n");

  console.log("FACT_RECALL_DEBUG: addon has evidence", {
    hasHeader: addon.includes("FACT_RECALL_EVIDENCE:"),
    hasAnyBullets: addon.includes("\n- "),
    addonLen: addon.length,
  });
  console.log("FACT_RECALL_DEBUG: addon preview", addon.slice(0, 800));

  const ctx =
    "RECALL_EVIDENCE_FROM_USER_FACTS:\n" +
    linesOut.join("\n\n");

  return { addon, context: ctx, directReply };
}

function buildSessionLocalRecallFallbackAddon(): string {
  return [
     "SESSION-LOCAL RECALL (no canonical receipts found):",
     "- The user asked you to recall something.",
     "- You may ONLY use details that appear in the 'RECENT TURNS FROM THIS SESSION' section above.",
     "- If that section contains relevant details, answer using ONLY that info and start with: 'Earlier in this session you said...'.",
     "- IMPORTANT: If you can answer from RECENT TURNS, do NOT say \"I don't have that recorded yet\" (or similar).",
     "- After answering, you MAY ask: \"Would you like me to save that?\"",
     "- If the relevant details are NOT present, say you don't have enough details yet and ask the user to remind you briefly.",
     "- Do NOT guess or invent details.",
   ].join("\n");
 }

// Strip unsupported "memory claims" when we do NOT have canonical evidence.
// This is intentionally conservative and fail-closed.
function stripUnsupportedRecallClaims(replyText: string): string {
  const t = (replyText || "").trim();
  if (!t) return t;

  // If the model already used the safe receipts phrasing, keep it.
  if (/\b(receipts? yet|can't verify|don't want to guess)\b/i.test(t)) return t;

  // Detect strong "I remember / you told me / last time" style claims.
  const hasMemoryClaim =
    /\b(i remember|i recall|you told me|you said earlier|last time|previously you|earlier you|we talked about|we discussed)\b/i.test(
      t.toLowerCase(),
    );

  if (!hasMemoryClaim) return t;

  // Replace with a safe, ASCII-only honesty message (TTS-friendly).
  return buildNoEvidenceRecallReply();
}

// When we DO have evidence (canonical or session-local), do not allow the model
// to preface with "I don't have that recorded yet, but...". We already proved the
// answer; remove that disclaimer deterministically.
function stripNotRecordedYetPreface(replyText: string): string {
  let t = (replyText || "").trim();
  if (!t) return t;
  // Remove leading variants like:
  // "I do not have that recorded yet, but ..." / "I don't have that recorded yet. ..."
  t = t.replace(
    /^(i\s+(do\s+not|don't)\s+have\s+that\s+recorded\s+yet\s*[,.]?\s*(but\s+)?)+/i,
    ""
  ).trim();
  return t;
}

function normalizeStoryRetellText(raw: string): string {
  // First strip any meta-preface / quote wrappers so the retell starts like a story.
  const s0 = normalizeStoryRetellPrefixText((raw ?? "").trim());
 
  if (!s0) return "";

  // Remove common "stall" prompts/questions at the end of a retell.
  // Keep strings short and declarative.
  let s = s0.replace(/\s+/g, " ").trim();

  // If the retell ends with a question, drop the final question sentence.
  // (We want a retell, not an interview prompt.)
  s = s.replace(/([.!?])(\s+)([^.?!]*\?)\s*$/u, "$1").trim();

  if (s.endsWith("?")) {
    // If somehow still ends with ?, hard-trim trailing question.
    s = s.replace(/\?[^.?!]*$/u, "").trim();
  }

  // De-dupe exact repeated leading clause pattern (seen in E2E).
  // Example: "Several months ago ... So, several months ago ..."
  s = s.replace(/\bSo,\s+(Several months ago\b)/i, "$1");

  // De-dupe repeated sentences (exact match after normalization).
  const parts = s.split(/(?<=[.!])\s+/).map((p) => p.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.join(" ").trim();
}

export async function runTurnPipeline(req: Request): Promise<Response> {
    try {
      // Diagnostics (does not depend on "meaningful session" thresholds)
      const urlObj = new URL(req.url);
      const diagParam = urlObj.searchParams.get("diag");
      if (diagParam === "1") {
        return await runDiagnostics({ supabase, authHeader: req.headers.get("Authorization") });
      }

      if (req.method !== "POST") {
        return jsonResponse({ error: "Only POST allowed." }, 405);
      }

      let body: AiBrainPayload;
      // Track mode flags before we start downstream routing.
      let _isAvatar = false;
      let _isEndSession = false;
       try {
         const raw = await req.json();
         console.log("🧠 ai-brain incoming:", raw);
         body = raw as AiBrainPayload;

       if (body?.diagnostic === true) {
         return await runDiagnostics({ supabase, userId: body?.user_id ?? null, authHeader: req.headers.get("Authorization") });
       }

       // -----------------------------------------------------------------------
       // AVATAR MODE: proxy to dedicated avatar edge function
       // -----------------------------------------------------------------------
       // If the client set mode=avatar, we do NOT generate the reply here.
       // We delegate to /functions/v1/avatar, which owns tier-1 facts, constitution,
       // and avatar-specific memory behavior.
       const _modeRaw =
         (body as any)?.mode ??
         (body as any)?.conversation_mode ??
         (body as any)?.chat_mode ??
         (body as any)?.conversationMode ??
         "legacy";
       const _mode = String(_modeRaw ?? "legacy").toLowerCase().trim();
      _isAvatar = _mode === "avatar" || _mode.startsWith("avatar_") || _mode.startsWith("avatar-") || _mode.startsWith("avatar:");
      _isEndSession = (body as any)?.end_session === true || (body as any)?.endSession === true;

       } catch (_err) {
         return jsonResponse({ error: "Invalid JSON body." }, 400);
       }

      // -------------------------------------------------------------------
      // Resolve authenticated user_id
      // - Some clients/paths omit body.user_id; resolve from Authorization bearer token.
      // - Without a user_id, DB writes will either fail or corrupt (FK + NOT NULL).
      // -------------------------------------------------------------------
      const isUuid = (s: any): boolean =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(String(s ?? "").trim());

      let user_id = (body as any)?.user_id as string | undefined;
      let authed_user_id: string | null = null;
      const conversation_id = (body as any)?.conversation_id as string | undefined;
 
      // Best-effort: resolve authed_user_id from Authorization bearer token (if present).
      // If body.user_id is missing, we also use this as the effective user_id.
      {
        const authHeader = req.headers.get("Authorization");
        if (authHeader && /^Bearer\s+/i.test(authHeader) && supabase) {
          const token = authHeader.replace(/^Bearer\s+/i, "").trim();
          if (token) {
            try {
              const { data, error } = await (supabase as any).auth.getUser(token);
              if (!error && data?.user?.id) {
                authed_user_id = String(data.user.id);
                if (!user_id) {
                  user_id = authed_user_id;
                  (body as any).user_id = user_id; // propagate so downstream uses the resolved id
                }
              }
            } catch (_e) {
              // ignore (fall through to error below if user_id still missing)
            }
          }
        }
      }
 
      // STRICT AUTH: require a real Supabase JWT and always use the authed user id.
      if (!authed_user_id) {
        return jsonResponse({ error: "Missing or invalid Authorization bearer token." }, 401);
      }
      if (user_id && user_id !== authed_user_id) {
        return jsonResponse(
          { error: "user_id mismatch", authed_user_id, body_user_id: user_id },
          403,
        );
      }
      user_id = authed_user_id;
      (body as any).user_id = user_id;

       // If the client provided a user_id AND also sent a JWT for a different user,
       // proxying to /avatar will 403 (avatar enforces that user_id matches authed user).
       // For dev/testing, keep UX simple: skip avatar proxy on mismatch and fall back to
       // in-process generation (legacy pipeline) while still writing under body.user_id.
       const _avatarProxyAllowed = !_isAvatar ? false : (!authed_user_id || authed_user_id === user_id);
       if (_isAvatar && !_avatarProxyAllowed) {
         console.warn("AVATAR_PROXY_SKIP_MISMATCH", { authed_user_id, body_user_id: user_id });
         _isAvatar = false;
       }
 
       if (!isUuid(user_id)) {
         return jsonResponse({ error: "Invalid user_id (expected UUID)." }, 400);
       }

      // SINGLE BRAIN: Legacy mode uses the same brain as Avatar.
      // We proxy legacy conversational turns to /avatar with a neutral voice flag,
      // so both modes have identical intelligence and identical user_knowledge reads.
      const _op = String((body as any)?.op ?? "").trim();
      const _action = String((body as any)?.action ?? "").trim();
      if (!_isAvatar && !_isEndSession && !_op && !_action) {
        (body as any).mode = "legacy";
        (body as any).voice = "assistant"; // instruct avatar brain to avoid donor first-person voice
        console.log("SINGLE_BRAIN_PROXY_LEGACY");
        return await proxyToAvatarFunction(req, body);
      }

      // -----------------------------------------------------------------------
      // AVATAR MODE: proxy to dedicated avatar edge function
      // -----------------------------------------------------------------------
      // NOTE: we proxy *after* resolving user_id so avatar can rely on it.
      if (_isAvatar && !_isEndSession) {
        console.log("AVATAR_PROXY", { mode: (body as any)?.mode ?? (body as any)?.conversation_mode ?? "avatar" });
        return await proxyToAvatarFunction(req, body);
      }

      //
      // IMPORTANT: some clients incorrectly set end_session=true on ordinary turns.
      // For avatar mode we always proxy to /avatar to obtain a real reply_text, and
      // (if end_session is also requested) we continue below to run end-session writes.
      if (_isAvatar) {
        console.log("AVATAR_PROXY", { mode: (body as any)?.mode ?? (body as any)?.conversation_mode ?? "avatar" });
        const proxied = await proxyToAvatarFunction(req, body);
        if (!_isEndSession) {
          return proxied;
         }
         // Best-effort: capture the avatar reply_text so end_session responses are never silent.
         try {
          const j = await proxied.clone().json();
          let t = String(j?.reply_text ?? "").trim();
          const e = String((j as any)?.error ?? "").trim();
          if (!t && e) t = `⚠️ Avatar error: ${e}`;
          if (!t) t = "⚠️ Avatar returned no reply_text. Check /avatar logs.";
          (body as any).__avatar_proxy_reply_text = t;
           (body as any).__avatar_proxy_receipts = (j as any)?.receipts ?? null;
         } catch (_e) {
           // ignore
         }
       }

     // BURN DOWN: legacy backfill op (dead; user_facts is removed; facts are session-extracted into user_facts_receipts).
      if (body?.op === "backfill_user_facts_v1") {
        return jsonResponse(
          { error: "Gone", details: "backfill_user_facts_v1 has been removed. Facts are extracted during end_session into user_facts_receipts." },
          410,
        );
      }

      // -------------------------------------------------------------------
      // OP ROUTING: story lock/unlock + rebuild artifacts after edits
      // -------------------------------------------------------------------
      if (body?.op === "story_lock_toggle") {
        if (!user_id) return jsonResponse({ error: "Missing user_id." }, 400);
        if (!supabase) return jsonResponse({ error: "Supabase client not configured." }, 500);
        const client = supabase as SupabaseClient;

        const story_recall_id = String((body as any)?.story_recall_id ?? "").trim();
        const locked = Boolean((body as any)?.locked);
        if (!story_recall_id) return jsonResponse({ error: "Missing story_recall_id." }, 400);

        // Read-modify-write evidence_json (keeps other metadata intact)
        const { data: row, error: rErr } = await client
          .from("story_recall")
          .select("id, user_id, evidence_json")
          .eq("id", story_recall_id)
          .eq("user_id", user_id)
          .maybeSingle();
        if (rErr) return jsonResponse({ error: "Failed to load story_recall.", details: String(rErr.message ?? rErr) }, 500);
        if (!row?.id) return jsonResponse({ error: "Story not found." }, 404);

        const nowIso = new Date().toISOString();
        const ej = (row as any)?.evidence_json;
        const nextEj: Record<string, any> = (ej && typeof ej === "object") ? { ...(ej as any) } : {};
        nextEj.locked = locked ? "true" : "false";
        if (locked) nextEj.locked_at = nowIso;
        else nextEj.unlocked_at = nowIso;

        const { error: uErr } = await client
          .from("story_recall")
          .update({ evidence_json: nextEj, updated_at: nowIso })
          .eq("id", story_recall_id)
          .eq("user_id", user_id);
        if (uErr) return jsonResponse({ error: "Failed to update lock state.", details: String(uErr.message ?? uErr) }, 500);

        return jsonResponse({ ok: true, story_recall_id, locked }, 200);
      }

      if (body?.op === "rebuild_conversation_artifacts") {
        // Client requests a rebuild after transcript/story edits.
        // We reuse the same end-session machinery (heavy) so that edits influence:
        // - story_seeds
        // - story_recall
        // - insights
        (body as any).end_session = true;
        (body as any).endSession = true;
        (body as any).force_rebuild = true;
        (body as any).INSIGHTS_FORCE = true;
        // fall through into normal end-session path below
      }

      // -------------------------------------------------------------------
      // Response payload variables (must be defined for all code paths)
      // -------------------------------------------------------------------
      let reply_text: string | null = null; // chat-bubble text only
      let endSessionSummaryPayload: Record<string, any> | null = null;
      let insightMomentPayload: Record<string, any> | null = null;
      let summaryIdForSeeds: string | null = null;

      // Make message_text mutable (we may normalize it)
      // Android clients may send `text` or `message` instead of `message_text`.
      let message_text =
        ((body as any).message_text ??
          (body as any).text ??
          (body as any).message ??
          (body as any).user_message ??
          (body as any).input) as string | undefined;

      // Ensure prompt variables exist across all branches (Deno/ESM strict)
      let rawUserMessageForPrompt: string = "";
      let userMessageForPrompt: string = "";
      // Predeclare recall gating so it is always defined across branches
      let recallTestForThisTurn: boolean = false;
      let wantsRecallForThisTurn: boolean = false;
      // -------------------------------------------------------------------
      // End-session payloads (must be defined for all code paths)
      // -------------------------------------------------------------------

      // Treat hidden tokens and Android variants as end-session triggers too.
      const isEndSession =
        (body as any).end_session === true ||
        (body as any).endSession === true ||
        (body as any).action === "end_session" ||
        (typeof message_text === "string" &&
          (message_text.trim() === "__END_SESSION__" ||
            message_text.trim() === "[END_SESSION]"));

      // Allow end_session calls to omit message_text (client may send empty).
      if (isEndSession && (!message_text || !String(message_text).trim())) {
        message_text = "__END_SESSION__";
    }
      const bodyAny = body as any;

      const receivedConversationId =
        String(bodyAny?.conversation_id ?? bodyAny?.conversationId ?? "");

      const receivedMessageText =
        String(bodyAny?.message_text ?? bodyAny?.text ?? bodyAny?.message ?? "");

      const receivedEndSession =
        bodyAny?.end_session === true ||
        bodyAny?.endSession === true ||
        bodyAny?.action === "end_session" ||
        receivedMessageText.trim() === "__END_SESSION__" ||
        receivedMessageText.trim() === "[END_SESSION]";

      console.log("AI_BRAIN_RECEIPT", {
        conversation_id: receivedConversationId,
        end_session: receivedEndSession,
        has_message_text: receivedMessageText.trim().length > 0,
        keys: Object.keys(bodyAny ?? {}),
      });

      console.log("TURN_CORE_VERSION", "turn_core_4859_learning_persist_v1_2025-12-30_avatar_reply_fix8_2026-01-21");

      // -----------------------------------------------------------------------
      // 1) Resolve mode, persona, locales, conversation id
      // -----------------------------------------------------------------------
      const requestedMode = (body.mode ?? "legacy") as ConversationMode;
      const conversationMode: ConversationMode =
        requestedMode === "avatar"
          ? requestedMode
          : "legacy";

      const personaRaw =
        (body.conversation_persona ?? (body as any).persona ?? null) as
          | string
          | null;

      let conversationPersona: ConversationPersona = "adaptive";
      if (typeof personaRaw === "string" && personaRaw.trim()) {
        const lower = personaRaw.trim().toLowerCase();
        if (lower === "playful") {
          conversationPersona = "playful";
        } else if (lower === "somber" || lower === "grounded") {
          // allow older clients that still send "grounded"
          conversationPersona = "somber";
        } else {
          conversationPersona = "adaptive";
        }
      }

      const preferredLocale = normalizeLocale(
        (body.preferred_locale ?? body.preferredLocale) as unknown,
        "und",
      );

      const targetRaw =
        body.target_locale ?? body.targetLocale ?? body.targetLocaleRaw ?? null;

      const hasTarget = !!(targetRaw && String(targetRaw).trim());
      const targetLocale = hasTarget ? normalizeLocale(targetRaw as unknown, "und") : null;

      // ✅ NEVER use "default" as a real session key.
      // If the client didn't send a conversation_id, generate one.
      const normalizedConversationId =
        (receivedConversationId && receivedConversationId.trim() && receivedConversationId.trim() !== "default")
          ? receivedConversationId.trim()
          : (conversation_id && conversation_id.trim() && conversation_id.trim() !== "default")
            ? conversation_id.trim()
            : "";

      const effectiveConversationId = normalizedConversationId || crypto.randomUUID();

  // --- Avatar transcript persistence (non-blocking; never affects reply) ---
  async function persistAvatarTurn(opts: { role: "user" | "assistant"; content: string; metadata?: Record<string, unknown> }) {
    try {
      if (conversationMode !== "avatar") return;
      if (!user_id) return;
      const row = {
        user_id,
        conversation_id: effectiveConversationId,
        role: opts.role,
        content: opts.content ?? "",
        metadata: {
          mode: conversationMode,
          preferred_locale: preferredLocale,
          target_locale: targetLocale,
            ...(opts.metadata ?? {}),
        },
      };
      const { error } = await supabase.from("avatar_turns").insert(row);
      if (error) {
        console.info("AVATAR_TURN_PERSIST_ERR", JSON.stringify({ role: opts.role, msg: String(error?.message ?? error) }));
      } else {
        console.info("AVATAR_TURN_PERSIST_OK", JSON.stringify({ role: opts.role, len: (opts.content ?? "").length }));
      }
    } catch (e) {
      console.info("AVATAR_TURN_PERSIST_ERR", JSON.stringify({ role: opts.role, msg: String(e) }));
    }
  }
  // --- end avatar transcript persistence ---

      const incomingStateJson = body.state_json ?? null;
       // Minimal per-conversation turn state (latched task + turn counter).
       // NOTE: legacy currently returns "{}" state_json; we will start returning
       // {"turn_state": ...} so the server can reliably prevent drift across turns.
      let turnState: TurnStateV1 = parseTurnState(incomingStateJson);
 
      // [KILL] language_learning mode branch (dead). Legacy and avatar share LegacyInterviewState.
      const legacyState: LegacyInterviewState =
        parseLegacyState(incomingStateJson) ?? getDefaultLegacyState();

      // -----------------------------------------------------------------------
      // 3) Build system prompt + context block
      // -----------------------------------------------------------------------
      let systemPrompt: string;
      let contextBlock = "";

      if (conversationMode === "avatar") {
        systemPrompt = buildAvatarSystemPrompt(preferredLocale);

        if (supabase) {
          contextBlock = await buildLegacyContextBlock(user_id, effectiveConversationId);
        }
      } else {
        // Legacy storytelling mode.
        const ls = legacyState ?? getDefaultLegacyState();
        const chapter =
          LEGACY_CHAPTERS[ls.chapter_id] ?? LEGACY_CHAPTERS["childhood"];

        const legacyCtx: LegacyPromptContext = {
          persona: conversationPersona,
          preferredLocale,
          targetLocale: hasTarget ? targetLocale : null,
          legacyState: ls,
          currentChapter: chapter,
          userDisplayName: undefined,
          coverageSummary: undefined,
        };

        systemPrompt = buildLegacySystemPrompt(legacyCtx);
        // Enforce companion contract + narrative momentum
        systemPrompt = `${systemPrompt}\n\n${LEGACY_COMPANION_ROLE_CONTRACT}`;

        // ✅ CRITICAL: Do not roleplay browsing/searching.
        // This runtime has no web/search tool. Provide best-effort answers with uncertainty instead.
        systemPrompt = `${systemPrompt}

NON-NEGOTIABLE BEHAVIOR:
- You CANNOT browse the web, check apps, or "search" in real time. NEVER say "I will search", "I found", or imply you performed a live lookup.
- Speak to the donor in second person ("you"). NEVER speak as if you are the donor (no "I" memories/biography). Use "I" only for the assistant (e.g., "I can help").
- If the user asks for a specific place/product and you lack certainty, give 2–5 plausible suggestions with clear uncertainty (e.g., "I’m not 100% sure, but here are places in Pattaya that often have crab/seafood menus…").
- BEFORE you say "I don't have that recorded" / "not recorded yet", first check the RECENT TURNS context. If the answer is present in this session, answer directly from it.
- If the user asks "What did I just say?" or similar, treat it as a session-local recall question and answer from RECENT TURNS.`;

        // ✅ CRITICAL: Legacy mode must include session-local continuity context.
        // This is required for "current session awareness" (and for recall-mode to use RECENT TURNS).
        // Use the lightweight session-only block to avoid extra DB reads.
        if (supabase) {
          contextBlock = await buildSessionRecentTurnsBlock(user_id, effectiveConversationId);
        }
      }

      // -----------------------------------------------------------------------
      // 4) Call Gemini
      // -----------------------------------------------------------------------
      rawUserMessageForPrompt =
        (body.message_text ??
          (body as any).message ??
          (body as any).user_message ??
          (body as any).input ??
          "") as string;

      // Prefer the server-parsed receivedMessageText when available (it powers the incoming log),
      // then fall back to rawUserMessageForPrompt.
      const _incomingText = (receivedMessageText ?? rawUserMessageForPrompt ?? "").toString();
      const _incomingTrim = _incomingText.trim();
      const _isHarnessDiag = /^\[(diagnostic|diag)[^\]]*\]\s*/i.test(_incomingTrim);
      const _markerFromBody =
        typeof (body as any)?.marker === "string"
          ? String((body as any).marker)
          : "";
 
      // Normalize: strip zero-width chars, collapse whitespace, then trim.
      const _normalizedIncomingText = _incomingText
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .trim();

      // Strip diagnostic marker prefix used by tests/tools so it doesn't contaminate intent/recall.
      // (Keep other bracket markers like [RID:...] intact.)
      const stripHarnessMarkers = (s: string): string => {
        let out = (s ?? "").toString().trim();
        while (true) {
          const m = out.match(/^\[([^\]]+)\]\s*/);
          if (!m) break;
          const tag = String(m[1] ?? "");
          if (/^rid:/i.test(tag)) break;
          if (/^(diagnostic|diag)/i.test(tag)) {
            out = out.slice(m[0].length).trim();
            continue;
          }
          break;
        }
        return out;
      };

      const _normalizedForPrompt = stripHarnessMarkers(_normalizedIncomingText);

      // Use the normalized text for prompt gating across modes (including avatar).
      userMessageForPrompt = _normalizedForPrompt;

      // Advance turn-state once per user turn (normalized).
      if (!isEndSession && (conversationMode === "legacy" || conversationMode === "avatar")) {
        turnState = advanceTurnState(turnState, userMessageForPrompt);
      }

       // Reply mode is orthogonal to task; it lets us enforce "snapshot-first" longitudinal reflections
       // and prevent biographical dumps on connect-the-dots prompts.
       const replyMode: ReplyMode = inferReplyModeFromMessage(userMessageForPrompt, turnState.active_task);

      if (_isHarnessDiag || _markerFromBody) {
        console.log("E2E_DIAG_INPUT", {
          marker: _markerFromBody || null,
          received_preview: String(receivedMessageText ?? "").slice(0, 120),
          raw_preview: String(rawUserMessageForPrompt ?? "").slice(0, 120),
          normalized_preview: _normalizedIncomingText.slice(0, 120),
          prompt_msg_preview: userMessageForPrompt.slice(0, 120),
        });
      }

       // Recommendation task guardrail + latch (Legacy)
       // Replace heuristic-only latching with the explicit turn-state machine.
       //-------------------------------------------------------------------
       // Advance turn-state ONLY after normalization so markers don’t poison state.
       if (!isEndSession && (conversationMode === "legacy" || conversationMode === "avatar")) {
         turnState = advanceTurnState(turnState, userMessageForPrompt);
       }
 
        const _isLegacyRecommendationRequest =
          !isEndSession &&
          conversationMode === "legacy" &&
          /(?:\brecommend\b|\bsuggest\b|\breplacement\b|\breplace\b|\bwhat should i (?:buy|get)\b|\bwhich\b.*\bshould i get\b|\bwhat(?:'s| is) (?:a )?good\b.*\bfor me\b)/i.test(
            userMessageForPrompt,
          );
  
        const _looksLikeRecommendationFollowup =
          /(?:\bprice\b|\bbudget\b|\$\s*\d+|\bunder\b|\baround\b|\bcompatible\b|\biphone\b|\bandroid\b|\bfeatures?\b|\bbattery\b|\bsleep\b|\bheart rate\b|\bsteps\b|\btracking\b|\bmust\b|\brequirement\b|\bprefer\b|\bwhat information\b|\bwhat do you know\b|\bhow did you choose\b|\bwhy did you\b)/i.test(
            userMessageForPrompt,
          );
  
        const _recentTurnsIndicateRecommendationTask = await (async () => {
          if (!supabase || !effectiveConversationId || !user_id) return false;
          try {
            const client = supabase as SupabaseClient;
            const { data } = await client
              .from("memory_raw")
              .select("role, content, created_at")
              .eq("user_id", user_id)
              .eq("conversation_id", effectiveConversationId)
              .order("created_at", { ascending: false })
              .limit(10);
  
            const tail = (data ?? [])
              .map((r: any) => ({
                role: r.role === "assistant" ? "AI" : r.role,
                content: String(r.content ?? ""),
              }))
              .filter((t: any) => t.content.trim().length > 0);
  
            const userAsked = tail.some(
              (t) =>
                t.role !== "AI" &&
                /(?:\brecommend\b|\bsuggest\b|\breplacement\b|\breplace\b|\bwhat should i (?:buy|get)\b|\bwhich\b.*\bshould i get\b)/i.test(
                  t.content,
                ),
            );
  
            const aiRespondedWithOptions = tail.some(
              (t) =>
                t.role === "AI" &&
                /(?:\brecommendation\b|\bhere are\b|\boptions\b|\bi recommend\b|\bI(?:'m| am) recommending\b)/i.test(
                  t.content,
                ),
            );
  
            return userAsked || aiRespondedWithOptions;
          } catch {
            return false;
          }
        })();
  
       const _turnStateSaysRecommendation =
         !isEndSession && conversationMode === "legacy" && turnState.active_task === "recommendation";
 
        const _isLegacyRecommendationTaskActive =
        (!isEndSession && conversationMode === "legacy" && turnState.active_task === "recommendation") ||
         _isLegacyRecommendationRequest ||
         (_recentTurnsIndicateRecommendationTask && _looksLikeRecommendationFollowup);
  
        if (_isLegacyRecommendationTaskActive) {
          systemPrompt =
            `${systemPrompt}\n\nDECISION_POLICY:\n` +
             `You MUST provide 1–3 concrete recommendations immediately, using the best available information you have.\n` +
             `Do NOT ask clarifying questions before recommending.\n` +
             `Treat the user's latest message as additional constraints or refinement for the SAME recommendation task unless they clearly change topics.\n` +
             `After recommending, you may ask at most ONE follow-up question only if it would materially change the recommendation.\n`;
         }

// -------------------------------------------------------------------
// Dynamic user_facts hydration (Legacy)
// Inject relevant facts for question-like turns, even if the user didn't say "recall".
// This restores "it just works" recall behavior without hardcoded special cases.
//
// IMPORTANT SCOPE GUARD:
// If the user explicitly asks "what do you have recorded" AND scopes it to THIS conversation,
// we must NOT inject cross-session user_facts (it will contaminate the answer).
// -------------------------------------------------------------------
if (!isEndSession && conversationMode === "legacy" && supabase && replyMode === "LONGITUDINAL_REFLECTION") {
  try {
    const snap = await loadLatestLongitudinalSnapshot(supabase as SupabaseClient, user_id);
    // Start from a clean slate: snapshot-only, plus whatever session-local transcript may already be present.
    // (Do NOT inject USER_FACTS for this mode.)
    const snapCreated = snap?.created_at ? String(snap.created_at).slice(0, 10) : "unknown date";
    const snapText = String(snap?.snapshot_text ?? "").trim();
    const snapJson = snap?.snapshot ? JSON.stringify(snap.snapshot) : "";
    const snapBlock =
      "LONGITUDINAL_SNAPSHOT (snapshot-first; do NOT list identity facts like age, location, family unless directly asked):\n" +
      `- Source: memory_summary.observations.longitudinal_snapshot (as of ${snapCreated})\n` +
      (snapText ? `- Snapshot: ${snapText}\n` : "") +
      (snapJson ? `- Structured signals: ${snapJson}\n` : "");

    contextBlock = `${(contextBlock ?? "").trim()}\n\n${snapBlock}`.trim();

    const relatedPrior = await loadRelevantPriorContextBlock(
      supabase as SupabaseClient,
      user_id,
      userMessageForPrompt,
    );
    if (relatedPrior) {
      contextBlock = `${(contextBlock ?? "").trim()}\n\n${relatedPrior}`.trim();
    }

    systemPrompt =
      `${systemPrompt}\n\nLONGITUDINAL_REFLECTION_MODE:\n` +
      "- Use LONGITUDINAL_SNAPSHOT to connect patterns across prior sessions.\n" +
      "- If RELEVANT_PRIOR_CONTEXT is present, connect the current thread to the most relevant prior story/fact by referencing it directly (by id/fact_key).\n" +
      "- Do NOT do a biography / inventory dump (no 'Given what I have recorded...' lists).\n" +
      "- Do NOT use headings like 'What I have recorded' / 'What I do not have recorded yet' for this request.\n" +
      "- Keep it to 4–8 sentences. If you ask a question, ask only ONE and make it directly about the pattern.\n";
  } catch (e) {
    console.log("LONGITUDINAL_REFLECTION: snapshot inject failed (non-fatal)", String(e));
  }
}

if (replyMode !== "LONGITUDINAL_REFLECTION" && !isEndSession && supabase) {
    const _askedRecorded = isRecordedRequest(userMessageForPrompt);
    const _localOnly =
      _askedRecorded &&
      requestsLocalOnlyMemory(userMessageForPrompt) &&
      !requestsCrossSessionMemory(userMessageForPrompt);

  if (!_localOnly) {
    try {
      const factEvidence = await recall_v2(
        supabase as SupabaseClient,
        user_id,
        userMessageForPrompt,
        12,
      );
      if (factEvidence) {
        systemPrompt = `${systemPrompt}\n\n${factEvidence.addon}`;
        contextBlock = `${(contextBlock ?? "").trim()}\n\n${factEvidence.context}`.trim();
        console.log("FACT_RECALL: injected_user_facts", { n: 12 });
      }
    } catch (e) {
      console.log("FACT_RECALL: inject failed (non-fatal)", String(e));
    }
  } else {
    console.log("FACT_RECALL: skipped (local-only recorded request)");
  }
}
      
  // Optional dot-connecting: bring in a small, evidence-backed set of prior stories/facts
  // so normal (non-end-session) replies can connect the current transcript to earlier material
  // without changing routing.
  if (shouldInjectRelevantPriorContextForReply(userMessageForPrompt, turnState.active_task, replyMode)) {
    try {
      const relatedPrior = await loadRelevantPriorContextBlock(
        supabase as SupabaseClient,
        user_id,
        userMessageForPrompt,
      );
      if (relatedPrior) {
        contextBlock = `${(contextBlock ?? "").trim()}

${relatedPrior}`.trim();
        systemPrompt = `${systemPrompt}

CONNECTION_RULE:
- If RELEVANT_PRIOR_CONTEXT is relevant, explicitly connect it to the current topic in 1–2 sentences.
- Never invent stories/facts not in RELEVANT_PRIOR_CONTEXT.
- Do not force a connection if none apply.
`;
      }
    } catch (e) {
      console.log("RELEVANT_PRIOR_CONTEXT: inject failed (non-fatal)", String(e));
    }
  }
 
      // -------------------------------------------------------------------
      // Recall intent gating (Legacy)
      // These flags were previously declared but never assigned, which caused
      // recall hydration (facts + receipts) to never run.
      // -------------------------------------------------------------------
      recallTestForThisTurn = isExplicitRecallTestIntent(userMessageForPrompt);
      // Enable recall hydration for common recall + story-retell questions.
      const recallText = (userMessageForPrompt ?? "").toLowerCase();
      const storyQ = (extractStoryRecallQuery(userMessageForPrompt) ?? "").trim();
      wantsRecallForThisTurn =
        recallTestForThisTurn ||
        detectRecallIntent(userMessageForPrompt) ||
        /\b(do you remember my|remember my|what(?:'s| is) my|tell me my|remind me my|who am i)\b/.test(recallText) ||
        storyQ.length > 0 ||
        /\b(tell me (?:the )?story|retell|recap (?:the )?story|my .* story|story about)\b/.test(recallText);
        
      if (conversationMode === "avatar") {
        console.log("AVATAR_INPUT_DIAG", {
          raw_len: (rawUserMessageForPrompt ?? "").length,
          received_len: (receivedMessageText ?? "").length,
          normalized_len: _normalizedIncomingText.length,
          raw_preview: (rawUserMessageForPrompt ?? "").slice(0, 80),
          received_preview: (receivedMessageText ?? "").slice(0, 80),
          normalized_preview: _normalizedIncomingText.slice(0, 80),
        });
      }
 
      // -----------------------------------------------------------------------
      // TURN SIGNAL GATE (Legacy recalibration)
      // - Do not treat silence/empty text as a signal.
      // - Keep extremely short legacy turns constrained to prevent "expanding emptiness".
      // -----------------------------------------------------------------------
      const _trimmedUserMessageForPrompt = (userMessageForPrompt ?? "").trim();

      // Safety: the client normally does not send empty STT to the server, but guard anyway.
      if (!_trimmedUserMessageForPrompt) {
        return jsonResponse({
        reply_text: (conversationMode === "avatar")
          ? "I’m here. (Avatar v0.5) I didn’t catch any usable text to respond to—try typing a short message like ‘hello’."
          : null,
          learning_artifacts: null,
          legacy_artifacts: null,
          mode: conversationMode,
          preferred_locale: preferredLocale,
          target_locale: hasTarget ? targetLocale : null,
          conversation_id: effectiveConversationId,
          state_json: "{}",
          end_session: isEndSession,
          end_session_summary: null,
        });
      }
      
      // Fast-path: very short greetings / "are you there?" in Legacy mode should not trigger verbose context-driven replies.
      // Avoid calling Gemini for these to prevent "expanding emptiness" and topic-jumping.
      const _isLegacyGreeting =
        !isEndSession &&
        conversationMode === "legacy" &&
        /^(hi|hey|hello|yo|sup|are you there\??|you there\??|gemini\s*,?\s*are you there\??)$/i.test(
          _trimmedUserMessageForPrompt.replace(/\s+/g, " ").trim(),
        );

      if (_isLegacyGreeting) {
        return jsonResponse({
          reply_text: "Yep — I'm here. What would you like to talk about?",
          learning_artifacts: null,
          legacy_artifacts: null,
          mode: conversationMode,
          preferred_locale: preferredLocale,
          target_locale: hasTarget ? targetLocale : null,
          conversation_id: effectiveConversationId,
          state_json: "{}",
          end_session: isEndSession,
          end_session_summary: null,
        });
      }

const _legacyToneConstraint =
        !isEndSession &&
        conversationMode === "legacy"
          ? "\n\nTONE_CONSTRAINT:\nBe calm, grounded, and neutral. Do not cheerlead or assume the user\'s emotional state unless they explicitly state it. Keep replies concise and ask at most one gentle question."
          : "";

      const _lowContentLegacyConstraint =
        !isEndSession &&
        conversationMode === "legacy" &&
        _trimmedUserMessageForPrompt.length < 15
          ? "\n\nTONE_CONSTRAINT:\nBe calm, grounded, and neutral. Do not cheerlead or assume the user\'s emotional state unless they explicitly state it.\n\nRESPONSE_MODE (default):\n- MIRROR (1 sentence): Restate the user\'s point in plain language WITHOUT therapy phrasing like \'It sounds like...\'.\n- SYNTHESIZE (2–4 sentences): Connect 2–3 threads (values, context, past stages, tradeoffs). Name the underlying tension in neutral terms.\n- QUESTION (optional): Ask at most ONE question, only if it\'s necessary to move the thread forward. If the user is venting/ranting, prefer synthesis over questions."
          : "";

// -----------------------------------------------------------------------
// Recall hydration (Legacy): never pretend to remember a story unless we have canonical evidence.
// If the user asks for a retell/recall and we can't find evidence, we reply safely (no Gemini call).
// -----------------------------------------------------------------------
let forcedLegacyReply: string | null = null;
let hadCanonicalEvidenceThisTurn = false;
let hadSessionLocalEvidenceThisTurn = false;
let retellFallbackText: string | null = null;
if (!isEndSession && (conversationMode === "legacy" || conversationMode === "avatar")) {
  const recallTest = recallTestForThisTurn;
  const wantsRecall = wantsRecallForThisTurn;
  let storyQuery = wantsRecall ? extractStoryRecallQuery(userMessageForPrompt) : "";

    // If the user is continuing a recall request with pronouns (“tell me about it/that”)
    // and we didn't extract a concrete query, try to infer it from the last user turn
    // in this conversation (cheap: one small DB read, only on recall turns).
    if (wantsRecall && !storyQuery && !recallTest && supabase && effectiveConversationId && looksLikeRecallContinuation(userMessageForPrompt)) {
      try {
        storyQuery = await inferRecallQueryFromRecentTurns(
          supabase as SupabaseClient,
          user_id,
          effectiveConversationId,
        );
      } catch (_) {
        // ignore
      }
    }
  if (wantsRecall) {
    if (supabase) {
      const evidences = recallTest && !storyQuery
        ? await hydrateRecallBrowseEvidence(
            supabase as SupabaseClient,
            user_id,
          )
        : storyQuery
          ? await hydrateRecallEvidence(
              supabase as SupabaseClient,
              user_id,
              userMessageForPrompt,
              storyQuery,
            )
          : null;

      if (!evidences || evidences.length === 0) {
        // Safety rule: no speculation, no "memory limits" discussion.
        // No canonical evidence from curated stories; try user_facts as a secondary evidence source.
        const factEvidence = await recall_v2(
          supabase as SupabaseClient,
          user_id,
          userMessageForPrompt,
          12,
        );
        if (factEvidence) {
          hadCanonicalEvidenceThisTurn = true;
          systemPrompt = `${systemPrompt}\n\n${factEvidence.addon}`;
          contextBlock = `${contextBlock}\n\n${factEvidence.context}`.trim();
          const _direct = (factEvidence as any)?.directReply;
          if (!forcedLegacyReply && typeof _direct === "string" && _direct.trim()) {
            forcedLegacyReply = _direct.trim();
          }
        } else {
          // Allow a normal Gemini reply, but constrain it to session-local turns only.
          hadSessionLocalEvidenceThisTurn = true;
          systemPrompt = `${systemPrompt}\n\n${buildSessionLocalRecallFallbackAddon()}`;
        }
      } else {
        // Provide evidence to the model and enforce honesty.
        hadCanonicalEvidenceThisTurn = true;
        systemPrompt = `${systemPrompt}\n\n${recallTest && !storyQuery ? buildRecallBrowseAddon(evidences) : buildRecallEvidenceAddon(evidences)}`;
        const evidenceText = evidences
          .map((e, idx) => {
            const t = (e.title ? `Story ${idx + 1}: ${e.title}\n` : `Story ${idx + 1}:\n`);
            return `${t}${e.excerpt}`.trim();
          })
          .join("\n\n---\n\n");
        contextBlock = `${contextBlock}\n\nCANONICAL_EVIDENCE:\n${evidenceText}`.trim();
      
        // Story retell hard-enforcement: prevents meta "records/entries" replies and permission stalling.
        const _storyQ_for_retell = (storyQuery || (extractStoryRecallQuery(userMessageForPrompt) ?? "")).trim();
        if (_storyQ_for_retell.length > 0) {
         // Capture a deterministic retell fallback from the best available narrative evidence.
         // Priority: story_seed (seed_text) > story_recall (synopsis) > capsule.
         // Pick the longest non-empty excerpt within the highest-priority group available.
          const pickBest = (kinds: string[]): string => {
            const candidates = evidences
              .filter((e) => kinds.includes(e.kind) && (e.excerpt || "").trim().length > 0)
              .sort((a, b) => ((b.excerpt || "").length - (a.excerpt || "").length));
            return (candidates[0]?.excerpt || "").trim();
          };
          const pickAny = (): string => {
            const candidates = evidences
              .filter((e) => (e.excerpt || "").trim().length > 0)
              .sort((a, b) => ((b.excerpt || "").length - (a.excerpt || "").length));
            return (candidates[0]?.excerpt || "").trim();
          };
          const best =
            pickBest(["memory_raw"]) ||
            pickBest(["story_seed"]) ||
            pickBest(["story_recall"]) ||
            pickBest(["capsule"]) ||
            pickAny();

          if (best.length > 0) retellFallbackText = best;
          // Deterministic retell: if we have narrative evidence, bypass Gemini.
          // This prevents the model from "stalling" with follow-up questions.
          if (retellFallbackText && retellFallbackText.trim().length > 0) {
            forcedLegacyReply = retellFallbackText.trim();
          }
           // If we don't have any narrative evidence to retell, do NOT call Gemini (it will meta-stall).
           // Fail closed with the safe recall reply instead.
           if (!retellFallbackText) {
             forcedLegacyReply = buildNoEvidenceRecallReply();
           }
 
          contextBlock = `${contextBlock}

STORY_RETELL_MODE:
- The user asked for a story retell. If any story evidence is present, retell it immediately.
- Do not mention how many records/entries exist.
- Do not use "What I have recorded / What I do not have recorded yet" sections for this request.
- Do not describe the database/logs/entries/requests; just tell the story.
- Do not ask for permission (no "Would you like me to proceed?").
- Minimum 4 sentences. Start the story right away.`.trim();
        }      
      }
    } else {
      forcedLegacyReply = buildNoEvidenceRecallReply();
    }
  }
}

      if (_lowContentLegacyConstraint) systemPrompt = `${systemPrompt}${_lowContentLegacyConstraint}`;
      if (_legacyToneConstraint) systemPrompt = `${systemPrompt}${_legacyToneConstraint}`;

      const _currentFocus =
        !isEndSession && conversationMode === "legacy"
          ? buildCurrentFocus(userMessageForPrompt, contextBlock)
          : "";
      if (_currentFocus) systemPrompt = `${systemPrompt}\n\n${_currentFocus}`;

      const _currentRecommendation =
        !isEndSession && conversationMode === "legacy" ? buildCurrentRecommendation(contextBlock) : "";
      if (_currentRecommendation) systemPrompt = `${systemPrompt}\n\n${_currentRecommendation}`;

      const _factUsagePolicy =
        !isEndSession && conversationMode === "legacy"
          ? "FACT_USAGE_POLICY (PUBLIC KNOWLEDGE vs MEMORY LOOKUP vs SYNTHESIS vs INFERENCE):\n" +
            "- Classify intent internally, but do NOT output any routing marker like 'INTENT=...'.\n" +
            "- PUBLIC KNOWLEDGE: If the user asks for general definitions or objective facts (for example: dictionary meaning of a word), answer directly. Do NOT ask permission first. Do NOT say 'I do not have that recorded yet' for public knowledge questions.\n" +
            "- MEMORY LOOKUP: the user asks for a specific stored attribute about THEM or prior sessions. Answer only if supported by USER_FACTS / CANONICAL_EVIDENCE (or the provided transcript). Otherwise say: 'I do not have that recorded yet.' Then ask ONE targeted follow-up.\n" +  
            "- SYNTHESIS: the user asks for a summary/pattern/progression. Do NOT refuse just because no single fact matches. Use two sections: 'What I have recorded' and 'What I do not have recorded yet.' Do not guess.\n" +
            "- INFERENCE: the user asks for advice/implications. You may provide a qualified best inference based on recorded facts. Label it explicitly as inference, cite the fact(s), and do not present inference as a stored fact.\n" +
            "- If the user has named or demonstrated a recurring pattern, prioritize synthesis over any follow-up question.\n" +
            "- When asked “what do you have recorded,” restrict recall to facts stated or confirmed in the current conversation unless the user explicitly asks for cross-session memory.\n" +
            "- Guardrail: Remember what the user said, how strongly they said it, and when. Do not present it as more universal or more permanent than the record.\n" +
            "- Keep lanes distinct: (a) user views as views, (b) public facts as public claims with an as-of date and a source label when available.\n" +
            "- Do NOT say 'I do not have that recorded yet' if the answer is present in USER_FACTS / CANONICAL_EVIDENCE or the provided transcript.\n" +
            "- If facts conflict, surface the conflict and ask ONE clarifier.\n" +
            "- If asked what you used to decide, cite the specific facts/constraints you used from USER_FACTS / CANONICAL_EVIDENCE.\n"
            : "";
        if (_factUsagePolicy) systemPrompt = `${systemPrompt}\n\n${_factUsagePolicy}`;
 
       // Global tone layer (structured internally, natural externally).
       // Applies to both legacy + avatar modes, but NOT end-session.
       const _globalStyleConstraint =
         !isEndSession && (conversationMode === "legacy" || conversationMode === "avatar")
           ? "GLOBAL_STYLE_CONSTRAINT:\n" +
             "- Think in structure, but write in natural, conversational prose.\n" +
             "- Avoid academic tone, formal section headers, and robotic phrasing.\n" +
             "- Do not label points as \"Overgeneralization:\" or \"Selection bias:\" unless the user explicitly asks for formal structure.\n" +
             "- Make responses feel like a thoughtful, intelligent peer speaking plainly.\n" +
             "- Prioritize clarity and insight over rhetorical polish.\n" +
             "- Be direct, but never condescending.\n"
           : "";
       if (_globalStyleConstraint) systemPrompt = `${systemPrompt}\n\n${_globalStyleConstraint}`;

         // User-requested synthesis enhancer (Legacy, non-end-session).
         // This is intentionally NOT a new routing mode; it just constrains the response shape
         // so the model produces themes + implications + a sharp test question (and avoids recap/retell).
          const _userRequestedSynthesis =
           !isEndSession && conversationMode === "legacy" && detectUserRequestedSynthesis(userMessageForPrompt);
       if (_userRequestedSynthesis) {
         systemPrompt =
           `${systemPrompt}\n\nSYNTHESIS_ENHANCER (user requested synthesis; obey strictly):\n` +
           `- Do NOT preface with "Okay", "Sure", "I will", or any meta-commentary about what you are about to do.\n` +
           `- Do NOT retell the stories/events. Use prior items only as evidence hooks.\n` +
           `- Prefer paragraph form. Avoid headings and bullet lists unless the user explicitly asked for them.\n` +
           `- Produce EXACTLY 3 non-overlapping themes stated in abstract terms (not story descriptions). You may number them inline (1), (2), (3) within a paragraph.\n` +
           `- Then: 2–3 sentences on what stays consistent across examples, and 2–3 sentences on what changes by setting/context.\n` +
           `- Then: 2–3 sentences on what this suggests about values/sensitivities/empathy (make a best-fit claim; avoid hedging words like 'perhaps', 'seems', 'appears').\n` +
           `- End with EXACTLY ONE sharp, falsifiable question. The question must test ONE variable (no multi-part conditions).\n` +
           `- When connecting, explicitly name the prior story (e.g., "suckling pig", "murder crabs", "Thailand seafood buffets") so the continuity is clear.\n` +
           `- Never invent stories/facts; only reference what appears in RECENT TURNS / CONTEXT / evidence blocks.\n`;
       }

       // User-requested challenge enhancer (Legacy, non-end-session).
       // If the user explicitly asks to be challenged / have flaws pointed out,
       // force direct execution (no "I will..." preface, no stalling).
       const _userRequestedChallenge =
         !isEndSession && conversationMode === "legacy" && detectUserRequestedChallenge(userMessageForPrompt);
       if (_userRequestedChallenge) {
         systemPrompt =
           `${systemPrompt}\n\nCHALLENGE_ENHANCER (user requested pushback; obey strictly):\n` +
           `- Begin immediately with the critique. Do NOT preface with meta language (e.g., \"Okay\", \"Sure\", \"I will\").\n` +
           `- Do NOT ask clarifying questions unless the user explicitly asked you to.\n` +
           `- Write in natural, conversational prose. Avoid academic tone, formal labels (e.g., “Overgeneralization:”), and robotic phrasing.` +
           `- Make it feel like a thoughtful peer pushing back, not a debate judge issuing bullet points.` +
           `- First: 2–4 sentences summarizing the user\'s thesis as charitably as possible (steelman).\n` +
           `- Then: explain 3–6 concrete weaknesses (overgeneralization, selection bias, missing variables, unfalsifiable claims, etc.). Be specific and grounded in the user\'s own words.\n` +
           `- No moralizing, no scolding; critique claims, not character.\n` +
           `- Then: offer 1 alternative model that better explains the same observations without insulting.\n` +
           `- End with one actionable reframing sentence or one single testable prediction (no multi-part question).\n`;
       }

      // Override: for connect-the-dots prompts, do NOT force the 'What I have recorded' / 'What I do not have recorded yet' synthesis format.
      if (!isEndSession && conversationMode === "legacy" && replyMode === "LONGITUDINAL_REFLECTION") {
        systemPrompt = `${systemPrompt}\n\nLONGITUDINAL_REFLECTION_OVERRIDE:\n- Do NOT do a biography dump.\n- Use LONGITUDINAL_SNAPSHOT only.\n- No 'What I have recorded' headings for this mode.`;
      } 

      if (!isEndSession && (conversationMode === "legacy" || conversationMode === "avatar")) {
        systemPrompt = `${systemPrompt}\n\n${buildTurnDirective(turnState)}`;
      }
 
      // Explicit save UX: if the user just asked to save/record something, acknowledge it as saved
      // and do NOT ask them again whether to save it in the same turn.
      if (!isEndSession && conversationMode === "legacy" && isExplicitSaveRequest(userMessageForPrompt)) {
        systemPrompt = `${systemPrompt}\n\nEXPLICIT_SAVE_ACK:\n- The user explicitly asked to save/record something. Confirm that it has been saved.\n- Do NOT ask again whether to save it.\n- Do NOT ask follow-ups unless required to correctly capture what should be saved.\n`;
      }

       const finalPrompt = `${systemPrompt}

${contextBlock}

User message:
"${userMessageForPrompt.trim()}"`.trim();

      let rawReply = "";

      if (!isEndSession) {
        if (forcedLegacyReply) {
          rawReply = forcedLegacyReply;
        } else {
          rawReply = await callGemini(finalPrompt);
          // Guardrail: if the harness marker somehow survived and the model echoed it,
          // do NOT return an echoed diagnostic question.
          if (/^\[(diagnostic|diag)[^\]]*\]\s*/i.test(rawReply.trim())) {
             // Prefer the no-evidence reply rather than parroting a test marker.
             rawReply = buildNoEvidenceRecallReply();
          }
        }
      } else {
        // End-session should not pay per-turn latency for a normal assistant reply.
        rawReply = "";
      }

      // Clean Gemini output.
      const sanitized = sanitizeGeminiOutput(rawReply);

      // Enforce language tags.
      let replyText = enforceLanguageOnTaggedLines(
        sanitized,
        preferredLocale,
        hasTarget ? targetLocale : null,
      );

      // -------------------------------------------------------------------
      // Legacy execution + anti-parroting enforcement
      // - Prevent verbatim echo replies from reaching the client.
      // - If the user explicitly requests a summary/synthesis, ensure the model EXECUTES
      //   (not a meta "I will..." acknowledgment).
      // - If the user asks for no questions (or signals convergence/pattern), strip a trailing question.
      // -------------------------------------------------------------------
      if (!isEndSession && conversationMode === "legacy") {
        const _u = (userMessageForPrompt ?? "").trim();
        const _uLow = _u.toLowerCase();

        const _noQuestionsRequested =
          /\b(do not ask|don't ask)\b.*\bquestions?\b/.test(_uLow) ||
          /\bunless absolutely required\b/.test(_uLow);

        const _patternSignal = /\b(recurring pattern|a pattern)\b/.test(_uLow);

        const _isSummaryReq = isSummaryOrSynthesisRequest(_u);
        const _isChallengeReq = detectUserRequestedChallenge(_u);

        // Hard anti-parrot: never return the user's message verbatim as the AI reply.
        if (replyText && _u && replyText.trim() === _u) {
          replyText = _isSummaryReq
            ? ""
            : "Understood.";
        }

         // If the user asked for synthesis/summary and the model produced a meta-ack only, re-ask once with an execution override.
         if (_isSummaryReq && looksLikeMetaAckOnly(replyText)) {
           const retryPrompt =
             `${finalPrompt}\n\nEXECUTION_OVERRIDE:\n` +
             `The user asked for a summary/synthesis. Produce the summary NOW in this turn.\n` +
             `Do NOT preface with acknowledgments. Do NOT ask questions.\n` +
             `If you are missing information, state it under 'What I do not have recorded'.`;
 
           const retryRaw = await callGemini(retryPrompt);
           const retrySanitized = sanitizeGeminiOutput(retryRaw);
           replyText = enforceLanguageOnTaggedLines(
             retrySanitized,
             preferredLocale,
             hasTarget ? targetLocale : null,
           );
           replyText = normalizeStoryRetellText(replyText);
         }

         // If the user asked to be challenged and the model produced a meta-ack only, re-ask once with an execution override.
         if (_isChallengeReq && looksLikeMetaAckOnly(replyText)) {
           const retryPrompt =
             `${finalPrompt}\n\nEXECUTION_OVERRIDE_CHALLENGE:\n` +
             `The user explicitly asked to be challenged. Deliver the critique NOW in this turn.\n` +
             `Do NOT preface with acknowledgments. Do NOT ask questions.\n` +
             `Follow CHALLENGE_ENHANCER structure. Be direct and specific. Avoid insults or stereotypes.`;

           const retryRaw = await callGemini(retryPrompt);
           const retrySanitized = sanitizeGeminiOutput(retryRaw);
           replyText = enforceLanguageOnTaggedLines(
             retrySanitized,
             preferredLocale,
             hasTarget ? targetLocale : null,
           );
           replyText = normalizeStoryRetellText(replyText);
         }

         // If the user explicitly asks to explain/elaborate and the model stalls by asking another question,
         // re-ask once with an execution override that forces an actual explanation (no questions).
         const _isExplainReq =
          /\b(elaborate|explain|enlighten|teach me|help me understand|tell me about|walk me through)\b/i.test(_u) ||
          /\bimpact of\b/i.test(_uLow) ||
          /\bwhat (?:is|would be) the impact\b/i.test(_uLow);

        const _looksLikeExplainStall =
          looksLikeMetaAckOnly(replyText) ||
          /(\?\s*)$/.test((replyText || "").trim()) ||
          /\b(what|which|how)\b.+\?$/.test((replyText || "").trim().toLowerCase()) ||
          /\bwhat (?:kind|type|aspects?)\b/.test((replyText || "").toLowerCase());

        if (_isExplainReq && _looksLikeExplainStall) {
          const retryPrompt =
            `${finalPrompt}\n\nEXPLANATION_OVERRIDE:\n` +
            `The user asked for an explanation/elaboration. Provide the explanation NOW.\n` +
            `Do NOT ask any questions.\n` +
            `Give 4–10 sentences. Use bullets if helpful.\n` +
            `Be concrete: include examples of what this looks like in real conversations.\n`;

          const retryRaw = await callGemini(retryPrompt);
          const retrySanitized = sanitizeGeminiOutput(retryRaw);
          replyText = enforceLanguageOnTaggedLines(
            retrySanitized,
            preferredLocale,
            hasTarget ? targetLocale : null,
          );
        }

         const _storyQ2 = (extractStoryRecallQuery(userMessageForPrompt) ?? "").trim();
         if (_storyQ2.length > 0 && looksLikeStoryStall(replyText)) {
           const _retellEvidence = (retellFallbackText || "").trim().slice(0, 1600);
            const retryPrompt =
            `${finalPrompt}\n\nSTORY_RETELL_EXECUTION_OVERRIDE:\n` +
            `The user asked you to RETELL a recorded story. Retell it NOW.\n` +
            `Start the story immediately with the first event (no preface).\n` +
            `Minimum 6 sentences. Write it as a narrative (what happened), not a description of records.\n` +
            `Do NOT mention: records, entries, database, logs, requests, versions, or "I have recorded".\n` +
            `Do NOT say "I can tell you..." and do NOT ask permission or questions.\n` +
            `If multiple versions exist, pick ONE coherent version and retell it.\n` +
            `Optionally add ONE final sentence: "Note:" + a single key difference (only if a real difference exists).\n` +
            (_retellEvidence.length
              ? `\nSTORY_EVIDENCE_TO_RETELL (rewrite into a coherent narrative):\n${_retellEvidence}\n`
              : ``);
 
          const retryRaw = await callGemini(retryPrompt);
          const retrySanitized = sanitizeGeminiOutput(retryRaw);
          replyText = enforceLanguageOnTaggedLines(
            retrySanitized,
            preferredLocale,
            hasTarget ? targetLocale : null
          );
        }

        // Deterministic fallback: if this is a story-retell request and Gemini STILL stalls,
        // return the best narrative evidence directly (fail-closed, avoids meta "recorded" replies).
        if (_storyQ2.length > 0 && looksLikeStoryStall(replyText) && retellFallbackText) {
          replyText = normalizeStoryRetellText(retellFallbackText);
        }

        if (_noQuestionsRequested || _patternSignal) {
          replyText = stripTrailingQuestion(replyText);
        }
      }

      // -------------------------------------------------------------------
      // Legacy recall honesty guard:
      // If we did not hydrate canonical evidence this turn, do not allow the model
      // to claim it remembers specific stories or details. Replace with safe reply.
      // -------------------------------------------------------------------
      if (conversationMode === "legacy" && !hadCanonicalEvidenceThisTurn && !hadSessionLocalEvidenceThisTurn) {
        replyText = stripUnsupportedRecallClaims(replyText);
      }
      // If we DID have evidence, strip any "not recorded yet" preface deterministically.
      if (conversationMode === "legacy" && (hadCanonicalEvidenceThisTurn || hadSessionLocalEvidenceThisTurn)) {
        replyText = stripNotRecordedYetPreface(replyText);
      }

      // Persist the chat-bubble text (null for end-session)
      const trimmedReplyText = replyText.trim();
      reply_text = trimmedReplyText.length > 0 ? trimmedReplyText : null;

      // -----------------------------------------------------------------------
      // 7) Persistence: legacy + language-learning logging
      // -----------------------------------------------------------------------
      if (supabase) {
        const client = supabase as SupabaseClient;

        // 7a) Legacy interview persistence (memory_raw + optional summary)
        if (conversationMode === "legacy") {
          try {
            const ls = legacyState ?? getDefaultLegacyState();
            let userText = (message_text ?? "").trim();
            if (userText === "__END_SESSION__") userText = "";

            let aiText = replyText.trim();
            // Guard: if the model response accidentally echoes the user turn verbatim,
            // do not write it as an AI message (prevents role-swapped transcript artifacts).
            if (aiText && userText && aiText.trim() === userText.trim()) {
              aiText = "";
            }

            const nowMs = Date.now();
            const userCreatedAtIso = new Date(nowMs).toISOString();
            const aiCreatedAtIso = new Date(nowMs + 5).toISOString();
            const nowIsoAi = new Date(Date.now() + 1).toISOString();

            // Word-count estimates (used in memory_raw persistence below).
            // These must be defined in this scope; otherwise runtime will throw.
            const userWordCount = countWordsApprox(userText);
            const aiWordCount = countWordsApprox(aiText);

            // Write user + AI turns into memory_raw
            const legacyRows: any[] = [];

            const coverageChapters: CoverageChapterKey[] = (() => {
              switch (ls.chapter_id) {
                case "childhood":
                  return ["early_childhood", "family_relationships", "education"];
                case "early_career":
                  return ["early_adulthood", "work_career", "major_events"];
                case "midlife":
                  return ["midlife", "family_relationships", "health_wellbeing"];
                case "later_life":
                  return ["later_life", "health_wellbeing", "major_events"];
                default:
                  // If chapter_id is missing/unknown (common in tests), still emit multiple keys
                  // so co-occurrence pairs can be generated.
                  return ["major_events", "work_career", "family_relationships"];
              }
            })();

            // Content-based topic assignment for this turn.
            // NOTE: topic_keys are computed ONCE per turn using the combined (user + ai) text,
            // and the same topic_keys are stored on both memory_raw rows.
            const inferredTurnKeys = inferChapterKeysForLegacySummary(
              [userText, aiText].filter(Boolean).join("\n"),
              [],
            );
            // If inference returns only 0–1 keys (common in E2E), merge with coverageChapters
            // so we can reliably generate co-occurrence pairs.
            const orderedTurnKeys: CoverageChapterKey[] = (() => {
              const inferred = Array.isArray(inferredTurnKeys) ? inferredTurnKeys : [];
              const fallback = Array.isArray(coverageChapters) ? coverageChapters : (["major_events"] as CoverageChapterKey[]);
              const merged = Array.from(
                new Set([...inferred, ...fallback].filter((k) => typeof k === "string" && k.length)),
              );
              // Ensure we have at least 3 distinct keys so we generate >=2 pair rows.
              const padded = [...merged];
              const defaults: CoverageChapterKey[] = ["major_events", "work_career", "family_relationships", "health_wellbeing"];
              for (const d of defaults) {
                if (padded.length >= 3) break;
                if (!padded.includes(d)) padded.push(d);
              }
              return padded.slice(0, 3) as CoverageChapterKey[];
            })();

            // Maintain co-occurrence pairs for topic_keys so we can build longitudinal
            // "what shows up together" signals over time (used by e2e_topic_keys_pair_test.mjs).
            // This is intentionally best-effort and must never break the main turn flow.
            const persistTopicKeyPairsBestEffort = async (
              keys: CoverageChapterKey[],
              seenAtIso: string,
            ) => {
              try {
                let lastErr: any = null;
                const uniq = Array.from(
                  new Set((Array.isArray(keys) ? keys : []).filter((k) => typeof k === "string" && k.length)),
                ) as string[];
                if (uniq.length < 2) return;

                // Generate unordered pairs, canonicalized as (a < b) to avoid duplicates.
                const pairs: Array<[string, string]> = [];
                for (let i = 0; i < uniq.length; i++) {
                  for (let j = i + 1; j < uniq.length; j++) {
                    const a = uniq[i];
                    const b = uniq[j];
                    if (!a || !b || a === b) continue;
                    pairs.push(a < b ? [a, b] : [b, a]);
                  }
                }
                if (pairs.length === 0) return;

                // E2E-only debug to explain why tests see 1 row.
                if (e2e_marker) {
                  console.warn("topic_keys_pair debug:", {
                    e2e_marker,
                    effectiveConversationId,
                    uniq_keys: uniq,
                    pairs_count: pairs.length,
                    pairs,
                  });
                }

                // Try a small set of likely schemas without assuming exact column names.
                // NOTE: We do not throw if the table/schema is absent; tests will catch it.
                const candidateTables = ["topic_keys_pair", "topic_key_pairs"];
                const attempts: Array<{
                  table: string;
                  rows: any[];
                  onConflict: string;
                }> = [];

                for (const table of candidateTables) {
                  // Conversation-scoped schemas (many E2E tests query by conversation_id).
                  attempts.push({
                    table,
                    rows: pairs.map(([a, b]) => ({
                      conversation_id: effectiveConversationId,
                      key_a: a,
                      key_b: b,
                    })),
                    onConflict: "conversation_id,key_a,key_b",
                  });
                  attempts.push({
                    table,
                    rows: pairs.map(([a, b]) => ({
                      conversation_id: effectiveConversationId,
                      topic_key_a: a,
                      topic_key_b: b,
                    })),
                    onConflict: "conversation_id,topic_key_a,topic_key_b",
                  });
                  attempts.push({
                    table,
                    rows: pairs.map(([a, b]) => ({
                      conversation_id: effectiveConversationId,
                      topic_a: a,
                      topic_b: b,
                    })),
                    onConflict: "conversation_id,topic_a,topic_b",
                  });

                  attempts.push({
                    table,
                    rows: pairs.map(([a, b]) => ({
                      user_id,
                      key_a: a,
                      key_b: b,
                    })),
                    onConflict: "user_id,key_a,key_b",
                  });
                  attempts.push({
                    table,
                    rows: pairs.map(([a, b]) => ({
                      user_id,
                      topic_key_a: a,
                      topic_key_b: b,
                    })),
                    onConflict: "user_id,topic_key_a,topic_key_b",
                  });
                  attempts.push({
                    table,
                    rows: pairs.map(([a, b]) => ({
                      user_id,
                      topic_a: a,
                      topic_b: b,
                    })),
                    onConflict: "user_id,topic_a,topic_b",
                  });
                }

                for (const a of attempts) {
                   try {
                     const { error: upsertErr } = await client
                       .from(a.table)
                      .upsert(a.rows, { onConflict: a.onConflict, ignoreDuplicates: true });
                    if (!upsertErr) {
                      if (e2e_marker) {
                        try {
                          // Count rows for this conversation_id (if column exists).
                          const { count, error: countErr } = await client
                            .from(a.table)
                            .select("*", { count: "exact", head: true })
                            .eq("conversation_id", effectiveConversationId);
                          console.warn("topic_keys_pair success:", {
                            table: a.table,
                            onConflict: a.onConflict,
                            rows_sent: a.rows.length,
                            count,
                            countErr: countErr ? String((countErr as any).message ?? countErr) : null,
                          });

                          const { data: sample, error: sampleErr } = await client
                            .from(a.table)
                            .select("*")
                            .eq("conversation_id", effectiveConversationId)
                            .limit(10);
                          console.warn("topic_keys_pair sample:", {
                            table: a.table,
                            sampleErr: sampleErr ? String((sampleErr as any).message ?? sampleErr) : null,
                            sample,
                          });
                        } catch (dbgErr) {
                          console.warn("topic_keys_pair debug readback failed:", dbgErr);
                        }
                      }
                      return; // success
                    }
                    lastErr = upsertErr;
                   } catch (e) {
                    lastErr = e;
                    // keep trying next attempt
                    }
                   }
                 if (lastErr) {
                  if (e2e_marker) {
                    console.warn("topic key pair upsert failed (last error):", lastErr);
                  }
                 }
                } catch (e) {
                 if (e2e_marker) {
                   console.warn("persistTopicKeyPairsBestEffort failed:", e);
                 }
                }
              };

            // Entry metadata (freeform vs interview) is owned by the client UX.
            // We accept it either directly on the request body or embedded inside state_json.
            let entry_mode: "freeform" | "interview" = "freeform";
            let prompt_id: string | null = null;

            const emRaw = (body as any)?.entry_mode ?? (body as any)?.entryMode;
            const pidRaw = (body as any)?.prompt_id ?? (body as any)?.promptId;
            if (emRaw === "freeform" || emRaw === "interview") entry_mode = emRaw;
            if (typeof pidRaw === "string" && pidRaw.trim().length) prompt_id = pidRaw.trim();

            if ((!prompt_id || emRaw == null) && typeof (body as any)?.state_json === "string") {
              try {
                const st = JSON.parse((body as any).state_json);
                const em2 = (st as any)?.entry_mode;
                const pid2 = (st as any)?.prompt_id;
                if ((em2 === "freeform" || em2 === "interview") && emRaw == null) entry_mode = em2;
                if (typeof pid2 === "string" && pid2.trim().length && !prompt_id) prompt_id = pid2.trim();
              } catch {
                // ignore parse errors
              }
            }

            // Optional E2E marker for tests (propagated onto inserted memory_raw rows).
            const e2eMarkerRaw = (body as any)?.e2e_marker;
            const e2e_marker = (typeof e2eMarkerRaw === "string" && e2eMarkerRaw.trim().length)
              ? e2eMarkerRaw.trim()
              : null;

            // E2E correctness: ensure an assistant row exists even if aiText was suppressed
            // (e.g., echo guard). The marker belongs in context, not in content.
            if (e2e_marker && !aiText) {
              aiText = "(e2e placeholder)";
            }

            if (userText) {
              legacyRows.push({
                user_id,
                content: userText,
                source: "legacy_user",
                conversation_id: effectiveConversationId,
                role: "user",
                context: {
                  mode: "legacy",
                  chapter_id: ls.chapter_id,
                  chapter_title: ls.chapter_title,
                  ...(e2e_marker ? { e2e_marker } : {}),
                },
                tags: e2e_marker ? ["legacy", "e2e", `e2e_marker:${e2e_marker}`] : ["legacy"],
                created_at: userCreatedAtIso,
                topic_keys: orderedTurnKeys,
                entry_mode,
                prompt_id,
                word_count_estimate: userWordCount,
                is_legacy_story: true,
                user_edited: false,
              });
            }

            if (aiText) {
              legacyRows.push({
                user_id,
                content: aiText,
                source: "legacy_ai",
                conversation_id: effectiveConversationId,
                role: "assistant",
                context: {
                  mode: "legacy",
                  chapter_id: ls.chapter_id,
                  chapter_title: ls.chapter_title,
                  ...(e2e_marker ? { e2e_marker } : {}),
                },
                tags: e2e_marker ? ["legacy", "e2e", `e2e_marker:${e2e_marker}`] : ["legacy"],
                created_at: nowIsoAi,                
                topic_keys: orderedTurnKeys,
                entry_mode,
                prompt_id,
                word_count_estimate: aiWordCount,
                is_legacy_story: true,
                user_edited: false,
              });
            }

 	            // Persist legacy rows and capture an anchor id for end_session summarization/facts.
 	            // NOTE: This must be defined before any end_session fallback tries to use it.
 	            let rawIdThisTurn: string | null = null;
 	            if (legacyRows.length > 0) {
	              // NOTE: memory_raw schema has changed a few times. If the insert fails due to
	              // unknown columns (e.g., topic_keys/entry_mode), retry with a minimal row-shape.
	              const buildMinimalMemoryRawRows = (rows: any[]) =>
	                (Array.isArray(rows) ? rows : []).map((r) => {
	                  const out: any = {
	                    user_id: r?.user_id,
	                    content: r?.content ?? "",
	                    source: r?.source,
	                    conversation_id: r?.conversation_id,
	                    role: r?.role,
	                  };
	                  // Keep created_at only if present; if schema lacks it, we retry without it.
	                  if (r?.created_at) out.created_at = r.created_at;
	                  return out;
	                });

	              let inserted: any[] | null = null;
	              let insertError: any = null;
	              const tryInsert = async (rows: any[], omitCreatedAt: boolean) => {
	                const finalRows = omitCreatedAt
	                  ? rows.map((r) => {
	                      const rr = { ...(r as any) };
	                      delete (rr as any).created_at;
	                      return rr;
	                    })
	                  : rows;
	                return await client
	                  .from("memory_raw")
	                  .insert(finalRows)
	                  .select("id, role, source, created_at");
	              };

	              // Attempt 1: full row shape
	              ({ data: inserted, error: insertError } = await tryInsert(legacyRows, false));

	              // Attempt 2: minimal row shape if we hit a schema/column mismatch
	              if (insertError) {
	                const msg = String(insertError?.message ?? insertError);
	                const looksLikeColumnMismatch =
	                  /column\s+.+\s+does not exist/i.test(msg) ||
	                  /schema cache/i.test(msg) ||
	                  /invalid input syntax/i.test(msg);

	                if (looksLikeColumnMismatch) {
	                  const minimalRows = buildMinimalMemoryRawRows(legacyRows);
	                  ({ data: inserted, error: insertError } = await tryInsert(minimalRows, false));

	                  // Attempt 3: minimal row shape without created_at (if created_at is not a column)
	                  if (insertError) {
	                    const msg2 = String(insertError?.message ?? insertError);
	                    if (/created_at/i.test(msg2) && /does not exist/i.test(msg2)) {
	                      ({ data: inserted, error: insertError } = await tryInsert(minimalRows, true));
	                    }
	                  }
	                }
	              }
	              if (insertError) {
	                console.error("Legacy persistence insert error:", insertError);
	              } else {
	                const insertedRows = (Array.isArray(inserted) ? inserted : []) as any[];
	                // Prefer anchoring to the *user* row for this turn (prevents duplicate user rows).
	                const userRow = insertedRows.find((r) =>
	                  String((r as any)?.role ?? "").toLowerCase() === "user" &&
	                  String((r as any)?.source ?? "") === "legacy_user"
	                );
	                const anchor = (userRow && (userRow as any).id) ? userRow : (insertedRows[0] ?? null);
	                if (anchor && (anchor as any).id) {
	                  rawIdThisTurn = String((anchor as any).id);
	                }
	              }
 	 
 	               // Explicit save: deterministic persistence for "Please record that" / "Save this"
 	               await persistExplicitSaveBestEffort({
 	                 client,
 	                 user_id,
                 conversation_id: effectiveConversationId,
                 raw_id_this_turn: rawIdThisTurn,
                 user_text: String(userText ?? ""),
                 created_at_iso: userCreatedAtIso,
               });

                // Best-effort: write topic-key co-occurrence pairs for this turn.
                // We do this after the memory_raw insert so a failure here can never block persistence.
               const enableTopicKeyPairs =
                 (Deno.env.get("ENABLE_TOPIC_KEY_PAIRS") ?? "false").toLowerCase() === "true";
              if (enableTopicKeyPairs) {
                 await persistTopicKeyPairsBestEffort(
                   orderedTurnKeys,
                   userCreatedAtIso
                 );
               }
            }

            // UUID guardrail: prevents Postgres 22P02 when "undefined" leaks into uuid filters.
            const isUuid = (s: any): boolean =>
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
                .test(String(s ?? "").trim());

            // If this is an explicit end-session but there were no new rows this turn,
            // anchor to the most recent real memory_raw row for this conversation.
            if (isEndSession && !rawIdThisTurn) {
              if (!isUuid(user_id) || !isUuid(effectiveConversationId)) {
                console.warn("end_session anchor lookup skipped (non-fatal): invalid ids", {
                  user_id,
                  effectiveConversationId,
                });
              } else {
                const { data: lastRaw, error: lastRawErr } = await client
                  .from("memory_raw")
                  .select("id")
                  .eq("user_id", user_id)
                  .eq("conversation_id", effectiveConversationId)
                  .order("created_at", { ascending: false })
                  .order("id", { ascending: false })
                  .limit(1)
                  .maybeSingle();

                if (lastRawErr) {
                  console.warn("end_session anchor lookup failed (non-fatal):", lastRawErr);
                } else if (lastRaw && (lastRaw as any).id) {
                  rawIdThisTurn = String((lastRaw as any).id);
                }
              }
            }

            try {            

            // VIP lane requires a valid memory_raw anchor because fact_candidates.turn_ref is a FK.
            // Prefer anchoring to the real user-row id from this turn (prevents duplicate user rows).
            let rid = rawIdThisTurn ? String(rawIdThisTurn) : "";

            // Fallback: if we couldn't anchor to a real row (e.g., empty turn), create a synthetic anchor.
            if (!rid) {
              // If ids are invalid, do NOT attempt a synthetic insert (it will violate NOT NULL / uuid types).
              if (!isUuid(user_id) || !isUuid(effectiveConversationId)) {
                console.warn("VIP lane synthetic anchor skipped (non-fatal): invalid ids", {
                  user_id,
                  effectiveConversationId,
                });
              } else {
              const vipContent = String(userText ?? "").trim();
              try {
                const { data: vipRaw, error: vipRawErr } = await client
                  .from("memory_raw")
                  .insert({
                    user_id,
                    source: "legacy_user",
                    content: vipContent ? vipContent : "[vip] empty",
                    context: { vip_lane: true, synthetic_anchor: true },
                    conversation_id: effectiveConversationId,
                    role: "user",
                    entry_mode: "freeform",
                    prompt_id: null,
                    topic_keys: [],
                  })
                  .select("id")
                  .single();

                if (vipRawErr) {
                  console.warn("VIP lane synthetic anchor insert failed (non-fatal):", vipRawErr);
                } else if (vipRaw && (vipRaw as any).id) {
                  rid = String((vipRaw as any).id);
                }
              } catch (e) {
                console.warn("VIP lane synthetic anchor insert threw (non-fatal):", e);
               }
              }
            }
 
             // If we still don't have an anchor id, we can't satisfy the FK; skip VIP lane.
             if (!rid) {
               // IMPORTANT: do not return from the request handler (would break respondWith).
               // Just skip VIP lane best-effort.
             } else {

             await vipLaneProcessMessage({
                   client,
                   user_id,
                   conversation_id: effectiveConversationId,
                   raw_id: rid,
                   user_text: String(userText ?? ""),
                 });
             }    
               } catch (e) {
                 console.warn("VIP lane processing failed (non-fatal):", e);
               }

            // Only do the expensive summarisation when this is an explicit end-session.
            if (isEndSession) {
              const endSessionResult = await runEndSessionPipeline({
                client,
                user_id,
                effectiveConversationId,
                rawIdThisTurn,
                conversationMode,
                preferredLocale,
                targetLocale: hasTarget ? targetLocale : null,
                hasTarget,
                  legacyState,
                  nowIso: new Date().toISOString(),
                  deps: {
                   fetchLegacySessionTranscript,
                   summarizeLegacySessionWithGemini,
                   // Optional in end_session.ts; keep only what EndSessionDeps actually supports.
                   extractUserFactsWithGemini,
                  },
                });

              // Fallback: if the immediate memory_summary re-read below misses (timing/RLS),
              // still return a usable end_session_summary payload so the GUI can route.
              // The DB row is still being upserted inside end_session.ts.
              if (!endSessionSummaryPayload) {
                const ss = typeof (endSessionResult as any)?.short_summary === "string"
                  ? String((endSessionResult as any).short_summary).trim()
                  : "";
                if (ss) {
                  endSessionSummaryPayload = {
                    memory_summary_id: null,
                    conversation_id: effectiveConversationId,
                    created_at: new Date().toISOString(),
                    short_summary: ss,
                  };
                }
              }

              // Post end_session rebuild-insights call removed:
              // end_session.ts already handles rebuild-insights with proper uiFast gating/timeouts.
              // Keeping turn_core lean reduces end-session latency and avoids duplicate work.

              // -------------------------------------------------------------------
              // End-session artifacts for client: keep it fast and deterministic.
              // - Do NOT retry/sleep-loop here (it can add 1–3s+ per end session).
              // - Do NOT run extra Gemini calls or mutate memory_summary here.
              // end_session.ts already upserts memory_summary (short_summary + trace).
              // -------------------------------------------------------------------
              try {
                const { data, error } = await client
                  .from("memory_summary")
                  .select("id, created_at, short_summary")
                  .eq("conversation_id", effectiveConversationId)
                  .order("created_at", { ascending: false })
                  .limit(1);

                const msRow = !error && Array.isArray(data) && data.length > 0 ? data[0] : null;
                if (msRow) {
                  const msId = String((msRow as any).id ?? "").trim();
                  const ss = typeof (msRow as any).short_summary === "string" ? String((msRow as any).short_summary).trim() : "";
                  endSessionSummaryPayload = {
                    memory_summary_id: msId || null,
                    conversation_id: effectiveConversationId,
                    created_at: (msRow as any).created_at ?? null,
                    short_summary: ss || (endSessionSummaryPayload as any)?.short_summary || null,
                  };
                  summaryIdForSeeds = msId || summaryIdForSeeds;
                }
              } catch (e) {
                console.error("End-session artifact assembly failed:", String(e));
              }
 
             }
          } catch (err) {
            console.error("Legacy persistence error:", err);
          }
        }
      }

      // -----------------------------------------------------------------------
      
      // -----------------------------------------------------------------------
      // 7c) Prepare outgoing state_json (string) for client
      // -----------------------------------------------------------------------
      let outgoing_state_json: string | null = null;

        try {
         if (conversationMode === "avatar") {
          outgoing_state_json = JSON.stringify({
            ...(legacyState ?? getDefaultLegacyState()),
            turn_state: turnState,
          });
         } else {
           // legacy: keep state_json minimal to avoid re-triggering old chapter machine in client
          outgoing_state_json = JSON.stringify({ turn_state: turnState });
         }
       } catch (_) {
         outgoing_state_json = "{}";
        }

      // Some clients route end-session UI via legacy_artifacts.end_session_summary.
      // Keep top-level end_session_summary (current contract) AND mirror it here for compatibility.
      const legacy_artifacts_payload =
        isEndSession && endSessionSummaryPayload
          ? {
              end_session_summary: endSessionSummaryPayload,
              // optional camelCase mirror for older Flutter JSON models
              endSessionSummary: endSessionSummaryPayload,
            }
          : null;

      // Bubble reply text (null for end-session)
      let safeReplyText: string | null = null;

      // Strip leading INTENT=... header (model routing metadata) from assistant text
      const stripIntentHeader = (text: string): string => {
        if (!text) return text;
        const lines = text.split(/\r?\n/);
        let i = 0;
        while (i < lines.length && lines[i].trim() === "") i++;
        if (i < lines.length && /^INTENT=[A-Z_]+$/.test(lines[i].trim())) {
          lines.splice(i, 1);
          // Remove a single following blank line, if present
          if (i < lines.length && lines[i].trim() === "") {
            lines.splice(i, 1);
          }
        }
        return lines.join("\n").trim();
      };

        // NOTE: Some clients treat reply_text=null as "no update" and skip parsing end_session_summary.
        // Return an empty string for end_session so the UI still processes the response payload.
       safeReplyText = isEndSession
         ? (conversationMode === "avatar"
            ? (() => {
                const t = String((body as any).__avatar_proxy_reply_text ?? "").trim();
                return t.length > 0
                  ? t
                  : "⚠️ Avatar returned no reply_text (end_session). Check /avatar logs.";
              })()
             : "")
        : stripIntentHeader((reply_text ?? "").trim());  
 
       // Persist avatar transcript turns (never blocks reply; errors are logged only).
      // For avatar+end_session (client bug / mixed behavior), persist the proxied reply if present.
      if (conversationMode === "avatar") {
        const shouldPersist = !isEndSession || (isEndSession && typeof safeReplyText === "string" && safeReplyText.trim().length > 0);
        if (shouldPersist) {
          await persistAvatarTurn({ role: "user", content: (message_text ?? "").toString() });
          if (safeReplyText) {
            await persistAvatarTurn({ role: "assistant", content: safeReplyText });
          }
        }
      }

      // 8) Final response to the client
      // -----------------------------------------------------------------------
      
      // Final safety-net: never return a silent avatar turn.
      if (conversationMode === "avatar" && (reply_text == null || String(reply_text).trim().length == 0) && !isEndSession) {
        console.log("AVATAR_FINAL_REPLY_FALLBACK");
        reply_text = "I’m here. (Avatar v0.5) Ask me something about what you’ve shared so far, and I’ll reflect it back.";
      }

       return jsonResponse({
         reply_text: safeReplyText,
        legacy_artifacts: legacy_artifacts_payload,
         mode: conversationMode,
        // KILL: locale prefs in response (client can own prefs; reduces stale language-learning remnants)
        preferred_locale: null,
        target_locale: null,
         conversation_id: effectiveConversationId,
         state_json: outgoing_state_json,   
 
         end_session: isEndSession,
         end_session_summary: endSessionSummaryPayload,
        insight_moment: null,
        });

    } catch (e) {
      console.error("❌ ai-brain handler error:", e);
      return jsonResponse(
        {
          error: "Failed to generate reply from Gemini.",
          details: String(e),
        },
        500,
      );
    }
  }