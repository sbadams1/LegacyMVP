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

function replyHasAny(replyText, phrases) {
  const text = norm(replyText);
  return phrases.some((p) => text.includes(norm(p)));
}

function collectHits(replyText, phrases) {
  const text = norm(replyText);
  return phrases.filter((p) => text.includes(norm(p)));
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

  const storyTurns = [
    "Three weeks ago in Ayutthaya I rented a bicycle near the old temple grounds because I wanted to photograph the ruins before sunset.",
    "Halfway through the ride a sudden rainstorm started, and while I was trying to shelter near a wall I lost the folded paper map I had been using.",
    "I still found the right temple eventually, but the wet map turned useless and I had to rely on memory and landmarks to get back.",
    "After that trip I decided to keep travel notes, tickets, and route details inside a zip folder whenever I explore somewhere new.",
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
  let latestSeed = null;
  let factsSnapshot = null;
  let matchedStoryKey = null;

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

    const ss = await admin
      .from("story_seeds")
      .select("id, seed_key, title, conversation_id")
      .eq("conversation_id", seedConversationId)
      .order("created_at", { ascending: false })
      .limit(5);

    const uk = await admin
      .from("user_knowledge")
      .select("facts")
      .eq("user_id", USER_ID)
      .maybeSingle();

    latestSummary = ms.data?.[0] ?? null;
    latestSeed = ss.data?.[0] ?? null;
    factsSnapshot = uk.data?.facts ?? null;

    console.log(
      `poll ${i}: job_status=${jobs.data?.[0]?.status ?? "none"} memory_summary=${latestSummary ? 1 : 0} story_seeds=${ss.data?.length ?? 0} facts=${factsSnapshot ? 1 : 0}`,
    );

    if (latestSummary) {
      console.log("memory_summary.latest:", JSON.stringify(summarizeMemorySummaryRow(latestSummary), null, 2));
    }

    const phaseBDone = jobs.data?.[0]?.status === "done";
    const phaseBFailed = jobs.data?.[0]?.status === "failed";

    if (phaseBFailed) {
      fail("end_session job failed during story seeding", jobs.data?.[0] ?? null);
    }

    const storyKeys =
      factsSnapshot && typeof factsSnapshot === "object"
        ? Object.keys(factsSnapshot).filter((k) => String(k).startsWith("stories."))
        : [];

    matchedStoryKey =
      latestSeed?.seed_key && storyKeys.includes(`stories.${String(latestSeed.seed_key).trim()}`)
        ? `stories.${String(latestSeed.seed_key).trim()}`
        : storyKeys[0] ?? null;

    if (phaseBDone && latestSeed && matchedStoryKey) {
      break;
    }

    await sleep(1000);
  }

  if (!latestSeed || !matchedStoryKey) {
    fail("Shared story did not land in story_seeds/user_knowledge after Phase B", {
      seed_conversation_id: seedConversationId,
      latest_memory_summary_id: latestSummary?.id ?? null,
      latest_short_summary: latestSummary?.short_summary ?? null,
      story_seed_id: latestSeed?.id ?? null,
      story_seed_key: latestSeed?.seed_key ?? null,
      facts_keys_sample:
        factsSnapshot && typeof factsSnapshot === "object"
          ? Object.keys(factsSnapshot).slice(0, 20)
          : [],
    });
  }

  console.log("Shared story seeded ✔", {
    seed_conversation_id: seedConversationId,
    story_seed_id: latestSeed.id,
    story_seed_key: latestSeed.seed_key,
    matched_story_key: matchedStoryKey,
  });

  const recallPrompts = [
    "What do you remember about the Ayutthaya bicycle trip? Answer briefly with the place, the rain, the lost map, and what habit I adopted afterward.",
    "Recall the story about me renting a bicycle near temple ruins in Ayutthaya. Include the rain, the paper map, and what I decided to do afterward.",
    "Memory check: tell me the Ayutthaya story where I explored temple ruins, got caught in the rain, lost my map, and changed how I store travel notes.",
  ];

  const storyAnchors = [
    "ayutthaya",
    "bicycle",
    "temple",
    "rain",
    "map",
    "zip folder",
    "travel notes",
  ];

  async function recallWithRetries(label, mode, conversationId) {
    for (let attempt = 0; attempt < 8; attempt++) {
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

      const hits = collectHits(reply, storyAnchors);
      console.log(`${label} attempt ${attempt + 1}:`, hits);

      if (hits.length >= 4 && replyHasAny(reply, ["ayutthaya", "temple"])) {
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
    fail("Legacy did not recall the seeded story within retry window", {
      seed_conversation_id: seedConversationId,
      story_seed_key: latestSeed.seed_key,
      matched_story_key: matchedStoryKey,
    });
  }

  if (!avatarReply) {
    fail("Avatar did not recall the seeded story within retry window", {
      seed_conversation_id: seedConversationId,
      story_seed_key: latestSeed.seed_key,
      matched_story_key: matchedStoryKey,
    });
  }

  const legacyHits = collectHits(legacyReply, storyAnchors);
  const avatarHits = collectHits(avatarReply, storyAnchors);
  const sharedHits = legacyHits.filter((p) => avatarHits.includes(p));

  if (sharedHits.length < 4) {
    fail("Legacy and avatar did not appear to recall the same underlying story", {
      legacy_reply: legacyReply,
      avatar_reply: avatarReply,
      legacy_hits: legacyHits,
      avatar_hits: avatarHits,
      shared_hits: sharedHits,
      matched_story_key: matchedStoryKey,
    });
  }

  console.log("\nPASS ✅ Shared runtime story recall verified");
  console.log("shared story key:", matchedStoryKey);
  console.log("legacy conversation_id:", legacyConversationId);
  console.log("avatar conversation_id:", avatarConversationId);
  console.log("legacy reply:", legacyReply);
  console.log("avatar reply:", avatarReply);
}

main().catch((err) => {
  fail("Unhandled error in shared story recall E2E", String(err?.stack ?? err));
});