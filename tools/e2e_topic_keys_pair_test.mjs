#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

function mustGet(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing env var ${name}`);
  return v.trim();
}

async function callEdgeFunction({ supabaseUrl, serviceKey, functionName, body }) {
  const url = `${supabaseUrl}/functions/v1/${functionName}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // no end-user JWT; service key is allowed
      authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }

  if (!resp.ok) {
    throw new Error(
      `Edge function ${functionName} failed: ${resp.status} ${resp.statusText}\n` +
      (json ? JSON.stringify(json) : text)
    );
  }

  return json ?? text;
}

async function main() {
  const SUPABASE_URL = mustGet("SUPABASE_URL");
  const SERVICE = mustGet("SUPABASE_SERVICE_ROLE_KEY");
  const AVATAR_USER = mustGet("AVATAR_USER");

  // provided per request (not used here)
  process.env.SUPABASE_ANON_KEY;
  process.env.E2E_EMAIL;
  process.env.E2E_PASSWORD;

  const admin = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const marker = `e2e_topic_keys_${Date.now()}_${crypto.randomUUID()}`;
  const conversation_id = crypto.randomUUID();

  const payload = {
    user_id: AVATAR_USER,
    conversation_id,
    message_text:
      `[${marker}] E2E: I am building a legacy app so my kids can hear me; I want it to have purpose and meaning.`,
    mode: "legacy",
    end_session: false,
    entry_mode: "freeform",
    prompt_id: null,
    e2e_marker: marker,
  };

  const edgeResp = await callEdgeFunction({
    supabaseUrl: SUPABASE_URL,
    serviceKey: SERVICE,
    functionName: "ai-brain",
    body: payload,
  });

  console.log("Edge response (truncated):", String(edgeResp).slice(0, 300));

  // Query by marker (robust even if conversation_id is altered upstream)
  const { data: rows, error: selErr } = await admin
    .from("memory_raw")
    .select("id, role, topic_keys, context, tags, conversation_id, created_at, content")
    .eq("user_id", AVATAR_USER)
    .gte("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString())
    // Correct: marker is written to context.e2e_marker by the edge function.
    .contains("context", { e2e_marker: marker })
    .order("created_at", { ascending: true });

  if (selErr) throw selErr;

  console.log("Found rows:", rows?.length ?? 0);
  if (rows?.length) {
    console.log("Conversation IDs seen:", [...new Set(rows.map(r => r.conversation_id))]);
  }

  assert.ok(rows && rows.length >= 2, `Expected >=2 rows, got ${rows ? rows.length : 0}`);

  const marked = rows.filter((r) => (r.context?.e2e_marker === marker) || (r.content || "").includes(marker));
  assert.ok(marked.length >= 2, `Expected >=2 marked rows, got ${marked.length}`);

  const userRow = marked.find((r) => r.role === "user");
  const aiRow = marked.find((r) => r.role === "assistant");
  assert.ok(userRow, "Missing user row");
  assert.ok(aiRow, "Missing assistant row");

  const userKeys = Array.isArray(userRow.topic_keys) ? userRow.topic_keys : [];
  const aiKeys = Array.isArray(aiRow.topic_keys) ? aiRow.topic_keys : [];

  assert.ok(userKeys.length > 0, "Expected user topic_keys to be non-empty");
  assert.deepEqual(aiKeys, userKeys, "Expected assistant topic_keys to match user topic_keys exactly");

  // cleanup: delete only rows with marker
  const { error: delErr } = await admin
    .from("memory_raw")
    .delete()
    .eq("user_id", AVATAR_USER)
    .gte("created_at", new Date(Date.now() - 30 * 60 * 1000).toISOString())
    .contains("context", { e2e_marker: marker });

  if (delErr) throw delErr;

  console.log("PASS: topic_keys identical for user+assistant; cleaned up", { marker, conversation_id });
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
