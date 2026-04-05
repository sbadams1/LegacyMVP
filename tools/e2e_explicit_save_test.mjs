#!/usr/bin/env node
/**
 * E2E: Explicit save should persist a receipt-backed row in user_facts_receipts (no LLM, no end_session).
 *
 * Flow:
 *  1) Send a fact statement
 *  2) Send "Please record that."
 *  3) Assert a user_facts_receipts row exists with fact_key = explicit_save.<sha256_12> for the STATEMENT
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SB_SECRET_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SB_SECRET_KEY;
if (!SB_SECRET_KEY) throw new Error("Missing env var: SUPABASE_SERVICE_ROLE_KEY or SB_SECRET_KEY");
const TEST_USER_ID = mustEnv("TEST_USER_ID");

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

async function sha256Hex(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

async function invokeAiBrain(body) {
  const { data, error } = await client.functions.invoke("ai-brain", { body });
  if (error) throw new Error(error.message || String(error));
  return data;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async function main() {
  const convo = crypto.randomUUID();
  const statement = "My favorite color is blue.";
  console.log("E2E explicit save", { convo });

  await invokeAiBrain({
    user_id: TEST_USER_ID,
    conversation_id: convo,
    message_text: statement,
    mode: "legacy",
  });

  await sleep(250);

  await invokeAiBrain({
    user_id: TEST_USER_ID,
    conversation_id: convo,
    message_text: "Please record that.",
    mode: "legacy",
  });

  await sleep(500);

  const h = await sha256Hex(statement.toLowerCase().trim());
  const fact_key = `explicit_save.${h.slice(0, 12)}`;

  const { data: rows, error } = await client
    .from("user_facts_receipts")
    .select("id, user_id, fact_key, value_json, receipt_ids, receipt_quotes, updated_at")
    .eq("user_id", TEST_USER_ID)
    .eq("fact_key", fact_key)
    .limit(1);

  if (error) throw error;
  const row = Array.isArray(rows) ? rows[0] : null;
  assert.ok(row, "Expected a user_facts_receipts row for explicit save");

  const text = (row?.value_json?.text || "").toString().toLowerCase();
  assert.ok(text.includes("favorite color") && text.includes("blue"), "value_json.text did not contain the saved statement");

  const quotes = Array.isArray(row?.receipt_quotes) ? row.receipt_quotes.join(" ").toLowerCase() : "";
  assert.ok(quotes.includes("favorite color") && quotes.includes("blue"), "receipt_quotes did not contain the saved statement");

  const receiptIds = Array.isArray(row?.receipt_ids) ? row.receipt_ids : [];
  assert.ok(receiptIds.length >= 1, "receipt_ids should contain at least one receipt id");

  console.log("✅ PASS: explicit save persisted receipt-backed user_facts_receipts row");
})().catch((e) => {
  console.error("❌ FAIL:", e);
  process.exit(1);
});