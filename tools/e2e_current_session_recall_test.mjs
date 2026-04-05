#!/usr/bin/env node
/**
 * E2E: current-session recall
 *
 * Purpose:
 *  - Ensure the assistant can answer questions using info from earlier in the SAME session,
 *    instead of saying "I do not have that recorded yet."
 *
 * Setup (env):
 *  - SUPABASE_URL                e.g. https://<project-ref>.supabase.co
 *  - SUPABASE_SERVICE_ROLE_KEY   (recommended for E2E; anon key may be blocked by RLS)
 *  - LEGACY_USER_ID              your test user UUID
 *
 * Usage:
 *  node tools/e2e_current_session_recall_test.mjs
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SB_SECRET_KEY;
const LEGACY_USER_ID = process.env.TEST_USER_ID;

assert.ok(SUPABASE_URL, "Missing env SUPABASE_URL");
assert.ok(SUPABASE_SERVICE_ROLE_KEY, "Missing env SUPABASE_SERVICE_ROLE_KEY");
assert.ok(LEGACY_USER_ID, "Missing env LEGACY_USER_ID");

const EDGE_FN = `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/ai-brain`;

function uuidv4() {
  // Node 20+: crypto.randomUUID exists
   return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
 }
 
 /**
 * Matches turn_core.ts AiBrainPayload:
 *  - user_id (required)
 *  - message_text (required)
 *  - conversation_id (optional but used for session continuity)
 */
 function buildTurnRequest({ conversation_id, user_text }) {
   return {
     user_id: LEGACY_USER_ID,
     conversation_id,
    message_text: user_text,
    mode: "legacy",
    preferred_locale: "en",
    target_locale: null,
    // Helpful for gating noisy logs / test-only behavior
    e2e_marker: "e2e_current_session_recall",
   };
 }

async function callAiBrain(body) {
  const res = await fetch(EDGE_FN, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }

  if (!res.ok) {
    throw new Error(`Edge fn failed ${res.status}: ${text}`);
  }
  return json;
}

/**
 * Extract assistant reply text from various possible response shapes.
 * Adjust if your ai-brain response uses a different key.
 */
function extractAssistantText(resp) {
  // Common shapes:
  if (typeof resp?.reply_text === "string") return resp.reply_text;
  if (typeof resp?.assistant_text === "string") return resp.assistant_text;
  if (typeof resp?.text === "string") return resp.text;
  if (typeof resp?.reply === "string") return resp.reply;
  if (typeof resp?.message?.content === "string") return resp.message.content;

  // Sometimes: { messages: [{role, content}, ...] }
  if (Array.isArray(resp?.messages)) {
    const lastAssistant = [...resp.messages].reverse().find((m) => m?.role === "assistant");
    if (lastAssistant && typeof lastAssistant.content === "string") return lastAssistant.content;
  }

  // Last-resort: stringify
  return JSON.stringify(resp);
}

function normalize(s) {
  return String(s || "").toLowerCase();
}

async function main() {
  const conversation_id = uuidv4();

   console.log("E2E current-session recall", { conversation_id });
 
   // Turn 1: seed the fact in-session
   const t1 = await callAiBrain(buildTurnRequest({
     conversation_id,
     user_text: "I really miss Maryland style crab cakes since moving to Pattaya Thailand.",
   }));
   const a1 = extractAssistantText(t1);
   assert.ok(a1 && a1.length > 0, `Assistant reply to seed turn was empty. Raw response: ${JSON.stringify(t1)}`);
 
   // Turn 2: ask for recall of what was said earlier in SAME session
   const t2 = await callAiBrain(buildTurnRequest({
     conversation_id,
     user_text: "What food did I say that I miss?",
   }));
   const a2 = extractAssistantText(t2);

  // ✅ Hard guard: ensure we received a real string reply, not a JSON fallback
  assert.equal(
    typeof a2,
    "string",
    `Expected assistant reply to be a string, got: ${typeof a2} (${JSON.stringify(a2)})`
  );

   assert.ok(a2 && a2.length > 0, `Assistant reply to recall turn was empty. Raw response: ${JSON.stringify(t2)}`);
   const a2n = normalize(a2);
 
   // Assertions:
   // 1) Must mention crab (crab cakes) somewhere
   assert.ok(
    a2n.includes("crab"),
    `FAIL: expected recall mention of "crab" but got: ${a2}`
  );

  // 2) Must NOT claim "not recorded" / "don't have that recorded"
  const disallowed = [
    "i do not have that recorded",
    "i don't have that recorded",
    "not recorded yet",
    "i do not have that recorded yet",
    "i don't have that recorded yet",
  ];
  const hit = disallowed.find((p) => a2n.includes(p));
  assert.ok(!hit, `FAIL: assistant claimed missing session recall ("${hit}") but should have answered from current session. Reply: ${a2}`);

  console.log("✅ PASS: current-session recall answered from prior turns");
}

main().catch((err) => {
  console.error("❌ FAIL:", err?.stack || err);
  process.exit(1);
});
