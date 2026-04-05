// tools/e2e_vip_lane_fact_candidates_test.mjs
import assert from "node:assert/strict";
import process from "node:process";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

/**
 * E2E test for VIP lane + fact_candidates + user_facts promotion.
 *
 * No-JWT approach:
 * - We do NOT authenticate as a user.
 * - We pass user_id in the JSON body (ai-brain supports this).
 * - We call the Edge Function with service secret in headers (apikey/Authorization),
 *   matching your existing test patterns.
 */

function mustGetEnv(name) {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Robust-ish JSON equality for primitives/flat objects
function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  const SUPABASE_URL = mustGetEnv("SUPABASE_URL");
  // Your Edge Function reads SB_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY.
  // For this test, we use whichever you have set locally.
  const SERVICE_KEY =
    String(process.env.SB_SECRET_KEY ?? "").trim() ||
    String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

  if (!SERVICE_KEY) throw new Error("Missing SB_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY");

  // Use your real user id (or an E2E user id).
  // If you don’t set E2E_USER_ID, it will default to the one you showed in SQL output.
  const USER_ID = String(process.env.E2E_USER_ID ?? "2dc11e13-f77b-44f0-97ea-b9faa8e948af").trim();

  // Create an admin client for DB verification (service role)
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const conversation_id = crypto.randomUUID();
  const marker = `vip_diag_${crypto.randomUUID().slice(0, 8)}`;

  const message_text =
    `(${marker}) My name is Steven Adams. ` +
    `I was born in 1967. ` +
    `I'm 6'4" tall and 195 lbs. ` +
    `I have 3 daughters.`;

  // 1) Call ai-brain
  const fnUrl = `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/ai-brain`;

  const resp = await fetch(fnUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({
      user_id: USER_ID,
      conversation_id,
      message_text,
      entry_mode: "freeform",
      // optional: helpful for tracing in logs if you already support it
      e2e_marker: marker,
      mode: "legacy",
      end_session: false,
    }),
  });

  const respText = await resp.text();
  assert.equal(resp.ok, true, `ai-brain HTTP ${resp.status}:\n${respText}`);

  // The function may write rows asynchronously in the same request path, but DB commit timing
  // can still be slightly behind; give a small buffer.
  await sleep(750);

  // 2) Find the newest memory_raw user row for this conversation (receipt)
  const { data: rawRow, error: rawErr } = await supabase
    .from("memory_raw")
    .select("id, content, role, created_at, conversation_id")
    .eq("user_id", USER_ID)
    .eq("conversation_id", conversation_id)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  assert.equal(rawErr, null, `memory_raw lookup error: ${rawErr?.message ?? rawErr}`);
  assert.ok(rawRow?.id, "No memory_raw user row found for this conversation");
  assert.ok(String(rawRow.content ?? "").includes(marker), "memory_raw content did not include marker");

  const receipt_id = String(rawRow.id);

  // 3) Verify fact_candidates rows (VIP keys)
  const { data: candRows, error: candErr } = await supabase
    .from("fact_candidates")
    .select("id, fact_key_guess, value_json, turn_ref, source_meta, status, extracted_at")
    .eq("user_id", USER_ID)
    .eq("conversation_id", conversation_id)
    .order("extracted_at", { ascending: false });

  assert.equal(candErr, null, `fact_candidates select error: ${candErr?.message ?? candErr}`);
  assert.ok(Array.isArray(candRows) && candRows.length > 0, "No fact_candidates rows found");

  // Expected VIP facts from the message.
  // Note: your VIP lane stores name only if the text matches its conservative patterns.
  // This test uses "My name is Steven Adams." which should match.
  const expectedCandidates = [
    { key: "identity.full_name", value: "Steven Adams" },
    { key: "identity.birth_year", value: 1967 },
    { key: "identity.height_inches", value: 76 },
    { key: "health.weight_lbs", value: 195 },
    { key: "relationships.daughters.count", value: 3 },
  ];

  const byKey = new Map(candRows.map((r) => [String(r.fact_key_guess), r]));
  for (const exp of expectedCandidates) {
    const row = byKey.get(exp.key);
    assert.ok(row, `Missing fact_candidates row for ${exp.key}`);

    // turn_ref should be the receipt id (raw_id) in VIP lane
    assert.equal(String(row.turn_ref ?? ""), receipt_id, `fact_candidates.turn_ref mismatch for ${exp.key}`);

    // value_json should match (number vs string matters)
    const actual = row.value_json;
    assert.ok(
      jsonEqual(actual, exp.value),
      `fact_candidates.value_json mismatch for ${exp.key}: expected ${JSON.stringify(exp.value)} got ${JSON.stringify(actual)}`
    );
  }

  // 4) Verify user_facts promoted rows + receipt_ids includes receipt_id
  const keys = expectedCandidates.map((x) => x.key);
  const { data: factRows, error: factErr } = await supabase
    .from("user_facts")
    .select("fact_key, value_json, receipt_ids, receipt_quotes, is_locked, stability, confidence, updated_at")
    .eq("user_id", USER_ID)
    .in("fact_key", keys);

  assert.equal(factErr, null, `user_facts select error: ${factErr?.message ?? factErr}`);
  assert.ok(Array.isArray(factRows), "user_facts query returned non-array");

  const factsByKey = new Map(factRows.map((r) => [String(r.fact_key), r]));
  for (const exp of expectedCandidates) {
    const row = factsByKey.get(exp.key);
    assert.ok(row, `Missing user_facts row for ${exp.key}`);

    assert.ok(
      jsonEqual(row.value_json, exp.value),
      `user_facts.value_json mismatch for ${exp.key}: expected ${JSON.stringify(exp.value)} got ${JSON.stringify(row.value_json)}`
    );

    const rids = Array.isArray(row.receipt_ids) ? row.receipt_ids.map(String) : [];
    assert.ok(rids.includes(receipt_id), `user_facts.receipt_ids missing receipt_id for ${exp.key}`);

    const quotes = Array.isArray(row.receipt_quotes) ? row.receipt_quotes.map(String) : [];
    assert.ok(quotes.length >= 1, `user_facts.receipt_quotes empty for ${exp.key}`);
  }

  console.log("✅ VIP lane + fact_candidates extraction test PASS");
  console.log("conversation_id:", conversation_id);
  console.log("receipt_id:", receipt_id);
  console.log("marker:", marker);
}

main().catch((err) => {
  console.error("❌ VIP lane + fact_candidates extraction test FAILED");
  console.error(err?.stack ?? err);
  process.exit(1);
});
