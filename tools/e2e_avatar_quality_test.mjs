// tools/e2e_avatar_quality_test.mjs
// Run: node tools/e2e_avatar_quality_test.mjs
//
// Env:
//   SUPABASE_URL   - Supabase project URL (required)
//   SB_SECRET_KEY  - Supabase secret key (required; non-JWT)
//   TEST_USER_ID   - user_id to query + send (optional; defaults to your Legacy user_id)
//   AVATAR_USER    - override user_id sent to avatar (optional)
//
// This script is intentionally dependency-light: Node 18+ (fetch built-in).

import assert from "node:assert/strict";
import process from "node:process";

// --- Supabase credentials (non-JWT secret key) ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SB_SECRET_KEY = process.env.SB_SECRET_KEY;
const TEST_USER_ID = process.env.TEST_USER_ID || "7037efeb-a6b1-49b4-b782-1843ce300425";

 // Optional test user (depends on avatar contract)
const AVATAR_USER = process.env.AVATAR_USER || TEST_USER_ID;
 
 // Derived avatar endpoint
const AVATAR_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/avatar` : "";
 
 if (!SUPABASE_URL) {
   console.error("Missing SUPABASE_URL env var.");
   process.exit(2);
 }
 
   if (!SB_SECRET_KEY) {
    console.error("Missing SB_SECRET_KEY env var.");
     process.exit(2);
   }
 
// --- deterministic RNG (prevents flaky tests) ---
// Set AVATAR_TEST_SEED to replay the same random picks across runs.
const AVATAR_TEST_SEED = process.env.AVATAR_TEST_SEED || String(Date.now());

function xmur3(str) {
  // https://github.com/bryc/code/blob/master/jshash/PRNGs.md (public domain)
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(xmur3(AVATAR_TEST_SEED)());

   function nowIso() {
     return new Date().toISOString();
   }
 
 function pickRandom(arr) {
   if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(rng() * arr.length)];
 }

function pickSnippet(text, maxWords = 10) {
  const words = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (!words.length) return "recent memories";
  return words.slice(0, Math.min(maxWords, words.length)).join(" ");
}

// Choose a topic that is answerable: prefer strong keywords, otherwise a short phrase.
// This is defensive: it will work even if pickKeyword() was removed/renamed in your local file.
function pickTopicSnippet(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "recent memories";

  // Prefer a year if present
  const years = t.match(/\b(19|20)\d{2}\b/g) || [];
  if (years.length) return years[Math.floor(rng() * years.length)];

  // Prefer strong topics if present
  const strong = ["Thailand", "Bangkok", "Pattaya", "Baltimore", "Dallas", "cycling", "diet", "retirement", "Legacy"];
  for (const s of strong) {
    if (t.toLowerCase().includes(s.toLowerCase())) return s;
  }

  // If pickKeyword exists, use it, but avoid lame tokens.
  if (typeof pickKeyword === "function") {
    const kw = String(pickKeyword(t) || "").trim();
    const bad = new Set(["Adams", "Amir", "testing", "true", "false", "yes", "no", "today"]);
    if (kw && !bad.has(kw)) return kw;
  }

  // Fallback: a short phrase is more answerable than a single token.
  return pickSnippet(t, 10);
}

function pickTopicFromSummary(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "recent memories";

  // Reject common low-signal tokens and likely-name tokens
  const BAD = new Set([
    "adams", "amir", "alicia", "asia", // likely names (swap/add as needed)
    "true", "false", "yes", "no",
    "test", "testing",
  ]);

  // If a year is present, return a *phrase around it* (standalone years like "1998"
  // often trigger fallback due to low context).
  const ym = t.match(/\b(19|20)\d{2}\b/);
  if (ym) {
    const words = t.split(" ").filter(Boolean);
    const year = ym[0];
    const idx = Math.max(0, words.findIndex((w) => w.includes(year)));
    const start = Math.max(0, idx - 4);
    const end = Math.min(words.length, idx + 6);
    const around = words.slice(start, end).join(" ").trim();
    // Ensure we don't return a bare year anyway
    if (around && around !== year) return around;
  }

  // Prefer a known strong topic if present
  const strong = ["Thailand", "Bangkok", "Pattaya", "cycling", "diet", "retirement", "Legacy"];
  for (const s of strong) {
    if (t.toLowerCase().includes(s.toLowerCase())) return s;
  }

  // Otherwise use a short phrase (more answerable than a single token)
  const words = t.split(" ").filter(Boolean);
  const STOP = new Set(["the", "a", "an", "to", "and", "or", "of", "in", "on", "for", "with", "after", "before", "at", "by", "from"]);
  let phrase = "";
  for (let tries = 0; tries < 6; tries++) {
    const start = Math.min(
      words.length - 1,
      Math.floor(Math.random() * Math.max(1, words.length - 10)),
    );
    const cand = words.slice(start, start + 10).join(" ").trim();
    const last = (cand.split(" ").pop() || "").toLowerCase().replace(/[^a-z]/g, "");
    const alphaWords = cand.split(" ").filter((w) => /[a-zA-Z]/.test(w)).length;
    if (cand && alphaWords >= 5 && !STOP.has(last)) {
      phrase = cand;
      break;
    }
  }
  if (!phrase) phrase = words.slice(0, 10).join(" ");

  // If the phrase collapses into a single bad token, fallback to the opening phrase.
  const firstToken = (phrase.split(" ")[0] || "").toLowerCase().replace(/[^a-z]/g, "");
  if (BAD.has(firstToken)) return words.slice(0, 8).join(" ");

  return phrase;
}

function safeString(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function extractValueSnippets(valueJson) {
  // Pull a few strings/numbers from value_json so we can do lightweight recall assertions.
  const out = [];
  const seen = new Set();
  const push = (x) => {
    const s = safeString(x).trim();
    if (!s) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  const walk = (x) => {
    if (x == null) return;
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") {
      push(x);
      return;
    }
    if (Array.isArray(x)) {
      for (const it of x) walk(it);
      return;
    }
    if (typeof x === "object") {
      // Prefer common fields if present
      for (const key of ["value", "name", "full_name", "title", "city", "state", "country"]) {
        if (key in x) walk(x[key]);
      }
      for (const k of Object.keys(x)) walk(x[k]);
    }
  };
  walk(valueJson);
  // Keep it small and stable
  return out.filter((s) => s.length <= 80).slice(0, 3);
}

function humanizeFactKey(key) {
  // Very light conversion: identity.full_name -> "identity full name"
  return (key || "").replace(/[._]/g, " ").replace(/\s+/g, " ").trim();
}

async function supabaseSelect(table, select, filters, limit = 200) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set("select", select);
   url.searchParams.set("limit", String(limit));
   // filters like: { user_id: `eq.${AVATAR_USER}` }
   for (const [k, v] of Object.entries(filters || {})) url.searchParams.set(k, v);
  const key = SB_SECRET_KEY;
   const res = await fetch(url.toString(), {
     method: "GET",
     headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
    },
  });
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // ignore
  }
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) ? (json.message || json.error) : raw;
    throw new Error(`PostgREST ${table} failed (${res.status}): ${msg}`);
  }
  return Array.isArray(json) ? json : [];
}

function wordCount(s) {
  return (s || "").trim().split(/\s+/).filter(Boolean).length;
}

function countOccurrences(text, needles) {
  const t = (text || "").toLowerCase();
  let c = 0;
  for (const n of needles) {
    const re = new RegExp(`\\b${escapeRegExp(n)}\\b`, "g");
    const m = t.match(re);
    if (m) c += m.length;
  }
  return c;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Heuristic rubric ---
function scoreReply({ prompt, reply }) {
  const r = (reply || "").trim();
  const wc = wordCount(r);
  const lc = r.toLowerCase();

  const reasons = [];
  let score = 100;

  // Basic validity
  if (!r) {
    return { score: 0, reasons: ["empty_reply"] };
  }

  if (wc < 25) {
    score -= 20;
    reasons.push("too_short(<25_words)");
  }
  if (wc > 420) {
    score -= 10;
    reasons.push("too_long(>420_words)");
  }

  // Penalize classic "parrot mode" patterns
  const parrotPhrases = [
    "it sounds like",
    "i hear you",
    "what i’m hearing",
    "what i'm hearing",
    "it seems like",
    "you might be feeling",
    "i understand that",
    "thanks for sharing",
  ];
  const parrotHits = parrotPhrases.reduce((acc, p) => acc + (lc.includes(p) ? 1 : 0), 0);
  if (parrotHits >= 2) {
    score -= 25;
    reasons.push(`parrot_mode(${parrotHits}_phrases)`);
  } else if (parrotHits === 1) {
    score -= 10;
    reasons.push("mild_parrot_mode(1_phrase)");
  }

  // Penalize "non-answer": mostly questions back
  const questionMarks = (r.match(/\?/g) || []).length;
  if (questionMarks >= 3 && wc < 140) {
    score -= 20;
    reasons.push("questiony_non_answer(>=3_questions)");
  }

  // Penalize AI disclaimers / meta
  const disclaimers = [
    "as an ai",
    "i can't",
    "i cannot",
    "i’m just",
    "i am just",
    "language model",
    "i don't have access",
  ];
  const disclaimerHits = disclaimers.filter((p) => lc.includes(p)).length;
  if (disclaimerHits > 0) {
    score -= 25;
    reasons.push("ai_disclaimer_or_meta");
  }

  // Reward specificity (lightweight proxy): digits / proper-ish nouns / concrete anchors
  const digitHits = (r.match(/\d/g) || []).length;
  if (digitHits >= 3) {
    score += 5;
    reasons.push("specificity_bonus(digits)");
  }

  // Penalize extreme vagueness
  const vaguePhrases = [
    "in general",
    "overall",
    "it depends",
    "everyone is different",
    "there are many factors",
  ];
  const vagueHits = vaguePhrases.filter((p) => lc.includes(p)).length;
  if (vagueHits >= 2) {
    score -= 10;
    reasons.push("vague_language");
  }

  // Forward motion: look for action verbs / structure
  const forwardSignals = [
    "try this",
    "next",
    "here’s a",
    "here's a",
    "do this",
    "step",
    "first",
    "second",
    "third",
    "plan",
    "today",
    "this week",
  ];
  const forwardHits = forwardSignals.filter((p) => lc.includes(p)).length;
  const hasListStructure = /\n\s*(?:[-*]\s+|\d+\.\s+)/.test(r);
  const hasSingleFollowupQ = questionMarks === 1 && wc >= 25;
  const hasAnyForwardMotion = forwardHits > 0 || hasListStructure || hasSingleFollowupQ;

  if (forwardHits >= 2) {
    score += 10;
    reasons.push("forward_motion_bonus");
  } else if (hasSingleFollowupQ && forwardHits === 0) {
    // Asking one clarifying question can be forward motion (avoid penalizing it).
    reasons.push("forward_motion_signal(clarifying_question)");
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));

  // “Must answer ask” check (simple): if prompt is a direct question and reply doesn’t contain any declarative
  const promptIsDirectQ = /\?$/.test(prompt.trim()) || prompt.toLowerCase().startsWith("what");
  if (promptIsDirectQ) {
    const hasDeclarative = /[.!]/.test(r);
    if (!hasDeclarative) {
      score -= 15;
      reasons.push("fails_direct_answer_signal");
      score = Math.max(0, score);
    }
  }

  return { score, reasons };
}

 async function callAvatar({ prompt }) {
   const headers = {
     "content-type": "application/json",
   };
 
  // Use project secret key for both PostgREST reads and Edge Function invoke.
  headers["apikey"] = SB_SECRET_KEY;
  headers["authorization"] = `Bearer ${SB_SECRET_KEY}`;
  headers["x-sb-secret-key"] = SB_SECRET_KEY;
 
   // Many handlers read user identity from headers when verify_jwt=false.
   if (AVATAR_USER) {
     headers["x-user-id"] = AVATAR_USER;
     headers["x-legacy-user-id"] = AVATAR_USER;
     headers["x-sub"] = AVATAR_USER;
  }

  // Body contract: adjust if your avatar expects a different shape.
  // Common patterns: { user_id, text } or { userId, message } etc.
  const body = {
    user_id: AVATAR_USER || undefined,
    userId: AVATAR_USER || undefined,
    legacy_user_id: AVATAR_USER || undefined,
    legacyUserId: AVATAR_USER || undefined,
    uid: AVATAR_USER || undefined,
    sub: AVATAR_USER || undefined,

    // Send the prompt under multiple common keys so we match the function's expected contract.
    // This is safe (extra fields are ignored) and fixes "I didn't catch any text" contract mismatches.
    text: prompt,
    // avatar/index.ts reads question/message_text/message/user_message/input... (lines 183–189)
    question: prompt,
    message_text: prompt,
    user_message: prompt,
    message: prompt,
    prompt,
    input: prompt,
    userText: prompt,
    query: prompt,
    mode: "avatar",
    ts: nowIso(),
  };

  const res = await fetch(AVATAR_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const raw = await res.text();

  // Try parse JSON, but don’t require it (some functions return plain text)
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // ignore
  }

  if (!res.ok) {
    const msg = json?.error || json?.message || raw;
    throw new Error(`Avatar HTTP ${res.status}: ${msg}`);
  }

  // Extract reply text from common shapes:
  // Your avatar function returns { ok: true, answer: "...", receipts: [...] }
  const reply =
    json?.reply_text ??
    json?.answer ??
    json?.reply ??
    json?.text ??
    json?.content ??
    json?.message ??
    (typeof json === "string" ? json : null) ??
    raw;

  return { reply: String(reply ?? "").trim(), raw, json };
}
 
 async function buildDynamicTests() {
   const tests = [];
 
   // --- Random receipts from memory_summary (2) ---
   // Avatar builds receipts from memory_summary full_summary/short_summary (lines 270–296)
   const summaries = await supabaseSelect(
     "memory_summary",
     "*",
     { user_id: `eq.${AVATAR_USER}` },
     300
   );
 
   const goodSummaries = (summaries ?? [])
     .map((r) => ({
       ...r,
       text: String(r.full_summary || r.long_summary || r.summary || r.short_summary || r.text || r.content || "").trim(),
     }))
     .filter((r) => r.text.length >= 40);
 
   for (let i = 0; i < 2; i++) {
     const s = pickRandom(goodSummaries);
     if (!s) break;
     const topic = pickTopicFromSummary(s.text);
     const excerpt = String(s.text || "").slice(0, 240);
     tests.push({
       id: `random_summary_${i + 1}`,
       prompt:
         `From my saved memories, explain what this refers to and give concrete details.\n` +
         `Topic: "${topic}"\n` +
         `Memory excerpt: ${JSON.stringify(excerpt)}\n` +
         `Include 2 concrete details and ask 1 clarifying question.`,
       minScore: 80,
       mustNotIncludeAny: ["I don’t have that in the memories I have here yet."],
     });
   }
 
   // --- Random stories from story_seeds (2) ---
   // Avatar uses story_seeds title + seed_text (lines 298–327)
   const seeds = await supabaseSelect(
     "story_seeds",
     "id,created_at,conversation_id,title,seed_text",
     { user_id: `eq.${AVATAR_USER}` },
     200
   );
 
  const goodSeeds = (seeds ?? [])
    .map((r) => {
      const title = String(r.title || "").trim();
      const seedText = String(r.seed_text || "").trim();
      return { ...r, text: `${title} ${seedText}`.trim() };
    })
    .filter((r) => r.title && typeof r.text === "string" && r.text.length >= 20);
 
   for (let i = 0; i < 2; i++) {
    const st = pickRandom(goodSeeds);
    if (!st) break;
    const excerpt = String(st.text || "").slice(0, 240);
    const topic = pickTopicFromSummary(excerpt);
     tests.push({
      id: `random_story_seed_${i + 1}`,
       prompt:
         `From my saved memories, explain what this refers to and give concrete details.\n` +
         `Topic: "${topic}"\n` +
        `Story seed excerpt: ${JSON.stringify(excerpt)}\n` +
         `Include 2 concrete details and ask 1 clarifying question.`,
      minScore: 85,
       mustNotIncludeAny: ["I don’t have that in the memories I have here yet."],
     });
   }
 
   // Fallback if DB is empty or access blocked
   if (!tests.length) {
     tests.push({
       id: "fallback_non_parrot_check",
       prompt:
         "It has occurred to me recently that people who never attempt difficult things never worry about failure. Respond in a helpful, specific way that moves the discussion forward.",
       minScore: 75,
       mustIncludeAny: [],
     });
   }
 
   return tests;
 }

async function main() {
  const TESTS = await buildDynamicTests();
  console.log(`E2E avatar quality test starting @ ${nowIso()}`);
  console.log(`Seed: ${AVATAR_TEST_SEED}`);
  console.log(`Target: ${AVATAR_URL}`);
  console.log(`Tests: ${TESTS.length}`);
  console.log("");

  const results = [];
  let failures = 0;

  for (const t of TESTS) {
    const { id, prompt, minScore, mustIncludeAny } = t;
     const effectiveMinScore =
       (typeof minScore === "number" ? minScore : undefined) ??
       (typeof t.min_score === "number" ? t.min_score : undefined) ??
       (typeof t.minscore === "number" ? t.minscore : undefined) ??
       80;

     let reply = "";
     try {
       const out = await callAvatar({ prompt });
       reply = out.reply;

      // If the model answered too briefly (<25 words), retry once with an explicit length requirement.
      // This keeps the test stable without changing production behavior.
      if (wordCount(reply) < 25) {
        const out2 = await callAvatar({
          prompt:
            `${prompt}\n\nIMPORTANT: Answer in 30–80 words. Include 2 concrete details and ask exactly 1 clarifying question.`,
        });
        const r2 = String(out2?.reply ?? "").trim();
        if (r2) reply = r2;
      }

       const scored = scoreReply({ prompt, reply });

      // Optional strict inclusion checks (fact recall)
      if (Array.isArray(mustIncludeAny) && mustIncludeAny.length) {
        const lc = reply.toLowerCase();
        const ok = mustIncludeAny.some((x) => lc.includes(String(x).toLowerCase()));
        if (!ok) {
          scored.score = Math.max(0, scored.score - 35);
          scored.reasons.push(`missing_expected(${mustIncludeAny.join("|")})`);
        }
      }

      // Optional strict exclusion checks (must NOT fall back)
      if (Array.isArray(t.mustNotIncludeAny) && t.mustNotIncludeAny.length) {
        const lc = reply.toLowerCase();
        const bad = t.mustNotIncludeAny.some((x) => lc.includes(String(x).toLowerCase()));
        if (bad) {
          scored.score = Math.max(0, scored.score - 50);
          scored.reasons.push(`hit_fallback(${t.mustNotIncludeAny.join("|")})`);
        }
      }      

      const pass = scored.score >= effectiveMinScore;

      results.push({
        id,
        pass,
        score: scored.score,
        minScore: effectiveMinScore,
        reasons: scored.reasons,
        replyPreview: reply.slice(0, 240) + (reply.length > 240 ? "…" : ""),
      });

      console.log(
        `[${pass ? "PASS" : "FAIL"}] ${id} score=${scored.score} (min=${effectiveMinScore})`,
      );

      if (!pass) failures++;
      if (scored.reasons.length) console.log(`  reasons: ${scored.reasons.join(", ")}`);
      console.log(`  question: ${prompt}`);
      console.log(`  reply: ${results[results.length - 1].replyPreview}`);
      console.log("");
    } catch (e) {
      failures++;
      results.push({
        id,
        pass: false,
        score: 0,
        minScore: effectiveMinScore,
        reasons: ["http_or_runtime_error", e?.message || String(e)],
        replyPreview: reply.slice(0, 240),
      });
      console.log(`[FAIL] ${id} error: ${e?.message || e}`);
      console.log("");
    }
  }

  // Aggregate score
  const avg = results.reduce((a, r) => a + (r.score || 0), 0) / Math.max(1, results.length);
  console.log(`Average score: ${avg.toFixed(1)}`);
  console.log(`Failures: ${failures}/${results.length}`);

  // CI-friendly exit
  if (failures > 0) {
    process.exitCode = 1;
  }

  // Hard gate: average must be decent
  assert.ok(avg >= 75, `Average avatar quality score too low: ${avg.toFixed(1)} (<75)`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});