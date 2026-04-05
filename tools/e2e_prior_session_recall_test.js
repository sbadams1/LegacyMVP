// tools/e2e_prior_session_recall_test.js
// PowerShell:
//   $env:LEGACY_API_URL="https://<PROJECT_REF>.supabase.co/functions/v1/ai-brain"
//   node tools/e2e_prior_session_recall_test.js
//
// Optional (if required):
//   $env:LEGACY_API_KEY="<token>"

const API_URL = process.env.LEGACY_API_URL;
const API_KEY = process.env.LEGACY_API_KEY || "";
const TRIALS = Number(process.env.TRIALS || 5); // run multiple to reduce flakiness

if (!API_URL) {
  console.error("Missing env var LEGACY_API_URL");
  process.exit(1);
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function callTurn({ user_id, conversation_id, message_text, end_session = false, state_json = "{}" }) {
  const payload = {
    mode: "legacy",
    user_id,
    conversation_id: conversation_id || null,
    message_text,
    end_session,
    state_json,
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log("RAW ERROR:", JSON.stringify(json, null, 2));
    throw new Error(`HTTP ${res.status}`);
  }

  return {
    conversation_id: json.conversation_id || conversation_id || null,
    reply_text: json.reply_text ?? null,
    raw: json,
  };
}

function lc(s) { return (s || "").toLowerCase(); }
function mustContainAny(text, needles, label) {
  const t = lc(text);
  const ok = needles.some(n => t.includes(lc(n)));
  if (!ok) throw new Error(`${label}: expected at least one of: ${needles.join(", ")}`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeUserId() {
  // Unique per run so you don’t rely on existing DB state
  return `e2e_recall_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

(async () => {
  let pass = 0;
  let fail = 0;

  for (let trial = 1; trial <= TRIALS; trial++) {
    const user_id = makeUserId();
    let conversation_id = null;

    // Use unique facts so you know recall isn't coming from generic priors
    const fullName = `E2E Recall User ${Math.floor(Math.random() * 1e9)}`;
    const birthYear = 1977 + (Math.floor(Math.random() * 20));

    try {
      // Session 1: plant facts explicitly
      const s1 = [
        `For my profile: my full name is "${fullName}".`,
        `Also, I was born in ${birthYear}.`,
        `If I ask later, tell me my full name and what year I was born.`,
        ];

      for (const msg of s1) {
        const r = await callTurn({ user_id, conversation_id, message_text: msg });
        conversation_id = r.conversation_id;
        if (!r.reply_text || !String(r.reply_text).trim()) throw new Error("Session 1: empty reply_text");
      }

      // End session to force summary/facts persistence paths
      await callTurn({ user_id, conversation_id, message_text: "__END_SESSION__", end_session: true });

      // Small pause (some pipelines write asynchronously even if request returns)
      await sleep(800);

      // Session 2: new conversation_id, ask for recall
      conversation_id = null;

        const q1 = await callTurn({ user_id, conversation_id, message_text: "What's my full name?" });
        const a1 = String(q1.reply_text || "");
        mustContainAny(a1, [fullName], "Recall check: full name");

        const q2 = await callTurn({ user_id, conversation_id: q1.conversation_id, message_text: "What year was I born?" });
        const a2 = String(q2.reply_text || "");
        mustContainAny(a2, [String(birthYear)], "Recall check: birth year");

      pass++;
      console.log(`✅ Trial ${trial}/${TRIALS} PASS (user_id=${user_id})`);
    } catch (e) {
      fail++;
      console.log(`❌ Trial ${trial}/${TRIALS} FAIL: ${e?.message || e}`);
      pass; // noop
    }
  }

  console.log(`\nRESULTS: ${pass}/${TRIALS} passed, ${fail}/${TRIALS} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error("\n❌ FAIL:", e?.message || e);
  process.exit(1);
});
