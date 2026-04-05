#!/usr/bin/env node
/**
 * E2E: End-session latency & artifact budget + "current session awareness" recall
 *
 * Fails if:
 *  (A) End Session takes too long (default threshold 8s)
 *  (B) End Session writes too much clutter into memory_summary.session_insights (budgeted keys/lists)
 *  (C) Recall fails to use facts stated earlier IN THIS SESSION (e.g., MBA in 2013)
 *
 * ENV REQUIRED:
 *  SUPABASE_URL               e.g. https://<ref>.supabase.co
 *  SB_SECRET_KEY              service role key (needed to write/read DB)
 *  AI_BRAIN_FUNCTION_URL      optional override; defaults to `${SUPABASE_URL}/functions/v1/ai-brain`
 *
 * OPTIONAL:
 *  END_SESSION_MAX_MS         default 8000
 *  EXPECT_INSIGHTS_KEYS       comma list of allowed session_insights keys (default below)
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SRK = mustEnv("SB_SECRET_KEY");
const AI_BRAIN_FUNCTION_URL =
  process.env.AI_BRAIN_FUNCTION_URL || `${SUPABASE_URL}/functions/v1/ai-brain`;

const END_SESSION_MAX_MS = parseInt(process.env.END_SESSION_MAX_MS || "8000", 10);

const DEFAULT_ALLOWED_INSIGHTS_KEYS = new Set([
  "reframed",
  // keep the canonical summary fields if you store them here:
  "short_summary",
  "full_summary",
  // allow lightweight meta:
  "chapter_keys",
]);

const ALLOWED_INSIGHTS_KEYS = (() => {
  const s = (process.env.EXPECT_INSIGHTS_KEYS || "").trim();
  if (!s) return DEFAULT_ALLOWED_INSIGHTS_KEYS;
  return new Set(s.split(",").map((x) => x.trim()).filter(Boolean));
})();

const FAIL_PHRASES_RECALL = [
  "I do not have that recorded yet",
  "I don't have that recorded yet",
  "I do not have your",
  "I don't have your",
  "not recorded yet",
];

const headersJson = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${SRK}`,
};

const headersFunc = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${SRK}`,
};

async function main() {
  console.log("E2E: end-session latency + artifact budget + current-session recall");
  console.log("SUPABASE_URL:", SUPABASE_URL);
  console.log("AI_BRAIN_FUNCTION_URL:", AI_BRAIN_FUNCTION_URL);
  console.log("END_SESSION_MAX_MS:", END_SESSION_MAX_MS);

  // 1) Create a fresh conversation id by inserting a minimal conversation row (if your schema differs, adjust)
  // If you don't have a conversations table, you can skip this and let ai-brain create one (but then you must parse response).
  const userId = await ensureTestUserId();
  const conversationId = await createConversation(userId);

  // 2) Run a mini session that includes facts we want the model to use *within the same session*
  //    We deliberately include MBA year + school, then immediately ask recall.
  const turn1 = await callAiBrain({
    user_id: userId,
    conversation_id: conversationId,
    message: "I earned a masters of Business Administration from the University of Maryland University College in 2013.",
    entry_mode: "text",
  });

  assert.ok(turn1?.assistant_text, "turn1 missing assistant_text");

  const turn2 = await callAiBrain({
    user_id: userId,
    conversation_id: conversationId,
    message: "When did I earn my MBA, and where?",
    entry_mode: "text",
    active_task: "recall", // IMPORTANT: forces your recall protocol path
  });

  const answer2 = String(turn2?.assistant_text || "");
  // Gate: must not refuse with "not recorded yet", and must include 2013 + UMUC phrase.
  assertNoFailPhrases(answer2, FAIL_PHRASES_RECALL, "Recall used 'not recorded yet' despite current-session fact");
  assert.match(answer2, /2013/, "Recall answer did not include year 2013 from current session");
  assert.match(
    answer2.toLowerCase(),
    /(university of maryland.*(university college|umuc))/i,
    "Recall answer did not include UMUC / University of Maryland University College from current session"
  );

  // 3) Trigger End Session and measure time-to-response.
  // Your edge function may use a special message or flag. This is the only likely tweak area.
  const t0 = performance.now();
  const endResp = await callAiBrain({
    user_id: userId,
    conversation_id: conversationId,
    message: "__END_SESSION__",
    entry_mode: "end_session",
    is_end_session: true,
    // Encourage your fast path if your turn_core reads this:
    ui_fast: true,
  });
  const elapsed = Math.round(performance.now() - t0);
  console.log("End-session elapsed (ms):", elapsed);

  assert.ok(
    elapsed <= END_SESSION_MAX_MS,
    `End Session too slow: ${elapsed}ms > ${END_SESSION_MAX_MS}ms. This indicates heavy artifacts still being generated on critical path.`
  );

  // 4) Artifact budget check: read the memory_summary row for this conversation.
  // Expect exactly one row (user_id, conversation_id), newest.
  const ms = await fetchLatestMemorySummary(userId, conversationId);
  assert.ok(ms, "No memory_summary row found after end-session");
  const sessionInsights = safeJson(ms.session_insights);

  // 4a) Ensure session_insights doesn’t contain heavy junk keys by default.
  if (sessionInsights && typeof sessionInsights === "object") {
    const keys = Object.keys(sessionInsights);
    const disallowed = keys.filter((k) => !ALLOWED_INSIGHTS_KEYS.has(k));
    assert.equal(
      disallowed.length,
      0,
      `memory_summary.session_insights contains disallowed keys: ${disallowed.join(", ")}. These are likely clutter artifacts.`
    );

    // 4b) Ensure reframed is small / bounded when present
    if (sessionInsights.reframed) {
      const r = sessionInsights.reframed;
      if (Array.isArray(r.reflections)) assert.ok(r.reflections.length <= 4, "reframed.reflections too long");
      if (Array.isArray(r.rare_insights)) assert.ok(r.rare_insights.length <= 2, "reframed.rare_insights too long");
      if (typeof r.short_summary === "string") assert.ok(r.short_summary.length <= 600, "reframed.short_summary too long");
    }
  }

  // 4c) Ensure the *heavy* artifacts are not generated by default in ui_fast mode
  //     This checks fields that often bloat and imply extra LLM calls.
  const rawSessionInsightsStr = JSON.stringify(sessionInsights || {});
  assert.ok(rawSessionInsightsStr.length <= 12000, "session_insights JSON too large (likely clutter still generated)");

  console.log("✅ PASS: recall used current-session facts, end-session latency within budget, session_insights within clutter budget.");
}

function mustEnv(k) {
  const v = process.env[k];
  if (!v || !String(v).trim()) {
    console.error(`Missing required env var: ${k}`);
    process.exit(2);
  }
  return v.trim();
}

function assertNoFailPhrases(text, phrases, msg) {
  const lower = (text || "").toLowerCase();
  for (const p of phrases) {
    if (lower.includes(p.toLowerCase())) {
      assert.fail(`${msg}\nFound phrase: "${p}"\nFull answer:\n${text}`);
    }
  }
}

function safeJson(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

async function ensureTestUserId() {
  // If you already have a standard test user in your env, use it.
  // Otherwise, we try to pick the first user from auth.users (may fail if not exposed).
  if (process.env.TEST_USER_ID) return process.env.TEST_USER_ID.trim();

  // Fallback: create a synthetic user_id (UUID v4) for DB rows that accept arbitrary UUID.
  // NOTE: If you enforce FK to auth.users, set TEST_USER_ID in env.
  const id = cryptoRandomUUID();
  console.warn("TEST_USER_ID not set; using synthetic UUID:", id);
  return id;
}

async function createConversation(userId) {
  // Adjust if your schema differs. If you don't have public.conversations, set TEST_CONVERSATION_ID instead.
  if (process.env.TEST_CONVERSATION_ID) return process.env.TEST_CONVERSATION_ID.trim();

  const body = { user_id: userId };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/conversations`, {
    method: "POST",
    headers: { ...headersJson, "Prefer": "return=representation" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Failed to create conversation (${res.status}): ${t}`);
  }
  const rows = await res.json();
  const row = rows?.[0];
  const conversationId = row?.id;
  assert.ok(conversationId, "conversations insert returned no id");
  return conversationId;
}

async function fetchLatestMemorySummary(userId, conversationId) {
  const url =
    `${SUPABASE_URL}/rest/v1/memory_summary` +
    `?select=*&user_id=eq.${encodeURIComponent(userId)}` +
    `&conversation_id=eq.${encodeURIComponent(conversationId)}` +
    `&order=created_at.desc` +
    `&limit=1`;
  const res = await fetch(url, { headers: headersJson });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Failed to fetch memory_summary (${res.status}): ${t}`);
  }
  const rows = await res.json();
  return rows?.[0] || null;
}

async function callAiBrain(payload) {
  // This payload shape is the most likely place you must tweak.
  // If your ai-brain expects { entry_mode, message, conversation_id, user_id }, this should work.
  const res = await fetch(AI_BRAIN_FUNCTION_URL, {
    method: "POST",
    headers: headersFunc,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Some deployments return plain text on error.
  }
  if (!res.ok) {
    throw new Error(`ai-brain failed (${res.status}): ${text}`);
  }
  // Normalize: your function may return { reply_text } or { assistant_text }
  const assistant_text =
    (json && (json.assistant_text || json.reply_text || json.text)) ||
    (typeof text === "string" ? text : "");
  return { ...json, assistant_text };
}

// Minimal UUID v4 generator (no deps)
function cryptoRandomUUID() {
  // Node 20+ has crypto.randomUUID; keep a fallback.
  try {
    // eslint-disable-next-line no-undef
    return crypto.randomUUID();
  } catch {
    const s = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    return `${s()}${s()}-${s()}-${s()}-${s()}-${s()}${s()}${s()}`;
  }
}

main().catch((e) => {
  console.error("❌ FAIL:", e?.stack || e);
  process.exit(1);
});
