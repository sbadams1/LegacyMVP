// tools/e2e_stake_bridge_test.js
// PowerShell usage:
//   $env:LEGACY_API_URL="https://<PROJECT_REF>.supabase.co/functions/v1/ai-brain"
//   node tools/e2e_stake_bridge_test.js
//
// Optional (if your edge function requires auth):
//   $env:LEGACY_API_KEY="<Bearer token or anon key>"

const API_URL = process.env.LEGACY_API_URL;
const API_KEY = process.env.LEGACY_API_KEY || "";

const TRIALS = Number(process.env.TRIALS || 10);
const STOP_ON_FIRST_FAIL = (process.env.STOP_ON_FIRST_FAIL || "0") === "1";

if (!API_URL) {
  console.error("Missing env var LEGACY_API_URL");
  process.exit(1);
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function callTurn({ conversation_id, message_text, state_json = "{}" }) {
  // This matches your turn_core.ts request parsing:
  // message_text is read from body.message_text (or text/message/user_message/input).
  const payload = {
    mode: "legacy",
    user_id: "e2e_bridge_user",
    conversation_id: conversation_id || null,
    message_text,
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

function mustNotContain(text, needles, label) {
  const t = lc(text);
  for (const n of needles) {
    if (t.includes(lc(n))) throw new Error(`${label}: must NOT contain "${n}"`);
  }
}

(async () => {
  const turns = [
    "It hit me today that people who never attempt hard things never worry about failure.",
    "I'm starting another month on this app and I'm not even sure why I'm so driven, it feels like my life's work.",
    "I lost both parents in the past few years, I miss debating my mom about Judge Judy being real.",
    "My goal is that my daughters can still hear me after I'm gone like hearing a voicemail.",
    "But if this app flops after I put everything into it, that would be brutal.",
  ];

  let pass = 0;
  let fail = 0;
  const failures = [];

  for (let trial = 1; trial <= TRIALS; trial++) {
    let conversation_id = null;
    const replies = [];

    try {
      for (let i = 0; i < turns.length; i++) {
        const { conversation_id: cid, reply_text, raw } = await callTurn({
          conversation_id,
          message_text: turns[i],
        });

        conversation_id = cid;

        if (!reply_text || !String(reply_text).trim()) {
          console.log("RAW RESPONSE:", JSON.stringify(raw, null, 2));
          throw new Error(`Trial ${trial} Turn ${i + 1}: reply_text is empty/null`);
        }

        replies.push(String(reply_text));
      }

      const finalReply = replies[replies.length - 1];

      // 1) Must respond to the last-turn topic (allow synonyms like "didn't succeed")
      mustContainAny(
        finalReply,
        [
          "flop",
          "fail",
          "brutal",
          "failure",
          "didn't succeed",
          "did not succeed",
          "not succeed",
          "doesn't succeed",
          "does not succeed",
          "mainstream hit",
          "not a hit",
        ],
        `Trial ${trial}: Final reply flop/failure anchor`
      );

      // 2) MUST stake-bridge to earlier stated purpose/stakes (literal token)
      mustContainAny(
        finalReply,
        ["daughters", "voicemail", "parents", "judge judy", "mom"],
        `Trial ${trial}: Final reply stake-bridge anchor`
      );

      // 3) Must avoid the prior generic failure mode
      mustNotContain(
        finalReply,
        ["what specifically feels brutal", "what specifically", "tell me more about why", "want to explore"],
        `Trial ${trial}: Final reply anti-generic check`
      );

      pass++;
      process.stdout.write(`✅ Trial ${trial}/${TRIALS} PASS\n`);
    } catch (e) {
      fail++;
      const msg = (e && e.message) ? e.message : String(e);
      const finalReply = replies.length ? replies[replies.length - 1] : "(no final reply)";
      failures.push({ trial, msg, finalReply });
      process.stdout.write(`❌ Trial ${trial}/${TRIALS} FAIL: ${msg}\n`);
      if (STOP_ON_FIRST_FAIL) break;
    }
  }

  console.log(`\nRESULTS: ${pass}/${TRIALS} passed, ${fail}/${TRIALS} failed`);
  if (failures.length) {
    const f = failures[0];
    console.log("\nFirst failure details:");
    console.log("Trial:", f.trial);
    console.log("Reason:", f.msg);
    console.log("Final reply:", f.finalReply);
    process.exit(1);
  } else {
    console.log("\n✅ PASS: Stake-bridge behavior held across all trials.");
  }
 })().catch((e) => {
   console.error("\n❌ FAIL:", e.message);
   process.exit(1);
 }); 