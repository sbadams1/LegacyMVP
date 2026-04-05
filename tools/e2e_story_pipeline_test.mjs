#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const USER_ID = "2dc11e13-f77b-44f0-97ea-b9faa8e948af";

function failWithSeed(msg, seedRow, story, extra = null) {
  const sid = seedRow?.id ?? null;
  const skey = seedRow?.seed_key ?? null;
  const preview = String(story ?? "").trim().slice(0, 360);

  console.error("FAIL:", msg);
  console.error("story_seeds.id:", sid);
  console.error("story_seeds.seed_key:", skey);

  if (preview) {
    console.error("story preview:", preview);
  }

  if (extra) {
    console.error("details:", extra);
  }

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
    if (s && s.length <= 800) extras[k] = v;
  }

  return { ...out, extras };
}

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function pickNarrativeText(row) {
  if (!row || typeof row !== "object") return "";

  const evidence = row.evidence_json && typeof row.evidence_json === "object"
    ? row.evidence_json
    : parseJsonMaybe(row.evidence_json);

  const nestedCandidates = [
    evidence?.story,
    evidence?.retell_text,
    evidence?.retell,
    evidence?.body,
    evidence?.narrative,
    evidence?.content,
    evidence?.synopsis,
    evidence?.summary,
    evidence?.text,
    evidence?.seed_text,
  ];

  for (const v of nestedCandidates) {
    if (typeof v === "string" && v.trim().length >= 120) return v.trim();
  }

  const keys = [
    "retell_text",
    "retell",
    "story",
    "body",
    "narrative",
    "content",
    "synopsis",
    "summary",
    "text",
  ];

  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim().length >= 120) return v.trim();
  }

  let best = "";
  for (const [, v] of Object.entries(row)) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (s.length > best.length) best = s;
  }
  return best;
}

function norm(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function mustIncludeAny(haystack, needles, label) {
  const h = norm(haystack);
  const hits = needles.filter((n) => h.includes(norm(n)));
  if (!hits.length) {
    failWithSeed(`missing expected ${label}`, null, haystack, { needles });
  }
  return hits;
}

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

function slugify(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "story";
}

async function loginAndGetJWT() {
  const { data, error } = await client.auth.signInWithPassword({
    email: TEST_USER_EMAIL,
    password: TEST_USER_PASSWORD,
  });

  if (error) {
    console.error("Login failed:", error.message);
    process.exit(1);
  }

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
  } catch {}

  if (!resp.ok) {
    console.error("ai-brain call failed:", resp.status, json ?? text);
    process.exit(1);
  }

  return json ?? { ok: true };
}

async function main() {
  console.log("Logging in test user...");
  const USER_JWT = await loginAndGetJWT();
  console.log("JWT acquired ✔");

  const conversation_id = crypto.randomUUID();

  const storyTurns = [
    "Last month in Bangkok I took a motorbike taxi across town because I was running late for dinner with a friend.",
    "Halfway there the driver turned into a narrow side street where a night market had spilled into the road and we had to stop suddenly.",
    "My phone slipped from my pocket onto the pavement, and for a second I thought it was gone because people and scooters were moving everywhere around us.",
    "The driver helped me look, we found the phone under a cart wheel with a cracked case, and after that I decided to keep my phone zipped inside my bag whenever I ride.",
  ];

  console.log("Posting multi-turn story...");
  for (let t = 0; t < storyTurns.length; t++) {
    await postAiBrain(USER_JWT, {
      user_id: USER_ID,
      conversation_id,
      mode: "legacy",
      op: "e2e_no_proxy",
      message_text: storyTurns[t],
      preferred_locale: "en",
    });
    await sleep(200);
  }

  console.log("Triggering end_session.");
  await postAiBrain(USER_JWT, {
    user_id: USER_ID,
    conversation_id,
    mode: "legacy",
    op: "e2e_no_proxy",
    end_session: true,
    message_text: "__END_SESSION__",
    preferred_locale: "en",
  });

  for (let i = 0; i < 60; i++) {
    const mr = await admin
      .from("memory_raw")
      .select("*")
      .eq("conversation_id", conversation_id);

    const ms = await admin
      .from("memory_summary")
      .select("*")
      .eq("conversation_id", conversation_id);

    const jobs = await admin
      .from("end_session_jobs")
      .select("id, status, attempt_count, last_error, created_at, started_at, finished_at")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: false })
      .limit(3);

    const ss = await admin
      .from("story_seeds")
      .select("*")
      .eq("conversation_id", conversation_id);

    const sr = await admin
      .from("story_recall")
      .select("*")
      .eq("conversation_id", conversation_id);

    const uk = await admin
      .from("user_knowledge")
      .select("facts")
      .eq("user_id", USER_ID)
      .maybeSingle();

    console.log(
      `poll ${i}: mr=${mr.data?.length ?? 0} jobs=${jobs.data?.length ?? 0} job_status=${jobs.data?.[0]?.status ?? "none"} ms=${ms.data?.length ?? 0} ss=${ss.data?.length ?? 0} sr=${sr.data?.length ?? 0} uk=${uk.data?.facts ? 1 : 0}`,
    );

    if (mr.error) console.log("memory_raw error", mr.error);
    if (ms.error) console.log("memory_summary error", ms.error);
    if (jobs.error) console.log("end_session_jobs error", jobs.error);
    if (ss.error) console.log("story_seeds error", ss.error);
    if (sr.error) console.log("story_recall error", sr.error);
    if (uk.error) console.log("user_knowledge error", uk.error);

    if (ms.data?.length) {
      const latest = ms.data[ms.data.length - 1];
      const summary = summarizeMemorySummaryRow(latest);
      console.log("memory_summary.latest:", JSON.stringify(summary, null, 2));
    }

    const mrCount = mr.data?.length ?? 0;
    const haveAllTurns = mrCount >= storyTurns.length;
    const latestJob = jobs.data?.[0] ?? null;
    const phaseBDone = latestJob?.status === "done";
    const phaseBFailed = latestJob?.status === "failed";

    if (phaseBFailed) {
      console.error("latest end_session_job:", latestJob);
      process.exit(1);
    }

    if (haveAllTurns && phaseBDone && ss.data?.length && uk.data?.facts) {
      const mrTexts = (mr.data ?? []).map((r) => String(r?.content ?? ""));
      const missingTurns = storyTurns.filter(
        (t) => !mrTexts.some((x) => norm(x).includes(norm(t).slice(0, 30))),
      );
      if (missingTurns.length) {
        console.error(
          "missing story turns in memory_raw:",
          missingTurns.map((t) => t.slice(0, 80)),
        );
        process.exit(1);
      }

      const seedRow0 = ss.data?.[0] ?? null;
      const recall = sr.data?.length ? sr.data[0] : null;
      const title = String(recall?.title ?? seedRow0?.title ?? "");
      const seedId = String(recall?.story_seed_id ?? seedRow0?.id ?? "").trim();

      const recallText = pickNarrativeText(recall);

      const seedObj0 = parseJsonMaybe(seedRow0?.seed_text);
      const seedTextStory = String(
        seedObj0?.story ??
        seedObj0?.one_liner ??
        "",
      ).trim();

      const narrativeText =
        recallText && recallText.trim().length >= 80
          ? recallText
          : (seedTextStory && seedTextStory.trim().length >= 80 ? seedTextStory : "");

      if (!narrativeText || narrativeText.length < 120) {
        failWithSeed(
          "missing coherent narrative text (story_recall empty and story_seeds.seed_text.story too short)",
          seedRow0,
          narrativeText || JSON.stringify(recall),
          {
            has_story_recall: Boolean(recall),
            story_recall_len: recallText?.length ?? 0,
            seed_story_len: seedTextStory?.length ?? 0,
          },
        );
      }

      let seed = null;
      if (seedId) {
        const seedRes = await admin
          .from("story_seeds")
          .select("id, seed_key, title, seed_text, source_raw_ids")
          .eq("id", seedId)
          .maybeSingle();
        if (seedRes?.data) seed = seedRes.data;
      }

const rawSeedKey =
  String(seed?.seed_key ?? seedRow0?.seed_key ?? "").trim();

const normalizedSeedKey =
  rawSeedKey.includes("__")
    ? rawSeedKey.split("__")[0]
    : rawSeedKey;

const candidates = [
  normalizedSeedKey ? `stories.${normalizedSeedKey}` : null,
  seed?.id ? `stories.${String(seed.id).trim()}` : null,
].filter(Boolean);

      const facts = uk.data.facts;
const hasCandidate = candidates.some(
  (k) => facts && Object.prototype.hasOwnProperty.call(facts, k),
);

const matchedCandidate =
  candidates.find(
    (k) => facts && Object.prototype.hasOwnProperty.call(facts, k),
  ) ?? null;

const allStoryKeys =
  facts && typeof facts === "object"
    ? Object.keys(facts).filter((k) => String(k).startsWith("stories."))
    : [];

const hasAnyStoryKey = allStoryKeys.length > 0;

      const seedRow = seed ?? ss.data?.[0];
      const rawIds0 = seedRow?.source_raw_ids ?? seedRow?.evidence_raw_ids ?? [];
      let rawIds = [];
      if (Array.isArray(rawIds0)) rawIds = rawIds0;
      else if (typeof rawIds0 === "string") {
        try {
          rawIds = JSON.parse(rawIds0);
        } catch {
          rawIds = [];
        }
      }

      if (!Array.isArray(rawIds) || rawIds.length < 3) {
        failWithSeed(
          "story_seed was not built from multiple turns (source_raw_ids<3)",
          seedRow,
          null,
          { rawIds },
        );
      }

      const rawRowsRes = await admin
        .from("memory_raw")
        .select("id, role, content, created_at")
        .in("id", rawIds);

      if (rawRowsRes.error) {
        failWithSeed(
          "failed to load evidence memory_raw rows",
          seedRow,
          null,
          rawRowsRes.error,
        );
      }

      const rawRows = rawRowsRes.data ?? [];
      const turnCoverage = storyTurns.map((t) =>
        rawRows.some((r) => norm(r?.content).includes(norm(t).slice(0, 30)))
      );
      const covered = turnCoverage.filter(Boolean).length;

      if (covered < Math.min(3, storyTurns.length)) {
        failWithSeed(
          "story_seed evidence does not cover enough distinct turns",
          seedRow,
          null,
          { covered, turnCoverage },
        );
      }

      const seedObj = parseJsonMaybe(seedRow?.seed_text);
      const story = String(seedObj?.story ?? "").trim();
      const oneLiner = String(seedObj?.one_liner ?? "").trim();

      const keyPhrases = [
        "bangkok",
        "motorbike",
        "driver",
        "market",
        "phone",
        "pocket",
        "cracked",
        "decided",
      ];

      const storyHits = keyPhrases.filter((k) => norm(story).includes(k));
      const narrativeHits = keyPhrases.filter((k) => norm(narrativeText).includes(k));

      if (storyHits.length < 4) {
        failWithSeed(
          "stitched story is missing key elements from the turns",
          seedRow,
          story,
          { storyHits },
        );
      }

      if (narrativeHits.length < 3) {
        failWithSeed(
          "narrative text is missing key elements from the turns",
          seedRow,
          narrativeText,
          { narrativeHits },
        );
      }

      const sentenceCount = (story.match(/[.!?](\s|$)/g) ?? []).length;
      const hasFirstPerson = /\b(i|my|me|we|our)\b/i.test(story);
      const hasSequence = /\b(then|after that|afterwards|next|later|before that|eventually)\b/i.test(story);
      const hasOutcome = /\b(in the end|i decided|i learned|i realized|so i)\b/i.test(story);

      if (
        !oneLiner ||
        story.length < 220 ||
        sentenceCount < 2 ||
        !hasFirstPerson ||
        !hasSequence ||
        !hasOutcome
      ) {
        failWithSeed(
          "story_seed is not retellable enough",
          seedRow,
          story,
          {
            oneLinerLen: oneLiner.length,
            storyLen: story.length,
            sentenceCount,
            hasFirstPerson,
            hasSequence,
            hasOutcome,
          },
        );
      }

      if (!hasAnyStoryKey) {
        failWithSeed(
          "user_knowledge facts missing any stories.* key",
          seedRow,
          facts,
          { tried: candidates, sampleKeys: Object.keys(facts ?? {}).slice(0, 30) },
        );
      }

if (!hasCandidate) {
  failWithSeed(
    "canonical story key did not match any user_knowledge stories.* key",
    seedRow,
    narrativeText,
    {
      tried: candidates,
      available: allStoryKeys.slice(0, 10),
      seed_key: canonicalSeedKey || null,
      seed_id: seed?.id ?? seedRow0?.id ?? null,
      title,
    },
  );
} else {
  console.log("Matched story key in user_knowledge:", matchedCandidate);
}

      console.log("\nPASS ✅ Story pipeline verified");
      console.log("memory_raw ✔");
      console.log("story_seeds ✔");
      if (recall && recallText && recallText.trim().length >= 80) {
        console.log("story_recall ✔");
      } else {
        console.log("story_recall (optional) — not present yet");
      }
      console.log("user_knowledge ✔");
      process.exit(0);
    }

    await sleep(1000);
  }

  console.error("FAIL: Timed out waiting for story pipeline completion");
  console.error("conversation_id:", conversation_id);

  try {
    const msFinal = await admin
      .from("memory_summary")
      .select("*")
      .eq("conversation_id", conversation_id);
    if (msFinal.data?.length) {
      const latest = msFinal.data[msFinal.data.length - 1];
      console.error(
        "memory_summary.latest:",
        JSON.stringify(summarizeMemorySummaryRow(latest), null, 2),
      );
    }
  } catch {}

  try {
    const mrFinal = await admin
      .from("memory_raw")
      .select("id, role, source, content, created_at")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: false })
      .limit(10);
    if (mrFinal.data?.length) {
      console.error("last memory_raw rows (up to 10):");
      for (const r of mrFinal.data) {
        const preview = String(r?.content ?? "").replace(/\s+/g, " ").slice(0, 180);
        console.error(
          `- ${String(r?.id ?? "").slice(0, 8)} role=${r?.role} source=${r?.source} | ${preview}`,
        );
      }
    }
  } catch {}

  try {
    const jobsFinal = await admin
      .from("end_session_jobs")
      .select("id, status, attempt_count, last_error, created_at, started_at, finished_at")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: false })
      .limit(5);
    if (jobsFinal.data?.length) {
      console.error("end_session_jobs (latest first):");
      for (const j of jobsFinal.data) {
        console.error(
          `- ${String(j?.id ?? "").slice(0, 8)} status=${j?.status} attempts=${j?.attempt_count ?? 0} last_error=${String(j?.last_error ?? "").slice(0, 220)}`,
        );
      }
    }
  } catch {}

  process.exit(1);
}

main();