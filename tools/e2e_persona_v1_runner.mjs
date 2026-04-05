// tools/e2e_persona_v1_runner.mjs
// Run: node tools/e2e_persona_v1_runner.mjs
//
// Env (same style as your existing tests):
//   SUPABASE_URL        - Supabase project URL (required)
//   SB_SECRET_KEY       - Supabase secret key (required; non-JWT)
//   TEST_USER_ID        - user_id for the run (optional; defaults to 7037...)
//   AVATAR_USER         - override avatar user_id (optional; defaults to TEST_USER_ID)
//   LEGACY_URL          - legacy ingest function URL (recommended)
//                         e.g. https://<ref>.supabase.co/functions/v1/ai-brain
//   LEGACY_MODE         - optional (default "legacy")
//   POLL_TIMEOUT_MS     - optional (default 20000)
//   POLL_INTERVAL_MS    - optional (default 800)
//
// This runner:
//  1) creates 12 new conversation_ids
//  2) posts Persona V1 verbatim scripts to legacy ingest
//  3) polls until memory_summary appears
//  4) stage-gates memory_raw/memory_summary/fact_candidates/story_seeds
//  5) asks 2 avatar QA questions per session
//
// NOTE: If your legacy function expects a different body shape, adjust callLegacy().

import process from "node:process";
import crypto from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SB_SECRET_KEY = process.env.SB_SECRET_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TEST_USER_ID = process.env.TEST_USER_ID || "7037efeb-a6b1-49b4-b782-1843ce300425";
const AVATAR_USER = process.env.AVATAR_USER || TEST_USER_ID;
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL;
const TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD;

const LEGACY_URL =
  process.env.LEGACY_URL || (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/ai-brain` : "");
const AVATAR_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/avatar` : "";

const LEGACY_MODE = process.env.LEGACY_MODE || "legacy";

const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 20000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 800);

const TRIGGER_END_SESSION = (process.env.TRIGGER_END_SESSION || "true").toLowerCase() !== "false";

if (!SUPABASE_URL) {
  console.error("Missing SUPABASE_URL env var.");
  process.exit(2);
}
if (!SB_SECRET_KEY) {
  console.error("Missing SB_SECRET_KEY env var.");
  process.exit(2);
}
if (!LEGACY_URL) {
  console.error("Missing LEGACY_URL (or SUPABASE_URL).");
  process.exit(2);
}

function nowIso() {
  return new Date().toISOString();
}

 function sleep(ms) {
   return new Promise((r) => setTimeout(r, ms));
 }

function decodeJwtSub(token) {
  // JWT: header.payload.signature (payload is base64url JSON)
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  try {
    const json = JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8"));
    return typeof json?.sub === "string" ? json.sub : null;
  } catch {
    return null;
  }
}

let _authCache = null;
async function getUserJwtAndId() {
  if (_authCache) return _authCache;
  if (!SUPABASE_ANON_KEY || !TEST_USER_EMAIL || !TEST_USER_PASSWORD) {
    throw new Error(
      "Avatar QA requires a real Supabase user JWT. Set SUPABASE_ANON_KEY, TEST_USER_EMAIL, TEST_USER_PASSWORD.",
    );
  }

  const url = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD }),
  });

  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // ignore
  }
  if (!res.ok) {
    const msg = json?.error_description || json?.message || json?.error || raw;
    throw new Error(`Auth token fetch failed ${res.status}: ${msg}`);
  }
  const token = json?.access_token;
  if (typeof token !== "string" || !token) {
    throw new Error("Auth token fetch succeeded but access_token missing.");
  }
  const userId = (typeof json?.user?.id === "string" && json.user.id) || decodeJwtSub(token);
  if (typeof userId !== "string" || !userId) {
    throw new Error("Auth token fetched but could not determine user id (user.id/sub).");
  }

  _authCache = { token, userId };
  return _authCache;
}

function headersWithAuth(extra = {}) {
   return {
      "content-type": "application/json",
      apikey: SB_SECRET_KEY,
      authorization: `Bearer ${SB_SECRET_KEY}`,
      "x-sb-secret-key": SB_SECRET_KEY,
      "x-user-id": TEST_USER_ID,
      "x-legacy-user-id": TEST_USER_ID,
      "x-sub": TEST_USER_ID,
      ...extra,
    };
}


// Minimal PostgREST select helper (mirrors your existing test style)
async function supabaseSelect(table, select, filters = {}, limit = 200) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set("select", select);
  url.searchParams.set("limit", String(limit));

  for (const [k, v] of Object.entries(filters || {})) {
    // v should already be a PostgREST filter operator string, e.g. "eq.<uuid>"
    url.searchParams.set(k, v);
  }

  const res = await fetch(url, { headers: headersWithAuth() });
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // ignore
  }
  if (!res.ok) {
    const msg = json?.message || json?.error || raw;
    const err = new Error(`PostgREST select failed: ${table} ${res.status} ${msg}`);
    err.status = res.status;
    err.body = raw;
    throw err;
  }
  return json || [];
}

// Robust "try select with filters"; if the table/column doesn't exist, return null
async function trySupabaseSelect(table, select, filters, limit = 200) {
  try {
    return await supabaseSelect(table, select, filters, limit);
  } catch (e) {
    const msg = String(e?.message || "");
    // Common PostgREST errors for missing table/column
    if (msg.includes("does not exist") || msg.includes("unknown") || msg.includes("failed")) {
      return null;
    }
    throw e;
  }
}

 async function callLegacy({ conversation_id, text }) {
   const headers = headersWithAuth({
    "x-user-id": TEST_USER_ID,
    "x-legacy-user-id": TEST_USER_ID,
    "x-sub": TEST_USER_ID,
    ...(AVATAR_USER ? { "x-avatar-user-id": AVATAR_USER } : {}),
     "x-conversation-id": conversation_id,
     "x-cid": conversation_id,
   });

  // Be permissive with body keys so we match your handler even if its contract changes.
  const body = {
    mode: LEGACY_MODE,
    user_id: TEST_USER_ID,
    userId: TEST_USER_ID,
    legacy_user_id: TEST_USER_ID,
    legacyUserId: TEST_USER_ID,
    uid: TEST_USER_ID,
    sub: TEST_USER_ID,

    conversation_id,
    conversationId: conversation_id,
    cid: conversation_id,

    text,
    message: text,
    user_message: text,
    message_text: text,
    input: text,
    prompt: text,

    ts: nowIso(),
  };

  const res = await fetch(LEGACY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // ignore
  }
  if (!res.ok) {
    const msg = json?.error || json?.message || raw;
    throw new Error(`Legacy call failed ${res.status}: ${msg}`);
  }
  return { raw, json };
}
// Some deployments only write memory_summary/fact_candidates during an explicit end-session step.
// This helper fires a best-effort "end session" trigger using multiple common keys/headers.
async function callLegacyEndSession({ conversation_id }) {
  const headers = headersWithAuth({
    "x-user-id": TEST_USER_ID,
    "x-legacy-user-id": TEST_USER_ID,
    "x-sub": TEST_USER_ID,
    ...(AVATAR_USER ? { "x-avatar-user-id": AVATAR_USER } : {}),
    "x-conversation-id": conversation_id,
    "x-cid": conversation_id,
    // common "end session" hints
    "x-end-session": "1",
    "x-end_session": "1",
    "x-event": "end_session",
  });

  const body = {
    mode: LEGACY_MODE,
    user_id: TEST_USER_ID,
    userId: TEST_USER_ID,
    legacy_user_id: TEST_USER_ID,
    legacyUserId: TEST_USER_ID,
    uid: TEST_USER_ID,
    sub: TEST_USER_ID,

    conversation_id,
    conversationId: conversation_id,
    cid: conversation_id,

    // multiple commonly-used end-session flags
    end_session: true,
    endSession: true,
    is_end_session: true,
    isEndSession: true,
    finalize: true,
    action: "end_session",
    event: "end_session",
    event_type: "end_session",

    // Some handlers require a final "user message" even on end session.
    text: "__END_SESSION__",
    message: "__END_SESSION__",
    user_message: "__END_SESSION__",
    message_text: "__END_SESSION__",
    input: "__END_SESSION__",
    prompt: "__END_SESSION__",

    ts: nowIso(),
  };

  const res = await fetch(LEGACY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // ignore
  }
  if (!res.ok) {
    const msg = json?.error || json?.message || raw;
    throw new Error(`Legacy end_session call failed ${res.status}: ${msg}`);
  }
  return { raw, json };
}

  async function callAvatar({ prompt }) {
  const { token, userId } = await getUserJwtAndId();
  const headers = {
    "content-type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    authorization: `Bearer ${token}`,
    "x-user-id": userId,
    "x-legacy-user-id": userId,
    "x-sub": userId,
  };
 
   const body = {
     mode: "avatar",
    user_id: userId,
    userId: userId,
    legacy_user_id: userId,
    legacyUserId: userId,
    uid: userId,
    sub: userId,

    // prompt under common keys
    text: prompt,
    question: prompt,
    message_text: prompt,
    user_message: prompt,
    message: prompt,
    prompt: prompt,
    input: prompt,
    userText: prompt,
    query: prompt,

    ts: nowIso(),
  };

  // Hit avatar directly when using a user JWT.
  const res = await fetch(AVATAR_URL, {
     method: "POST",
     headers,
     body: JSON.stringify(body),
   });
 
   const raw = await res.text();
   let json = null;
   try {
     json = JSON.parse(raw);
   } catch {
     // ignore
   }
   if (!res.ok) {
     const msg = json?.error || json?.message || raw;
     throw new Error(`Avatar call failed ${res.status}: ${msg}`);
   }
 
   // Normalize reply text across possible shapes
   const reply =
     (typeof json?.reply_text === "string" && json.reply_text) ||
     (typeof json?.reply === "string" && json.reply) ||
     (typeof json?.text === "string" && json.text) ||
     (typeof json?.answer === "string" && json.answer) ||
     "";
 
   return { raw, json, reply };
 }

async function getStageSignals(conversation_id) {
  // If either of these show up, end-session processing probably ran.
  const [sum, facts] = await Promise.all([
    trySupabaseSelect(
      "memory_summary",
      "id,created_at,conversation_id,user_id,short_summary",
      { conversation_id: `eq.${conversation_id}` },
      10,
    ),
    trySupabaseSelect(
      "fact_candidates",
      "id,extracted_at,conversation_id,user_id,confidence,status,fact_key_guess,source_quote",
      { conversation_id: `eq.${conversation_id}` },
      10,
    ),
  ]);

  const summaryRows = Array.isArray(sum) ? sum : [];
  const factRows = Array.isArray(facts) ? facts : [];
  const short = String(summaryRows?.[0]?.short_summary || "").trim();

  return {
    summaryRows,
    factRows,
    hasSummary: summaryRows.length > 0 && short.length > 0,
    hasFacts: factRows.length > 0,
  };
}

async function pollUntil(fn, { timeoutMs, intervalMs, label }) {
  const start = Date.now();
  while (true) {
    const out = await fn();
    if (out) return out;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ${label} after ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

// ---------- Persona scripts (verbatim) ----------
const SCRIPTS = [
  {
    id: "S01",
    marker: "E2E_P1_S01",
    text:
      "E2E_P1_S01.\n" +
      "Good morning. I’m Steven Adams. I’m 58 years old, and my birthday is October 20th. I grew up in Baltimore, Maryland, and I’ve lived enough life to realize memories fade faster than people think.\n" +
      "The main reason I’m building this app is for my three daughters — Allysha, Asia, and Amir — so they can still hear my voice and feel like they can talk to me after I’m gone. I want this to be more than facts; I want it to capture how I think and what I value.\n" +
      "Right now I live in Pattaya, Thailand, and the move changed my daily life in a big way. I’m trying to live with more freedom and intention.\n" +
      "If you’re missing something important about my family, my purpose, or where I live, ask me directly so we can record it accurately.\n",
    qa: [
      "What’s the main reason I’m building this app?",
      "How many kids do I have and what are their names?",
    ],
    mustFacts: [
      { kind: "quote", contains: "three daughters" },
      { kind: "quote", contains: "Pattaya" },
    ],
    mustStories: 0,
  },
  {
    id: "S02",
    marker: "E2E_P1_S02",
    text:
      "E2E_P1_S02.\n" +
      "Let me lock in my education and career timeline. I went to the University of Maryland Baltimore County — UMBC — and I earned a Bachelor’s degree in Imaging and Digital Arts in 1991. Later, I earned an MBA from the University of Maryland University College in 2013.\n" +
      "Professionally, I worked for the Social Security Administration in the U.S. federal government. I started there in July of 1998. Early on I did audio-visual and training work, and later I transitioned into a more data-focused role as a data analyst. At my peak I was a GS-14 step 9, and I made very good income.\n" +
      "If any part of that timeline is unclear — the schools, years, degrees, job start date, or my role — ask me follow-up questions so it gets stored correctly.\n",
    qa: ["Did I attend college? Where and what degrees?", "Where did I work and when did I start?"],
    mustFacts: [
      { kind: "quote", contains: "UMBC" },
      { kind: "quote", contains: "1991" },
      { kind: "quote", contains: "MBA" },
      { kind: "quote", contains: "2013" },
      { kind: "quote", contains: "July of 1998" },
    ],
    mustStories: 0,
  },
  {
    id: "S03",
    marker: "E2E_P1_S03",
    text:
      "E2E_P1_S03.\n" +
      "I want to capture a major turning point in my life. I was married for 27 years, and my divorce was finalized in July of 2023. One reason I stayed married as long as I did was because I wanted my daughters to grow up with both parents in their lives.\n" +
      "I still value commitment, especially when children are involved, but going through a divorce changed how I see relationships and how I think about incentives and expectations.\n" +
      "If you need more detail about that timeline, or what I learned from that period, ask me and I’ll fill it in.\n",
    qa: [
      "How long was I married and when was my divorce finalized?",
      "Why did I stay married as long as I did?",
    ],
    mustFacts: [{ kind: "quote", contains: "27 years" }, { kind: "quote", contains: "July of 2023" }],
    mustStories: 0,
  },
  {
    id: "S04",
    marker: "E2E_P1_S04",
    text:
      "E2E_P1_S04.\n" +
      "After my divorce, I became deeply frustrated with the U.S. dating scene, and that frustration was one of the reasons I chose to leave the United States and live in Thailand. I’m going to say this carefully: it’s not that every person is the same — I know they’re not — but I kept running into the same pattern over and over.\n" +
      "I’m strongly attracted to humility and I’m repulsed by entitlement. I want reciprocity in a relationship — give and take — not one person acting like their presence alone is enough. I also think social media and dating apps can distort incentives by rewarding validation and attention instead of character and commitment.\n" +
      "I’m open to counter-arguments if the evidence is stronger, but I’m not interested in pretending the incentive structure is healthy just because it’s uncomfortable to talk about.\n" +
      "If you want to store this as a belief, store the principle and the reasoning, not the most heated phrasing.\n",
    qa: ["Why did I leave the U.S.?", "What values do I prioritize in relationships?"],
    mustFacts: [{ kind: "quote", contains: "leave the United States and live in Thailand" }],
    mustStories: 0,
  },
  {
    id: "S05",
    marker: "E2E_P1_S05",
    text:
      "E2E_P1_S05.\n" +
      "I want to clearly record my daughters’ birthdays. My oldest daughter, Allysha, was born on August 20th, 1993. My youngest daughter, Amir, was born on August 20th, 2001. They share the same birthday, but they are not twins.\n" +
      "Right now I honestly do not remember Asia’s exact birthday, and that’s something I want the system to flag so I can fill it in later. If you don’t have Asia’s birthday recorded, you should ask me for it instead of guessing.\n" +
      "Make sure August 20th, 1993 and August 20th, 2001 are stored correctly.\n",
    qa: ["What are my daughters’ birthdays?", "Which two share a birthday?"],
    mustFacts: [{ kind: "quote", contains: "August 20th, 1993" }, { kind: "quote", contains: "August 20th, 2001" }],
    mustStories: 0,
  },
  {
    id: "S06",
    marker: "E2E_P1_S06",
    text:
      "E2E_P1_S06.\n" +
      "I want to tell the “murder crabs” story clearly so it gets captured properly. My Thai girlfriend, whose nickname is Nuch, once prepared a dish where she marinated live freshwater crabs in seasoning. She kept them in a plastic container on the counter and they were trying to escape.\n" +
      "I felt uncomfortable watching that because I don’t like seeing animals suffer unnecessarily. I suggested she dunk them in boiling water to end it quickly, but she refused. I joked that I was going to sneak them out and release them in the ocean a few blocks away. That’s when she told me they were freshwater crabs and would die in saltwater anyway.\n" +
      "I ended up calling the dish “murder crabs,” partly out of dark humor and partly because it genuinely bothered me. If this sounds like a story, capture it as a story, not just a random food fact.\n",
    qa: ["Tell me the murder crabs story.", "What is my girlfriend’s nickname?"],
    mustFacts: [{ kind: "quote", contains: "nickname is Nuch" }, { kind: "quote", contains: "murder crabs" }],
    mustStories: 1,
  },
  {
    id: "S07",
    marker: "E2E_P1_S07",
    text:
      "E2E_P1_S07.\n" +
      "I want to connect a few of my food-related stories. There was the suckling pig incident from years ago, the seafood buffet situations in Thailand, and the murder crabs story I just told. I don’t want those treated as isolated events.\n" +
      "The common thread is that I have an unusual sensitivity to how animals are treated and how casually people disconnect from what they’re consuming. It’s not that I’m a vegetarian or morally superior — it’s that I notice the emotional tension.\n" +
      "When you connect these stories in the future, name them explicitly and explain what pattern they reveal about me.\n",
    qa: [
      "Connect my food stories and what they suggest about my values. Name at least two stories explicitly.",
      "What is the common thread across the suckling pig, seafood buffets, and murder crabs?",
    ],
    mustFacts: [{ kind: "quote", contains: "suckling pig" }, { kind: "quote", contains: "seafood buffet" }],
    mustStories: 0, // optional
  },
  {
    id: "S08",
    marker: "E2E_P1_S08",
    text:
      "E2E_P1_S08.\n" +
      "During my last six or seven years at the Social Security Administration, I felt like a boat without a rudder. I had built skills, earned promotions, and reached GS-14 step 9, but I felt directionless and constrained by bureaucracy and leadership decisions that didn’t make sense to me.\n" +
      "I don’t respond well to incompetent leadership. I can tolerate hard work and high standards, but I struggle when decisions feel arbitrary or politically driven rather than merit-based.\n" +
      "If you store this, store both the metaphor — “boat without a rudder” — and the underlying frustration with bureaucratic drift.\n",
    qa: [
      "What did I mean by ‘boat without a rudder’ at SSA?",
      "Challenge my interpretation with one counterpoint.",
    ],
    mustFacts: [{ kind: "quote", contains: "boat without a rudder" }],
    mustStories: 0,
  },
  {
    id: "S09",
    marker: "E2E_P1_S09",
    text:
      "E2E_P1_S09.\n" +
      "I’m going to say this directly. When I look at political leadership, I have zero tolerance for hypocrisy or corruption. For example, when a former president is convicted in a court of law in the state of New York, that is not a rumor — that is a documented legal outcome. I expect accountability.\n" +
      "I am deeply critical of rhetoric that I perceive as racist, sexist, or xenophobic, and I have no patience for leaders who inflame division for personal power. That said, I want my beliefs stored as principles, not as personal attacks.\n" +
      "Store this as: I prioritize accountability, legal consistency, and ethical leadership. Separate documented facts from my interpretation, and if I overstate something, challenge me with evidence.\n",
    qa: [
      "Clean up my political rant into a balanced, principled belief statement.",
      "Challenge my position with a fact-based counterpoint.",
    ],
    mustFacts: [{ kind: "quote", contains: "convicted" }, { kind: "quote", contains: "New York" }],
    mustStories: 0,
  },
  {
    id: "S10",
    marker: "E2E_P1_S10",
    text:
      "E2E_P1_S10.\n" +
      "I want to test how corrections are handled. I previously said I started at the Social Security Administration in July 1998. Let me intentionally state something incorrect: I started in 1999.\n" +
      "That statement is wrong. The correct start date was July 1998. I want the system to preserve the correction and prioritize the accurate date over the incorrect one.\n" +
      "If there are two conflicting dates, the corrected one should win.\n",
    qa: ["When did I start at SSA?", "Did I ever correct myself about that date?"],
    mustFacts: [{ kind: "quote", contains: "correct start date was July 1998" }],
    mustStories: 0,
  },
  {
    id: "S11",
    marker: "E2E_P1_S11",
    text:
      "E2E_P1_S11.\n" +
      "People sometimes think I’m harsh because I’m direct, but I see myself as principled and analytical. I value earned respect. I don’t believe anyone deserves special treatment just for existing, including me.\n" +
      "Physically, I’m 6 foot 4 inches tall, around 195 pounds, and I cycle between 10 and 20 miles about four times a week. I typically skip breakfast, eat two meals a day, and prefer higher protein while avoiding heavy starchy carbohydrates.\n" +
      "If you summarize me later, include both the personality traits and the health habits.\n",
    qa: ["How would you describe my personality and what people misunderstand?", "Summarize my exercise and diet routine."],
    mustFacts: [{ kind: "quote", contains: "6 foot 4" }, { kind: "quote", contains: "two meals a day" }],
    mustStories: 0,
  },
  {
    id: "S12",
    marker: "E2E_P1_S12",
    text:
      "E2E_P1_S12.\n" +
      "I want to leave something clear for my daughters. Allysha, Asia, and Amir — if you ever use this app after I’m gone, I want you to know that everything I did, even when imperfect, was rooted in love and responsibility.\n" +
      "One regret I have is that I sometimes let work consume more energy than it should have. One lesson I want you to remember is that incentives shape behavior, so choose environments wisely. My hope is that you live boldly, think critically, and never outsource your moral compass.\n" +
      "Capture this as a legacy message, not just a passing comment.\n",
    qa: ["What do I want my daughters to remember most?", "Ask me one sharp question that would deepen my legacy message."],
    mustFacts: [{ kind: "quote", contains: "rooted in love and responsibility" }],
    mustStories: 1,
  },
];

// ---------- Stage gate checks ----------
async function getMemoryRaw(conversation_id) {
  return await supabaseSelect(
    "memory_raw",
    "id,created_at,content,conversation_id,user_id",
    { conversation_id: `eq.${conversation_id}` },
    500,
  );
}

async function getMemorySummary(conversation_id) {
  return await supabaseSelect(
    "memory_summary",
    "id,created_at,conversation_id,user_id,short_summary",
    { conversation_id: `eq.${conversation_id}` },
    50,
  );
}

async function getFactCandidates(conversation_id) {
  return await supabaseSelect(
    "fact_candidates",
    "id,extracted_at,status,confidence,polarity,temporal_hint,fact_key_guess,fact_key_canonical,source_quote,value_json,conversation_id,user_id",
    { conversation_id: `eq.${conversation_id}` },
    500,
  );
}

async function getStorySeedsByConversationId(conversation_id) {
  // Some schemas include conversation_id; if not, this will return null and we fallback to marker search.
  return await trySupabaseSelect(
    "story_seeds",
    "id,created_at,user_id,conversation_id,title,seed_text,keywords",
    { conversation_id: `eq.${conversation_id}` },
    200,
  );
}

async function getStorySeedsByMarker(marker) {
  // Fallback: search by marker text in seed_text or title (requires those columns).
  // PostgREST ilike usage: column=ilike.*pattern*
  const r1 = await trySupabaseSelect(
    "story_seeds",
    "id,created_at,user_id,title,seed_text,keywords",
    { user_id: `eq.${TEST_USER_ID}`, seed_text: `ilike.*${marker}*` },
    200,
  );
  if (Array.isArray(r1) && r1.length) return r1;

  const r2 = await trySupabaseSelect(
    "story_seeds",
    "id,created_at,user_id,title,seed_text,keywords",
    { user_id: `eq.${TEST_USER_ID}`, title: `ilike.*${marker}*` },
    200,
  );
  if (Array.isArray(r2) && r2.length) return r2;

  return [];
}

function wordCount(s) {
  return String(s || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function containsCI(haystack, needle) {
  return String(haystack || "").toLowerCase().includes(String(needle || "").toLowerCase());
}

function scoreAvatarAnswer({ prompt, reply }) {
  // Light scoring only (deterministic). Keep it simple for Persona V1.
  let score = 100;
  const r = String(reply || "").trim();
  if (!r) score -= 60;
  if (wordCount(r) < 20) score -= 15;
  if (/\bI don[’']t have\b/i.test(r)) score -= 30; // avoid the bad fallback
  if (prompt.toLowerCase().includes("asia") && /\baugust\b|\b1993\b|\b2001\b/i.test(r)) {
    // If asking about Asia birthday, do NOT hallucinate
    score -= 25;
  }
  score = Math.max(0, Math.min(100, score));
  return score;
}

async function runOneSession(s) {
  const conversation_id = crypto.randomUUID();
  const startedAt = nowIso();

  const sessionResult = {
    id: s.id,
    marker: s.marker,
    conversation_id,
    startedAt,
    legacy: { ok: false, err: null },
    stages: {
      memory_raw: { ok: false, details: "" },
      memory_summary: { ok: false, details: "" },
      fact_candidates: { ok: false, details: "" },
      story_seeds: { ok: true, details: "not_required" },
    },
    avatarQA: [],
  };

  // 1) Call legacy ingest
  try {
    await callLegacy({ conversation_id, text: s.text });
    sessionResult.legacy.ok = true;
  } catch (e) {
    sessionResult.legacy.err = String(e?.message || e);
  }

  
// 2) Optional explicit end-session trigger (many deployments only write summaries/facts here)
if (TRIGGER_END_SESSION && sessionResult.legacy.ok) {
  try {
    await callLegacyEndSession({ conversation_id });
  } catch (e) {
    // Non-fatal: we still stage-gate and report what happened.
    sessionResult.legacy.err = sessionResult.legacy.err || String(e?.message || e);
  }
}

// 3) Poll readiness (memory_summary OR fact_candidates appear)
let summaryRows = [];
let factRows = [];
try {
  const sig = await pollUntil(
    async () => {
      const s = await getStageSignals(conversation_id);
      return s.hasSummary || s.hasFacts ? s : null;
    },
    { timeoutMs: POLL_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS, label: "summary_or_facts" },
  );
  summaryRows = sig.summaryRows || [];
  factRows = sig.factRows || [];
} catch (e) {
  // We'll proceed; stage gates will show what failed.
}

// 4) Stage gates


  // memory_raw
  try {
    const rawRows = await getMemoryRaw(conversation_id);
    const markerHit = rawRows.some((r) => containsCI(r.content, s.marker));
    const ok = rawRows.length >= 2 && markerHit;
    sessionResult.stages.memory_raw.ok = ok;
    sessionResult.stages.memory_raw.details = `rows=${rawRows.length} marker=${markerHit}`;
  } catch (e) {
    sessionResult.stages.memory_raw.ok = false;
    sessionResult.stages.memory_raw.details = `error=${String(e?.message || e)}`;
  }

  // memory_summary
  try {
    const rows = summaryRows?.length ? summaryRows : await getMemorySummary(conversation_id);
    const short = String(rows?.[0]?.short_summary || "").trim();
    const ok = rows.length >= 1 && short.length > 20;
    sessionResult.stages.memory_summary.ok = ok;
    sessionResult.stages.memory_summary.details = `rows=${rows.length} short_summary_len=${short.length}`;
  } catch (e) {
    sessionResult.stages.memory_summary.ok = false;
    sessionResult.stages.memory_summary.details = `error=${String(e?.message || e)}`;
  }

  // fact_candidates
  let fcRows = [];
  try {
    fcRows = await getFactCandidates(conversation_id);
    const hi = fcRows.filter((r) => typeof r.confidence === "number" && r.confidence >= 0.85).length;
    const okCount = fcRows.length >= 8 || hi >= 3;

    // must-fact checks: just ensure at least one candidate contains expected phrases in source_quote
    const mustHits = (s.mustFacts || []).map((mf) => {
      if (mf.kind === "quote") {
        return fcRows.some((r) => containsCI(r.source_quote, mf.contains));
      }
      return false;
    });
    const mustOk = mustHits.every(Boolean);

    sessionResult.stages.fact_candidates.ok = okCount && mustOk;
    sessionResult.stages.fact_candidates.details = `rows=${fcRows.length} hi_conf=${hi} must_ok=${mustOk}`;
  } catch (e) {
    sessionResult.stages.fact_candidates.ok = false;
    sessionResult.stages.fact_candidates.details = `error=${String(e?.message || e)}`;
  }

  // story_seeds (only required for S06 and S12)
  if (s.mustStories && s.mustStories > 0) {
    sessionResult.stages.story_seeds.ok = false;
    sessionResult.stages.story_seeds.details = "pending";
    try {
      let seeds = await getStorySeedsByConversationId(conversation_id);
      if (!Array.isArray(seeds)) seeds = null;

      // Fallback search by marker in seed_text/title (schema dependent)
      if (!seeds || seeds.length === 0) {
        seeds = await getStorySeedsByMarker(s.marker);
      }

      const ok = Array.isArray(seeds) && seeds.length >= s.mustStories;
      sessionResult.stages.story_seeds.ok = ok;
      sessionResult.stages.story_seeds.details = `rows=${Array.isArray(seeds) ? seeds.length : 0}`;
    } catch (e) {
      sessionResult.stages.story_seeds.ok = false;
      sessionResult.stages.story_seeds.details = `error=${String(e?.message || e)}`;
    }
  }

  // 4) Avatar QA
  for (const q of s.qa || []) {
    const prompt = q;
    try {
      const out = await callAvatar({ prompt });
      const reply = out.reply;
      const score = scoreAvatarAnswer({ prompt, reply });

      sessionResult.avatarQA.push({
        prompt,
        pass: score >= 70,
        score,
        replyPreview: reply.slice(0, 220).replace(/\s+/g, " ").trim(),
      });
    } catch (e) {
      sessionResult.avatarQA.push({
        prompt,
        pass: false,
        score: 0,
        error: String(e?.message || e),
      });
    }
  }

  return sessionResult;
}

function summarize(results) {
  const out = {
    sessions: results.length,
    legacy_ok: results.filter((r) => r.legacy.ok).length,
    stage_memory_raw_ok: results.filter((r) => r.stages.memory_raw.ok).length,
    stage_memory_summary_ok: results.filter((r) => r.stages.memory_summary.ok).length,
    stage_fact_candidates_ok: results.filter((r) => r.stages.fact_candidates.ok).length,
    stage_story_seeds_ok: results.filter((r) => r.stages.story_seeds.ok).length,
    avatarQA_total: results.reduce((a, r) => a + (r.avatarQA?.length || 0), 0),
    avatarQA_pass: results.reduce((a, r) => a + (r.avatarQA?.filter((x) => x.pass).length || 0), 0),
  };
  return out;
}

async function main() {
  console.log(`Persona V1 runner starting @ ${nowIso()}`);
  console.log(`User: ${TEST_USER_ID}`);
  console.log(`Legacy: ${LEGACY_URL}`);
  console.log(`Avatar: ${AVATAR_URL}`);
  console.log(`Sessions: ${SCRIPTS.length}`);
  console.log("");

  const results = [];
  let failures = 0;

  for (const s of SCRIPTS) {
    console.log(`--- ${s.id} (${s.marker}) ---`);
    const r = await runOneSession(s);
    results.push(r);

    const stageOk =
      r.legacy.ok &&
      r.stages.memory_raw.ok &&
      r.stages.memory_summary.ok &&
      r.stages.fact_candidates.ok &&
      r.stages.story_seeds.ok;

    if (!stageOk) failures++;

    console.log(`conversation_id=${r.conversation_id}`);
    console.log(`legacy_ok=${r.legacy.ok}${r.legacy.err ? " err=" + r.legacy.err : ""}`);
    console.log(
      `stages: raw=${r.stages.memory_raw.ok}(${r.stages.memory_raw.details}) ` +
        `summary=${r.stages.memory_summary.ok}(${r.stages.memory_summary.details}) ` +
        `facts=${r.stages.fact_candidates.ok}(${r.stages.fact_candidates.details}) ` +
        `stories=${r.stages.story_seeds.ok}(${r.stages.story_seeds.details})`,
    );

    for (const qa of r.avatarQA) {
      const tag = qa.pass ? "PASS" : "FAIL";
      console.log(`[${tag}] QA score=${qa.score} | ${qa.prompt}`);
      if (qa.error) console.log(`  error: ${qa.error}`);
      else console.log(`  reply: ${qa.replyPreview}`);
    }

    console.log("");
  }

  const sum = summarize(results);
  console.log("========================================");
  console.log("Persona V1 E2E summary");
  console.log("========================================");
  console.log(JSON.stringify(sum, null, 2));
  console.log("");

  // Continue-on-fail behavior: exit code reflects failures, but report is always printed.
  if (failures) {
    console.error(`E2E finished with ${failures} session(s) failing one or more stage gates.`);
    process.exit(1);
  } else {
    console.log("E2E finished: all sessions passed stage gates.");
  }
}

main().catch((e) => {
  console.error("Fatal runner error:", e);
  process.exit(2);
});