// tools/e2e_resonance_tests.js
// PowerShell:
//   $env:LEGACY_API_URL="https://<PROJECT_REF>.supabase.co/functions/v1/ai-brain"
//   node tools/e2e_resonance_tests.js

const API_URL = process.env.LEGACY_API_URL;
const API_KEY = process.env.LEGACY_API_KEY || "";

if (!API_URL) {
  console.error("Missing env var LEGACY_API_URL");
  process.exit(1);
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function callTurn({ conversation_id, user_text, state_json = "{}" }) {
  const payload = {
  mode: "legacy",
  user_id: "e2e_resonance_user",
  conversation_id: conversation_id || null,

  // ✅ This is the key your server actually reads
  message_text: user_text,

  // optional (keep, since your server echoes it)
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

  // Always print raw if reply_text is missing — critical for debugging
  const reply = json.reply_text;
  if (!reply) {
    console.log("\nRAW RESPONSE:", JSON.stringify(json, null, 2));
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 2000)}`);
  }

  const convo = json.conversation_id || conversation_id || null;
  return { json, reply_text: reply, conversation_id: convo };
}

function lc(s) { return (s || "").toLowerCase(); }

function mustContainAny(text, needles, label) {
  const t = lc(text);
  assert(needles.some(n => t.includes(lc(n))), `${label}: expected at least one of: ${needles.join(", ")}`);
}

function mustNotContain(text, needles, label) {
  const t = lc(text);
  for (const n of needles) assert(!t.includes(lc(n)), `${label}: must NOT contain "${n}"`);
}

(async () => {
  const turns = [
    "It hit me today that people who never attempt hard things never worry about failure.",
    "I'm starting another month on this app and I'm not even sure why I'm so driven, it feels like my life's work.",
    "I lost both parents in the past few years, I miss debating my mom about Judge Judy being real.",
    "My goal is that my daughters can still hear me after I'm gone like hearing a voicemail.",
    "But if this app flops after I put everything into it, that would be brutal."
  ];

  let conversation_id = null;
  let lastReply = "";
  const replies = [];

  for (const user_text of turns) {
    const { reply_text, conversation_id: cid } = await callTurn({ conversation_id, user_text });
    conversation_id = cid;

    console.log("\nUSER:", user_text);
    console.log("ASSISTANT:", reply_text);
    console.log("conversation_id:", conversation_id);

    if (!reply_text) {
      throw new Error("reply_text is null/empty — input keys likely still don't match server expectations.");
    }

    lastReply = reply_text;
    replies.push(reply_text);
  }

  // Evaluate each reply for anchoring + no therapy-coded origin re-asks
const perTurnAnchors = [
  ["hard things", "failure", "worry", "challenge", "challeng", "avoid", "growth", "overcom"],           // turn 1
  ["app", "life's work", "driven", "month"],                  // turn 2
  ["parents", "mom", "judge judy", "debate"],                 // turn 3
  ["daughters", "voicemail", "hear", "after i'm gone"],       // turn 4
  ["flop", "brutal", "effort", "worth", "succeed"],           // turn 5
];

for (let i = 0; i < replies.length; i++) {
  mustContainAny(replies[i], perTurnAnchors[i], `Turn ${i + 1} anchor check`);

  mustNotContain(replies[i], [
    "want to explore",
    "something you want to explore",
    "explore why",
    "tell me more about why",
    "what makes this important",
    "why is this important",
  ], `Turn ${i + 1} no-therapy/origin re-ask check`);
}

// Optional: strict “connect-the-dots” check on the final reply
mustContainAny(
  replies[4],
  ["daughters", "voicemail", "parents", "judge judy"],
  "Final reply cross-turn dot-connection check"
);

  console.log("\n✅ PASS: E2E resonance checks");
})().catch((e) => {
  console.error("\n❌ FAIL:", e.message);
  process.exit(1);
});
