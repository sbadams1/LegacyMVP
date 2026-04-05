// tools/e2e_explicit_synthesis_test.js
// PowerShell:
//   $env:LEGACY_API_URL="https://<PROJECT_REF>.supabase.co/functions/v1/ai-brain"
//   node tools/e2e_explicit_synthesis_test.js

const API_URL = process.env.LEGACY_API_URL;
const API_KEY = process.env.LEGACY_API_KEY || "";
const TRIALS = Number(process.env.TRIALS || 10);

if (!API_URL) {
  console.error("Missing env var LEGACY_API_URL");
  process.exit(1);
}

async function callTurn({ user_id, conversation_id, message_text, state_json = "{}" }) {
  const payload = { mode: "legacy", user_id, conversation_id: conversation_id || null, message_text, state_json };

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

  return { conversation_id: json.conversation_id || conversation_id || null, reply_text: json.reply_text ?? null, raw: json };
}

function lc(s) { return (s || "").toLowerCase(); }
function countHits(text, needles) {
  const t = lc(text);
  return needles.reduce((acc, n) => acc + (t.includes(lc(n)) ? 1 : 0), 0);
}
function must(cond, msg) { if (!cond) throw new Error(msg); }

function makeUserId() {
  return `e2e_synth_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

(async () => {
  let pass = 0;
  let fail = 0;

  // Single-turn prompt: explicit, emotionally loaded, multiple anchors
  const userMsg =
    `I'm starting another month on this app and it feels like my life's work. ` +
    `I lost both my parents in the past few years, and I miss debating my mom about Judge Judy. ` +
    `My goal is that my daughters can still hear me after I'm gone, like hearing a voicemail. ` +
    `But if this app flops after I put everything into it, that would be brutal.`;

  const anchorTokens = ["life's work", "parents", "mom", "judge judy", "daughters", "voicemail", "flop", "brutal"];
  const empathyTokens = ["makes sense", "i can see why", "that sounds", "it sounds like", "understandable", "i hear", "tough", "hard", "painful"];
  const bannedGeneric = [
    "tell me more",
    "want to explore",
    "what specifically",
    "why is this important",
    "what kind of impact do you hope",
  ];

  for (let trial = 1; trial <= TRIALS; trial++) {
    const user_id = makeUserId();
    let conversation_id = null;

    try {
      const r = await callTurn({ user_id, conversation_id, message_text: userMsg });
      const reply = String(r.reply_text || "");
      must(reply.trim().length > 0, "Empty reply_text");

      // Must anchor to at least 3 concrete details from the user's message
      const anchorHits = countHits(reply, anchorTokens);
      must(anchorHits >= 3, `Anchoring too weak (hits=${anchorHits}/>=3). Reply: ${reply}`);

      // Must include at least 1 empathy/acknowledgement token
      const empathyHits = countHits(reply, empathyTokens);
      must(empathyHits >= 1, `No empathy/acknowledgement token found. Reply: ${reply}`);

      // Must include a synthesis connector (“because”, “so”, “which is why”, “that’s why”, “given that”)
      const synthHits = countHits(reply, ["because", "so", "that's why", "which is why", "given that"]);
      must(synthHits >= 1, `No explicit synthesis connector found. Reply: ${reply}`);

      // Must not be generic filler
      const lower = lc(reply);
      for (const b of bannedGeneric) must(!lower.includes(lc(b)), `Contains banned generic phrase: "${b}". Reply: ${reply}`);

      pass++;
      console.log(`✅ Trial ${trial}/${TRIALS} PASS`);
    } catch (e) {
      fail++;
      console.log(`❌ Trial ${trial}/${TRIALS} FAIL: ${e?.message || e}`);
    }
  }

  console.log(`\nRESULTS: ${pass}/${TRIALS} passed, ${fail}/${TRIALS} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error("\n❌ FAIL:", e?.message || e);
  process.exit(1);
});
