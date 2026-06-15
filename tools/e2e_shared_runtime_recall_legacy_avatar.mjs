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

function requireRecallSignals(label, replyText, mustHaveAny, mustAvoid = []) {
  const text = norm(replyText);
  const hits = mustHaveAny.filter((p) => text.includes(norm(p)));

  if (hits.length === 0) {
    fail(`${label} reply did not show expected shared-memory recall`, {
      reply_text: replyText,
      expected_any_of: mustHaveAny,
    });
  }

  const badHits = mustAvoid.filter((p) => text.includes(norm(p)));
  if (badHits.length > 0) {
    fail(`${label} reply contained an unexpected phrase`, {
      reply_text: replyText,
      unexpected: badHits,
    });
  }

   console.log(`${label} recall hits:`, hits);
 }

function containsRecallDenial(replyText) {
  const text = norm(replyText);
  const bad = [
    "i do not recall",
    "i don't recall",
    "i do not remember",
    "i don't remember",
    "i do not have that story recorded",
    "i don't have that story recorded",
    "can you remind me",
    "could you remind me",
    "can you tell me",
    "do any of those details spark a connection",
  ];
  return bad.some((p) => text.includes(norm(p)));
}

async function main() {
  console.log("Logging in test user...");
  const USER_JWT = await loginAndGetJWT();
  console.log("JWT acquired ✔");

  // Fresh story conversation used to seed shared memory.
  const seedConversationId = crypto.randomUUID();

  const storyTurns = [
    "Three weeks ago in Ayutthaya I rented a bicycle near the old temple grounds because I wanted to photograph the ruins before sunset.",
    "A sudden rain shower forced me under a food stall awning, and while I was drying off I set my folded paper map beside a bowl of noodles and forgot about it.",
    "When I rode away I realized the map was missing, turned back, and found that the vendor had tucked it safely under the counter so it would not blow into the street.",
    "I thanked her, bought an extra bottle of water, and since then I keep all travel notes inside a zip folder instead of loose paper whenever I explore somewhere new.",
  ];

  console.log("Seeding shared memory through legacy mode...");
  for (const turn of storyTurns) {
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

  await postAiBrain(USER_JWT, {
    user_id: USER_ID,
    conversation_id: seedConversationId,
    mode: "legacy",
    op: "e2e_no_proxy",
    end_session: true,
    message_text: "__END_SESSION__",
    preferred_locale: "en",
  });

  // Wait until the story has clearly landed in story_recall + user_knowledge.
  // IMPORTANT:
  // story_seeds may reuse a canonical seed row from an older conversation, so
  // querying story_seeds strictly by this conversation_id can return null even
  // when the story persisted correctly for recall.
   let seedRow = null;
   let matchedStoryKey = null;
  const seedTitleNeedles = ["ayutthaya", "bicycle", "map", "zip folder", "travel documents"];
 
   for (let i = 0; i < 60; i++) {
    const sr = await admin
      .from("story_recall")
      .select("id, story_seed_id, title, synopsis, conversation_id")
      .eq("conversation_id", seedConversationId)
      .order("created_at", { ascending: false })
      .limit(1);
 
     const uk = await admin
      .from("user_knowledge")
      .select("facts")
      .eq("user_id", USER_ID)
      .maybeSingle();

    seedRow = sr.data?.[0] ?? null;
     const facts = uk.data?.facts ?? null;
    if (seedRow && facts && typeof facts === "object") {
      const keys = Object.keys(facts);
      const titleNorm = norm(seedRow.title);
      const synopsisNorm = norm(seedRow.synopsis);

      matchedStoryKey =
        keys.find((k) => {
          const kn = norm(k);
          if (!kn.startsWith("stories.")) return false;
          return (
            seedTitleNeedles.some((p) => kn.includes(norm(p))) ||
            (titleNorm && kn.includes(titleNorm)) ||
            (synopsisNorm && seedTitleNeedles.some((p) => synopsisNorm.includes(norm(p)) && kn.includes(norm(p))))
          );
        }) ?? null;

      if (!matchedStoryKey) {
        matchedStoryKey =
          keys.find((k) => {
            const kn = norm(k);
            if (!kn.startsWith("stories.")) return false;
            try {
              const payload = facts[k];
              const text = norm(typeof payload === "string" ? payload : JSON.stringify(payload ?? ""));
              return seedTitleNeedles.some((p) => text.includes(norm(p)));
            } catch {
              return false;
            }
          }) ?? null;
      }

      if (matchedStoryKey) break;
     }
 
     await sleep(1000);
   }

  if (!seedRow || !matchedStoryKey) {
    fail("Seed story did not land in shared memory", {
      conversation_id: seedConversationId,
      seedRow,
      matchedStoryKey,
    });
  }

   console.log("Shared story seeded ✔", {
     seed_conversation_id: seedConversationId,
    story_recall_id: seedRow.id,
    story_title: seedRow.title,
     matched_story_key: matchedStoryKey,
   });

  // Now ask BOTH modes to recall the same seeded memory.
  const legacyConversationId = crypto.randomUUID();
  const avatarConversationId = crypto.randomUUID();

  const recallPrompt =
    "Do you remember the story about me being caught in the rain while exploring temple ruins, losing a paper map, and deciding to keep travel notes in a zip folder? Give me a brief answer that mentions the place and the lesson.";

  const legacyRes = await postAiBrain(USER_JWT, {
    user_id: USER_ID,
    conversation_id: legacyConversationId,
    mode: "legacy",
    op: "e2e_no_proxy",
    message_text: recallPrompt,
    preferred_locale: "en",
  });

  const avatarRes = await postAiBrain(USER_JWT, {
    user_id: USER_ID,
    conversation_id: avatarConversationId,
    mode: "avatar",
    op: "e2e_no_proxy",
    message_text: recallPrompt,
    preferred_locale: "en",
  });

  const legacyReply = String(legacyRes?.reply_text ?? "").trim();
  const avatarReply = String(avatarRes?.reply_text ?? "").trim();

  if (!legacyReply) fail("Legacy returned empty recall reply", legacyRes);
  if (!avatarReply) fail("Avatar returned empty recall reply", avatarRes);

  const expectedAny = [
    "Ayutthaya",
    "temple",
    "map",
    "zip folder",
    "travel notes",
    "rain",
  ];

  if (containsRecallDenial(legacyReply)) {
    fail("legacy reply denied recall even though shared memory was found", {
      reply_text: legacyReply,
      matched_story_key: matchedStoryKey,
    });
  }

  if (containsRecallDenial(avatarReply)) {
    fail("avatar reply denied recall even though shared memory was found", {
      reply_text: avatarReply,
      matched_story_key: matchedStoryKey,
    });
  }

  requireRecallSignals("legacy", legacyReply, expectedAny);
  requireRecallSignals("avatar", avatarReply, expectedAny);

  // Verify both replies connect to the same seeded memory, not random unrelated stories.
  const sharedAnchorHits = expectedAny.filter(
    (p) => norm(legacyReply).includes(norm(p)) && norm(avatarReply).includes(norm(p)),
  );

  if (sharedAnchorHits.length < 2) {
    fail("Legacy and avatar did not appear to recall the same underlying memory", {
      legacy_reply: legacyReply,
      avatar_reply: avatarReply,
      shared_hits: sharedAnchorHits,
      expected_any: expectedAny,
    });
  }

  console.log("\nPASS ✅ Shared runtime recall verified");
  console.log("shared story key:", matchedStoryKey);
  console.log("legacy conversation_id:", legacyConversationId);
  console.log("avatar conversation_id:", avatarConversationId);
  console.log("legacy reply:", legacyReply);
  console.log("avatar reply:", avatarReply);
}

main().catch((err) => {
  fail("Unhandled error in shared runtime recall E2E", String(err?.stack ?? err));
});