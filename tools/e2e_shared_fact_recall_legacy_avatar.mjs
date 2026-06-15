#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const USER_ID = "2dc11e13-f77b-44f0-97ea-b9faa8e948af";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return String(v).trim();
}

function norm(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function fail(msg, extra = null) {
  console.error("FAIL:", msg);
  if (extra) console.error("details:", extra);
  process.exit(1);
}

function summarizeMemorySummaryRow(row) {
  if (!row) return null;
  const pick = (k) =>
    row && Object.prototype.hasOwnProperty.call(row, k) ? row[k] : undefined;

  const out = {
    id: pick("id"),
    created_at: pick("created_at"),
    conversation_id: pick("conversation_id"),
    eligibility: pick("eligibility"),
    stages: pick("stages"),
    debug: pick("debug"),
    meta: pick("meta"),
    stats: pick("stats"),
    error: pick("error"),
  };

  const extras = {};
  for (const [k, v] of Object.entries(row)) {
    if (out[k] !== undefined) continue;
    if (v === null || v === undefined) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s && s.length <= 1200) extras[k] = v;
  }

  return { ...out, extras };
}

function factsContainExactValueDeep(obj, wantedValues) {
  const hay = norm(JSON.stringify(obj ?? {}));
  return wantedValues.every((v) => hay.includes(norm(v)));
}

function replyHasSeededFact(replyText, expectedAny) {
  const text = norm(replyText);
  return expectedAny.some((p) => text.includes(norm(p)));
}

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SUPABASE_ANON_KEY = mustEnv("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SB_SECRET_KEY");
const TEST_USER_EMAIL = mustEnv("TEST_USER_EMAIL");
const TEST_USER_PASSWORD = mustEnv("TEST_USER_PASSWORD");

const AI_BRAIN_URL = `${SUPABASE_URL}/functions/v1/ai-brain`;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function loginAndGetJWT() {
  const { data, error } = await client.auth.signInWithPassword({
    email: TEST_USER_EMAIL,
    password: TEST_USER_PASSWORD,
  });

  if (error) fail("Login failed", error.message);
  return data.session.access_token;
}

async function postAiBrain(jwt, payload) {
  const resp = await fetch(AI_BRAIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!resp.ok) {
    fail("ai-brain call failed", { status: resp.status, body: json ?? text });
  }

  return json ?? { ok: true, raw: text };
}

async function main() {
  console.log("Logging in test user...");
  const USER_JWT = await loginAndGetJWT();
  console.log("JWT acquired ✔");

  const seedConversationId = crypto.randomUUID();

  // Use a distinctive but clearly durable fact.
  const seededValue = "burnt orange";
  const seededNoun = "passport folder";
  const seededUsage = "travel documents";

  const factTurns = [
    "I want to save a practical fact for later recall. My passport folder is burnt orange, and that is the folder I always use for travel documents when I leave town.",
    "To be specific, the burnt orange passport folder is where I keep my passport, printed reservations, backup cards, and emergency contact sheet whenever I travel.",
    "The important detail to remember is simple: my travel document folder is burnt orange, not black, not gray, and not blue.",
    "This is a stable organization habit I want remembered. Burnt orange is the color of my passport folder and the folder I use for important travel paperwork.",
  ];

  console.log("Seeding shared fact memory through legacy mode...");
  for (const turn of factTurns) {
    await postAiBrain(USER_JWT, {
      user_id: USER_ID,
      conversation_id: seedConversationId,
      mode: "legacy",
      op: "e2e_no_proxy",
      message_text: turn,
      preferred_locale: "en",
    });
    await sleep(200);
  }

  console.log("Triggering end_session.");
  await postAiBrain(USER_JWT, {
    user_id: USER_ID,
    conversation_id: seedConversationId,
    mode: "legacy",
    op: "e2e_no_proxy",
    end_session: true,
    message_text: "__END_SESSION__",
    preferred_locale: "en",
  });

  let latestSummary = null;
  let factsSnapshot = null;

  // IMPORTANT: wait for Phase B DONE, not just early presence in user_knowledge.
  for (let i = 0; i < 60; i++) {
    const jobs = await admin
      .from("end_session_jobs")
      .select("id, status, attempt_count, last_error, created_at, started_at, finished_at")
      .eq("conversation_id", seedConversationId)
      .order("created_at", { ascending: false })
      .limit(3);

    const ms = await admin
      .from("memory_summary")
      .select("*")
      .eq("conversation_id", seedConversationId)
      .order("created_at", { ascending: false })
      .limit(1);

    const uk = await admin
      .from("user_knowledge")
      .select("facts")
      .eq("user_id", USER_ID)
      .maybeSingle();

    latestSummary = ms.data?.[0] ?? null;
    const latestJob = jobs.data?.[0] ?? null;
    factsSnapshot = uk.data?.facts ?? null;

    console.log(
      `poll ${i}: job_status=${latestJob?.status ?? "none"} memory_summary=${latestSummary ? 1 : 0} facts=${factsSnapshot ? 1 : 0}`,
    );

    if (latestSummary) {
      console.log("memory_summary.latest:", JSON.stringify(summarizeMemorySummaryRow(latestSummary), null, 2));
    }

    if (latestJob?.status === "failed") {
      fail("end_session job failed during fact seeding", latestJob);
    }

    const insights =
      latestSummary?.session_insights ??
      latestSummary?.extras?.session_insights ??
      null;

    const phaseBDoneQueued = latestJob?.status === "done";
    const phaseBDoneInline =
      String(insights?.phase ?? "").trim().toUpperCase() === "B" &&
      (
        String(insights?.extra?.job_id ?? "").startsWith("inline:") ||
        Number(insights?.counts?.facts_items ?? 0) > 0
      );

    const factsReady =
      Number(insights?.counts?.facts_items ?? 0) > 0;

    if ((phaseBDoneQueued || phaseBDoneInline) && factsReady) {
      break;
    }
    await sleep(1000);
  }

  if (!factsSnapshot || !factsContainExactValueDeep(factsSnapshot, [seededValue, seededNoun])) {
    fail("Seeded fact did not land in shared memory after Phase B", {
      seed_conversation_id: seedConversationId,
      latest_memory_summary_id: latestSummary?.id ?? null,
      latest_short_summary: latestSummary?.short_summary ?? null,
      expected_values: [seededValue, seededNoun],
    });
  }

  console.log("Shared fact seeded ✔", {
    seed_conversation_id: seedConversationId,
    expected_values: [seededValue, seededNoun],
    matched_in_user_knowledge: true,
  });

  // Ask BOTH modes in fresh conversations.
  // Use explicit memory wording + stronger lexical overlap with the seeded fact.
  const recallPrompts = [
    "What do you remember about my burnt orange passport folder, and what do I use it for when I travel? Answer in one sentence.",
    "Recall the travel organization fact I asked you to remember about my passport folder. Include the color and what it holds.",
    "Memory check: tell me the color of my passport folder and what travel items I keep in it.",
  ];

  const requiredValueHits = ["burnt orange"];
  const requiredObjectHits = ["passport folder", "travel document folder", "travel folder"];

   const requiredUsageHits = [
     "travel documents",
     "travel paperwork",
     "passport",
     "printed reservations",
     "backup cards",
     "emergency contact",
   ];

  const denialPhrases = [
    "i do not have",
    "i don't have",
    "i do not recall",
    "i don't recall",
    "not recorded yet",
    "can you tell me more",
    "do you recall",
    "earlier in this session",
    "it is possible",
    "perhaps",
  ];

  function isDenialOrSpeculation(replyText) {
    const text = norm(replyText);
    return denialPhrases.some((p) => text.includes(norm(p)));
  }

   function replyHasAllFactAnchors(replyText) {
     const text = norm(replyText);
     if (isDenialOrSpeculation(text)) return false;
     const hasValue = requiredValueHits.some((p) => text.includes(norm(p)));
     const hasObject = requiredObjectHits.some((p) => text.includes(norm(p)));
     const hasUsage = requiredUsageHits.some((p) => text.includes(norm(p)));
     return hasValue && hasObject && hasUsage;
   }
 
   function collectFactHits(replyText) {
     const text = norm(replyText);
     return [
      ...requiredValueHits.filter((p) => text.includes(norm(p))),
      ...requiredObjectHits.filter((p) => text.includes(norm(p))),
      ...requiredUsageHits.filter((p) => text.includes(norm(p))),
     ];
   }

  async function recallWithRetries(label, mode, conversationId) {
    for (let attempt = 0; attempt < 9; attempt++) {
      const prompt = recallPrompts[attempt % recallPrompts.length];
      const res = await postAiBrain(USER_JWT, {
        user_id: USER_ID,
        conversation_id: conversationId,
        mode,
        op: "e2e_no_proxy",
        message_text: prompt,
        preferred_locale: "en",
      });

      const reply = String(res?.reply_text ?? "").trim();
      if (!reply) {
        await sleep(1200);
        continue;
      }

      console.log(`${label} attempt ${attempt + 1}: ${reply}`);
 
      if (isDenialOrSpeculation(reply)) {
        await sleep(1200);
        continue;
      }

       if (replyHasAllFactAnchors(reply)) {
         return reply;
       }

      await sleep(1200);
    }

    return "";
  }

  const legacyConversationId = crypto.randomUUID();
  const avatarConversationId = crypto.randomUUID();

  const legacyReply = await recallWithRetries("legacy", "legacy", legacyConversationId);
  const avatarReply = await recallWithRetries("avatar", "avatar", avatarConversationId);

  if (!legacyReply) {
    fail("Legacy did not recall the seeded fact within retry window", {
      seed_conversation_id: seedConversationId,
      required_value_hits: requiredValueHits,
      required_object_hits: requiredObjectHits,
      required_usage_hits: requiredUsageHits,
    });
  }

  if (!avatarReply) {
    fail("Avatar did not recall the seeded fact within retry window", {
      seed_conversation_id: seedConversationId,
      required_value_hits: requiredValueHits,
      required_object_hits: requiredObjectHits,
      required_usage_hits: requiredUsageHits,
    });
  }

  const legacyHits = collectFactHits(legacyReply);
  const avatarHits = collectFactHits(avatarReply);
  const sharedAnchorHits = legacyHits.filter((p) => avatarHits.includes(p));

  if (!sharedAnchorHits.some((p) => norm(p) === "burnt orange")) {
    fail("Legacy and avatar did not both recall the seeded fact value", {
      legacy_reply: legacyReply,
      avatar_reply: avatarReply,
      shared_hits: sharedAnchorHits,
      expected_value: seededValue,
    });
  }

  const sharedHasObject = sharedAnchorHits.some((p) =>
    requiredObjectHits.map(norm).includes(norm(p)),
  );
  const sharedHasUsage = sharedAnchorHits.some((p) =>
    requiredUsageHits.map(norm).includes(norm(p)),
  );

  if (!sharedHasObject || !sharedHasUsage) {
    fail("Legacy and avatar did not appear to recall the same underlying fact", {
      legacy_reply: legacyReply,
      avatar_reply: avatarReply,
      shared_hits: sharedAnchorHits,
      required_object_hits: requiredObjectHits,
      required_usage_hits: requiredUsageHits,
    });
  }

  console.log("\nPASS ✅ Shared fact recall verified");
  console.log("seed conversation_id:", seedConversationId);
  console.log("legacy conversation_id:", legacyConversationId);
  console.log("avatar conversation_id:", avatarConversationId);
  console.log("legacy reply:", legacyReply);
  console.log("avatar reply:", avatarReply);
}

main().catch((err) => {
  fail("Unhandled error in shared fact recall E2E", String(err?.stack ?? err));
});