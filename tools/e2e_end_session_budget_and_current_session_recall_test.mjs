#!/usr/bin/env node
/**
 * E2E: End-session budget + current-session recall
 *
 * Fails if:
 *  - Gemini says "not recorded yet" for facts stated earlier THIS session
 *  - End-session exceeds time budget
 *  - memory_summary still contains heavy artifacts in ui_fast mode
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SB_SECRET_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SB_SECRET_KEY;
const TEST_USER_ID = mustEnv("TEST_USER_ID");

const END_SESSION_MAX_MS = Number(process.env.END_SESSION_MAX_MS || "8000");

const client = createClient(SUPABASE_URL, SB_SECRET_KEY, {
  auth: { persistSession: false },
  global: {
    headers: {
      apikey: SB_SECRET_KEY,
      Authorization: `Bearer ${SB_SECRET_KEY}`,
    },
  },
});

function mustEnv(k) {
  const v = String(process.env[k] || "").trim();
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

function uuid() {
  return crypto.randomUUID();
}

async function invokeAiBrain(body) {
  const { data, error } = await client.functions.invoke("ai-brain", { body });
  if (error) throw new Error(error.message || String(error));
  return data;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveEffectiveConversationId(user_id, expectedSubstr) {
  // Find the actual conversation_id that received the user's message.
  // This avoids false failures when ai-brain rewrites/creates conversation_id internally.
  const { data, error } = await client
    .from("memory_raw")
    .select("conversation_id, content, created_at")
    .eq("user_id", user_id)
    .eq("role", "user")
    .ilike("content", `%${expectedSubstr}%`)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : null;
  return (row?.conversation_id || "").toString().trim();
}

async function latestSummary(user_id, conversation_id) {
  const { data, error } = await client
    .from("memory_summary")
    .select("*")
    .eq("user_id", user_id)
    .eq("conversation_id", conversation_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

(async function main() {
  let convo = uuid();

  console.log("E2E current-session recall + end-session budget", { convo });

  // ── Session fact
  await invokeAiBrain({
    user_id: TEST_USER_ID,
    conversation_id: convo,
    message_text:
      "I earned a Master of Business Administration from the University of Maryland University College in 2013.",
    mode: "legacy",
  });

  // IMPORTANT: make sure we use the same conversation_id that actually stored the user turn.
  // If ai-brain uses an internal effectiveConversationId, this prevents false test failures.
  await sleep(300);
  const effectiveConvo = await resolveEffectiveConversationId(
    TEST_USER_ID,
    "Master of Business Administration"
  );
  assert.ok(
    effectiveConvo,
    "Failed to resolve effective conversation_id from memory_raw (turn not persisted or content mismatch)"
  );
  convo = effectiveConvo;
  console.log("Resolved effective conversation_id:", convo);

  // Sanity: ensure the user turn is actually present in memory_raw for this convo
  const { data: rawTurns, error: rawErr } = await client
    .from("memory_raw")
    .select("role,source,content,created_at")
    .eq("user_id", TEST_USER_ID)
    .eq("conversation_id", convo)
    .order("created_at", { ascending: true });
  if (rawErr) throw rawErr;
  const userTurns = (rawTurns || []).filter((t) => t.role === "user");
  assert.ok(userTurns.length >= 1, "Expected at least 1 user turn in memory_raw for resolved conversation_id");

  // Add a unique marker that MUST be visible via RECENT TURNS if that block is injected.
  const marker = `MBA_MARKER_${Date.now()}`;
  await invokeAiBrain({
    user_id: TEST_USER_ID,
    conversation_id: convo,
    message_text: `Diagnostic marker for this session: ${marker}`,
    mode: "legacy",
  });

  // Now ask in recall mode to repeat the marker from earlier in this session.
  const markerRecall = await invokeAiBrain({
    user_id: TEST_USER_ID,
    conversation_id: convo,
    message_text: "What diagnostic marker did I say earlier in this session? Reply with it verbatim.",
    active_task: "recall",
    mode: "legacy",
  });
  const markerText = String(markerRecall?.reply_text || markerRecall?.assistant_text || "");
  assert.ok(markerText.includes(marker), `RECENT TURNS not visible in recall prompt; expected marker ${marker} in reply:\n${markerText}`);

  // ── Recall immediately (must NOT say 'not recorded yet')
  const recall = await invokeAiBrain({
    user_id: TEST_USER_ID,
    conversation_id: convo,
    message_text: "When did I earn my MBA and where?",
    active_task: "recall",
    mode: "legacy",
  });

  const recallText = String(
    recall?.reply_text || recall?.assistant_text || ""
  ).toLowerCase();

  assert.ok(
    !/not recorded yet|do not have that recorded/.test(recallText),
    `FAIL recall ignored current session fact:\n${recallText}`
  );

  assert.ok(
    recallText.includes("2013") &&
      recallText.includes("university of maryland"),
    "FAIL recall did not use session fact content"
  );

  // ── End session (timed)
  const t0 = performance.now();
  await invokeAiBrain({
    user_id: TEST_USER_ID,
    conversation_id: convo,
    end_session: true,
    message_text: "__END_SESSION__",
    ui_fast: true,
    mode: "legacy",
  });
  const elapsed = Math.round(performance.now() - t0);

  console.log("end_session elapsed ms:", elapsed);

  assert.ok(
    elapsed <= END_SESSION_MAX_MS,
    `FAIL end_session too slow (${elapsed}ms > ${END_SESSION_MAX_MS}ms)`
  );

  await sleep(800);

  const summary = await latestSummary(TEST_USER_ID, convo);
  assert.ok(summary, "No memory_summary row");

  const insights = summary.session_insights || {};
  const forbiddenKeys = [
    "facts_review",
    "longitudinal_snapshot",
    "themes",
    "magical_insights",
    "derived_views",
  ];

  const offenders = forbiddenKeys.filter((k) => k in insights);
  assert.equal(
    offenders.length,
    0,
    `FAIL end_session generated forbidden artifacts in ui_fast: ${offenders.join(
      ", "
    )}`
  );

  console.log("✅ PASS: current session recall + end-session budget enforced");
})().catch((e) => {
  console.error("❌ FAIL", e);
  process.exit(1);
});
