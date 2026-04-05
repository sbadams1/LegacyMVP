// tools/e2e_vip_lane_conflict_test.mjs
import assert from "node:assert/strict";
import process from "node:process";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

function mustGetEnv(name) {
  const v = String(process.env[name] ?? "").trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jsonEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

async function callAiBrain({ supabaseUrl, serviceKey, body }) {
  const fnUrl = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/ai-brain`;
  const resp = await fetch(fnUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  assert.equal(resp.ok, true, `ai-brain HTTP ${resp.status}:\n${text}`);
}

async function main() {
  const SUPABASE_URL = mustGetEnv("SUPABASE_URL");
  const SERVICE_KEY =
    String(process.env.SB_SECRET_KEY ?? "").trim() ||
    String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!SERVICE_KEY) throw new Error("Missing SB_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY");

  const USER_ID = String(process.env.E2E_USER_ID ?? "2dc11e13-f77b-44f0-97ea-b9faa8e948af").trim();
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const conversation_id = crypto.randomUUID();
  const marker = `vip_conf_${crypto.randomUUID().slice(0, 8)}`;

  // Turn 1: set height to 6'4" (76)
  await callAiBrain({
    supabaseUrl: SUPABASE_URL,
    serviceKey: SERVICE_KEY,
    body: {
      user_id: USER_ID,
      conversation_id,
      message_text: `(${marker}) I'm 6'4" tall.`,
      entry_mode: "freeform",
      mode: "legacy",
      end_session: false,
    },
  });

  await sleep(700);

  // Ensure user_facts has 76 now
  {
    const { data, error } = await supabase
      .from("user_facts")
      .select("id, value_json, receipt_ids, is_locked")
      .eq("user_id", USER_ID)
      .eq("fact_key", "identity.height_inches")
      .maybeSingle();

    assert.equal(error, null, `user_facts select error: ${error?.message ?? error}`);
    assert.ok(data?.id, "Expected user_facts row for identity.height_inches after turn 1");
    assert.ok(jsonEq(data.value_json, 76), `Expected height 76 after turn 1, got ${JSON.stringify(data.value_json)}`);
  }

  // Turn 2: conflict height 6'2" (74)
  await callAiBrain({
    supabaseUrl: SUPABASE_URL,
    serviceKey: SERVICE_KEY,
    body: {
      user_id: USER_ID,
      conversation_id,
      message_text: `(${marker}) Actually I'm 6'2" tall.`,
      entry_mode: "freeform",
      mode: "legacy",
      end_session: false,
    },
  });

  await sleep(900);

  // Assert user_facts did NOT change (still 76)
  const { data: uf, error: ufErr } = await supabase
    .from("user_facts")
    .select("id, value_json, receipt_ids, receipt_quotes, is_locked, updated_at")
    .eq("user_id", USER_ID)
    .eq("fact_key", "identity.height_inches")
    .maybeSingle();

  assert.equal(ufErr, null, `user_facts select error: ${ufErr?.message ?? ufErr}`);
  assert.ok(uf?.id, "Missing user_facts row for identity.height_inches");
  assert.ok(jsonEq(uf.value_json, 76), `Conflict rule violated: expected 76 to remain, got ${JSON.stringify(uf.value_json)}`);

  // Assert fact_candidates contains BOTH values (76 and 74) for this conversation/key
  const { data: cands, error: cErr } = await supabase
    .from("fact_candidates")
    .select("id, fact_key_guess, value_json, turn_ref, source_meta, extracted_at")
    .eq("user_id", USER_ID)
    .eq("conversation_id", conversation_id)
    .eq("fact_key_guess", "identity.height_inches")
    .order("extracted_at", { ascending: false });

  assert.equal(cErr, null, `fact_candidates select error: ${cErr?.message ?? cErr}`);
  assert.ok(Array.isArray(cands) && cands.length >= 2, `Expected >=2 height candidates, got ${cands?.length ?? 0}`);

  const values = cands.map((r) => r.value_json);
  const has76 = values.some((v) => jsonEq(v, 76));
  const has74 = values.some((v) => jsonEq(v, 74));
  assert.ok(has76 && has74, `Expected candidates for 76 and 74; got: ${values.map((v) => JSON.stringify(v)).join(", ")}`);

  // Best-effort: newest candidate should carry conflict info in source_meta
  // (If your code only annotates sometimes, we won’t fail the test hard—just warn.)
  const newest = cands[0];
  let meta = newest?.source_meta;
  try {
    if (typeof meta === "string") meta = JSON.parse(meta);
  } catch {}
  const conflictHint = meta && typeof meta === "object" && ("conflict_with_user_fact_id" in meta);
  if (!conflictHint) {
    console.warn("⚠️ Conflict meta not found on newest candidate (non-fatal). Consider enforcing this later.");
  }

  console.log("✅ VIP lane conflict test PASS");
  console.log("conversation_id:", conversation_id);
  console.log("marker:", marker);
}

main().catch((err) => {
  console.error("❌ VIP lane conflict test FAILED");
  console.error(err?.stack ?? err);
  process.exit(1);
});
