/* scripts/e2e_memory_test.mjs
 *
 * E2E test: facts extraction + fact recall + story recall.
 *
 * Writes a short diagnostic conversation, ends session to trigger pipelines,
 * then verifies:
 *  - user_facts got a new fact containing a known token
 *  - story_recall got indexed from story_seeds
 *  - asking "tell me the story about murder crabs" produces a retell (not a prompt to narrate)
 *
 * Requires:
 *  SUPABASE_URL
 *  SUPABASE_ANON_KEY
 *  SUPABASE_SERVICE_ROLE_KEY
 */

import crypto from "node:crypto";
import process from "node:process";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AI_BRAIN_FUNCTION_NAME = process.env.AI_BRAIN_FUNCTION_NAME || "ai-brain";

const USER_ID = "7037efeb-a6b1-49b4-b782-1843ce300425";

function mustEnv(name, val) {
  if (!val) throw new Error(`Missing env var: ${name}`);
}

mustEnv("SUPABASE_URL", SUPABASE_URL);
mustEnv("SUPABASE_ANON_KEY", SUPABASE_ANON_KEY);
mustEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const functionUrl = `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/${AI_BRAIN_FUNCTION_NAME}`;

async function callAiBrain(payload) {
  const res = await fetch(functionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // If your Edge Function requires a JWT, replace ANON with a real user JWT.
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (status ${res.status}): ${text.slice(0, 500)}`);
  }

  if (!res.ok) {
    throw new Error(`ai-brain non-OK ${res.status}: ${JSON.stringify(json).slice(0, 800)}`);
  }
  return json;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function containsLoose(hay, needle) {
  return String(hay || "").toLowerCase().includes(String(needle || "").toLowerCase());
}

async function main() {
  const conversation_id = crypto.randomUUID();
  const marker = `diag_${crypto.randomUUID().slice(0, 8)}`;

  // We use unique tokens so we can verify extraction without guessing exact fact_key schema.
  const FATHER_NAME = `Harold Wendell Adams ${marker}`;
  const STORY_TITLE_TOKEN = `murder crabs ${marker}`;

  console.log("E2E starting:", { conversation_id, marker });

  // --- 1) Create content that should generate both facts and a story seed.
  // Fact seed:
  await callAiBrain({
    user_id: USER_ID,
    conversation_id,
    message_text: `[diagnostic] My father's name is ${FATHER_NAME}. Please remember that.`,
  });

  // Story seed: include the exact story label + keywords; keep it short but distinctive.
  await callAiBrain({
    user_id: USER_ID,
    conversation_id,
    message_text:
      `[diagnostic] Here is my "${STORY_TITLE_TOKEN}" story. I wanted to free the crabs into the ocean, ` +
      `but my girlfriend told me they were freshwater crabs so they were still doomed. ` +
      `The nickname I used was "Murder Crabs".`,
  });

  // --- 2) End session to trigger story_seeds + story_recall indexing + fact extraction persistence.
  await callAiBrain({
    user_id: USER_ID,
    conversation_id,
    message_text: `[diagnostic] End session now.`,
    end_session: true,
  });

  // Give async pipelines a moment (DB writes are synchronous, but downstream tasks may lag).
  await sleep(1500);

  // --- 3) Validate FACTS EXTRACTION (DB): look for our marker token in user_facts.
  // We validate extraction by checking canonical fact_key + canonical value.
  {
    const { data, error } = await db
      .from("user_facts")
      .select("id, fact_key, value_json, receipt_quotes, updated_at")
      .eq("user_id", USER_ID)
      .order("updated_at", { ascending: false })
      .limit(400);

    if (error) throw error;
    const rows = data || [];
    const hit = rows.find((r) => r.fact_key === "relationships.father.name");
    assert.ok(hit, `FAIL facts extraction: missing fact_key relationships.father.name (searched last ${rows.length})`);

    const val = JSON.stringify(hit.value_json || "");
    assert.ok(
      containsLoose(val, "harold") && containsLoose(val, "wendell") && containsLoose(val, "adams"),
      `FAIL facts extraction: relationships.father.name value_json did not contain expected canonical name. value_json=${val}`,
    );

    console.log("PASS facts extraction: found canonical user_facts row:", { fact_key: hit.fact_key, id: hit.id });
   }

  // --- 4) Validate STORY RECALL INDEX (DB): story_seeds exists and story_recall got populated.
  {
    const { data: seeds, error: seedErr } = await db
      .from("story_seeds")
      .select("id, title, seed_text, created_at")
      .eq("user_id", USER_ID)
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (seedErr) throw seedErr;

    assert.ok((seeds || []).length > 0, "FAIL story_seeds: expected at least 1 seed for this conversation");

    const { data: recall, error: recallErr } = await db
      .from("story_recall")
      .select("id, title, synopsis, keywords, story_seed_id, updated_at")
      .eq("user_id", USER_ID)
      .order("updated_at", { ascending: false })
      .limit(200);
    if (recallErr) throw recallErr;

    const recallRows = recall || [];
    const recallHit = recallRows.find((r) => {
      const t = `${r.title || ""} ${r.synopsis || ""} ${(Array.isArray(r.keywords) ? r.keywords.join(" ") : "")}`;
      return containsLoose(t, marker) || containsLoose(t, "murder crabs");
    });

    assert.ok(
      recallHit,
      `FAIL story_recall: expected an indexed story row containing "${marker}" or "murder crabs" (story_recall rows=${recallRows.length})`,
    );

    console.log("PASS story_recall index: found story_recall row:", { id: recallHit.id, title: recallHit.title });
  }

  // --- 5) Validate FACT RECALL (runtime): ask question and assert reply includes token.
  {
     const out = await callAiBrain({
       user_id: USER_ID,
       conversation_id,
       message_text: `[diagnostic] What is my father's name?`,
     });
     const reply = out?.reply_text || "";
     assert.ok(
      containsLoose(reply, "harold") && containsLoose(reply, "wendell") && containsLoose(reply, "adams"),
      `FAIL fact recall: reply did not contain expected canonical name. reply="${reply}"`,
     );
     console.log("PASS fact recall:", reply);
   }

  // --- 6) Validate STORY RECALL (runtime): retell request must produce narrative, not “what comes to mind first”.
  {
    const out = await callAiBrain({
      user_id: USER_ID,
      conversation_id,
      message_text: `[diagnostic] Tell me the story about murder crabs.`,
    });
    const reply = out?.reply_text || "";

    // Fail if it stalls or asks user to start narrating.
    const bad =
      containsLoose(reply, "what comes to mind first") ||
      containsLoose(reply, "ready when you are") ||
      containsLoose(reply, "tell me more") ||
      containsLoose(reply, "would you like to share") ||
      containsLoose(reply, "i can tell you the story") ||
      containsLoose(reply, "is that alright") ||
      containsLoose(reply, "would you like me to proceed");

    assert.ok(!bad, `FAIL story recall: assistant stalled instead of retelling. reply="${reply}"`);
    assert.ok(
      containsLoose(reply, "crab") && (containsLoose(reply, "freshwater") || containsLoose(reply, "ocean") || containsLoose(reply, "girlfriend")),
      `FAIL story recall: reply did not look like a retell of the crab story. reply="${reply}"`,
    );

    console.log("PASS story recall retell:", reply);
  }

  console.log("✅ E2E test PASSED:", { conversation_id, marker });

  // Optional cleanup (commented out by default):
  // If you want cleanup, uncomment and ensure your schema supports deletes by conversation_id.
  /*
  await db.from("story_seeds").delete().eq("user_id", USER_ID).eq("conversation_id", conversation_id);
  // story_recall is upserted by story_seed_id; you can delete rows that have our marker in title/synopsis:
  const { data: recall } = await db.from("story_recall").select("id, synopsis, title").eq("user_id", USER_ID).limit(500);
  for (const r of (recall || [])) {
    const t = `${r.title || ""} ${r.synopsis || ""}`;
    if (containsLoose(t, marker)) await db.from("story_recall").delete().eq("id", r.id);
  }
  */
}

main().catch((e) => {
  console.error("❌ E2E test FAILED:", e);
  process.exit(1);
});
