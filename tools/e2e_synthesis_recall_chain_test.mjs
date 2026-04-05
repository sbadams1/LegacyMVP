// tools/e2e_synthesis_recall_chain_test.mjs
// E2E: persistence + prior-session recall + multi-hop synthesis in one run.
//
// Expected: PASS if the assistant can recall stored facts across a new conversation
// and can synthesize a derived answer (retire_year - start_work_year).

import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const EDGE_FN = process.env.EDGE_FN ?? "ai-brain";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.ANON_KEY;

// If you already have a working auth method in your other E2E script, mirror it here.
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL env var.");
if (!SERVICE_ROLE_KEY && !ANON_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY (or ANON_KEY).");

const baseUrl = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/${EDGE_FN}`;

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const uuid = () => crypto.randomUUID();

async function callAiBrain(payload, { bearer } = {}) {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Prefer service role if you use it for E2E. Otherwise use anon + JWT like your other test.
      authorization: `Bearer ${bearer || SERVICE_ROLE_KEY || ANON_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }

  if (!res.ok) {
    console.error("RAW ERROR:", json ?? text);
    throw new Error(`HTTP ${res.status}`);
  }
  return json ?? { raw: text };
}

function expectContains(haystack, needle, label) {
  if (!String(haystack).includes(String(needle))) {
    throw new Error(`${label}: expected to contain "${needle}"`);
  }
}

async function run() {
  const user_id = process.env.TEST_USER_ID;
  if (!user_id) {
    throw new Error("Missing TEST_USER_ID. Set TEST_USER_ID to an existing users.id row (same as your other passing E2E).");
  }
  const conv1 = uuid();
  const conv2 = uuid();

  const fullName = `E2E Synthesis User ${randInt(100000000, 999999999)}`;
  const birthYear = randInt(1985, 2005);
  const startWorkYear = randInt(birthYear + 18, birthYear + 30);
  const retireYear = randInt(startWorkYear + 5, startWorkYear + 25);
  const expectedYearsWorked = retireYear - startWorkYear;

  // -------------------------
  // Session 1: write facts
  // -------------------------
  await callAiBrain({
    user_id,
    conversation_id: conv1,
    message_text: `My full name is "${fullName}".`,
  });

  await callAiBrain({
    user_id,
    conversation_id: conv1,
    message_text: `I was born in ${birthYear}.`,
  });

  // These two are deliberately phrased simply so your system can extract/store reliably.
  await callAiBrain({
    user_id,
    conversation_id: conv1,
    message_text: `I started working in ${startWorkYear}.`,
  });

  await callAiBrain({
    user_id,
    conversation_id: conv1,
    message_text: `I retired in ${retireYear}.`,
  });

  // End session (important: whatever your system uses to trigger end_session)
  await callAiBrain({
    user_id,
    conversation_id: conv1,
    end_session: true,
    message_text: "__END_SESSION__",
  });

  // -------------------------
  // Session 2: recall + synthesis
  // -------------------------
  const r1 = await callAiBrain({
    user_id,
    conversation_id: conv2,
    message_text: "What's my full name and birth year?",
  });

  // Your function may return { reply_text }, { text }, or something else.
  const reply1 =
    r1?.reply_text ??
    r1?.text ??
    r1?.reply ??
    r1?.message ??
    JSON.stringify(r1);

  expectContains(reply1, fullName, "Trial: recall full name");
  expectContains(reply1, String(birthYear), "Trial: recall birth year");

  const r2 = await callAiBrain({
    user_id,
    conversation_id: conv2,
    message_text: "How many years did I work before retiring? Answer with just the number.",
  });

  const reply2 =
    r2?.reply_text ??
    r2?.text ??
    r2?.reply ??
    r2?.message ??
    JSON.stringify(r2);

  // Synthesis assertion: the derived number should appear.
  // (We accept either exact match or substring, since some models add punctuation.)
  expectContains(reply2, String(expectedYearsWorked), "Trial: synthesis years-worked");

  console.log("✅ Trial PASS");
  console.log("User:", user_id);
  console.log({ fullName, birthYear, startWorkYear, retireYear, expectedYearsWorked });
}

run().catch((e) => {
  console.error("❌ Trial FAIL:", e?.message ?? e);
  process.exit(1);
});
