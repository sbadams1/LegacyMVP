#!/usr/bin/env node
/**
 * E2E: Connect-the-dots across sessions (non-JWT credentials)
 *
 * Requires env:
 *   SUPABASE_URL=...
 *   SB_SECRET_KEY=sb_secret_...   (non-JWT service key)
 *   TEST_USER_ID=<uuid>
 *
 * Optional:
 *   AI_BRAIN_FUNCTION=ai-brain     (default)
 *
 * Run:
 *   node tools/e2e_connect_the_dots_test.mjs
 */

 import assert from "node:assert/strict";
 import process from "node:process";
 import crypto from "node:crypto";
 import { createClient } from "@supabase/supabase-js";
 
 const SUPABASE_URL = mustEnv("SUPABASE_URL");
// Non-JWT service credentials:
// Prefer your existing env var name; fall back to SB_SECRET_KEY if you use it elsewhere.
const SB_SECRET_KEY =
  String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim() ||
  String(process.env.SB_SECRET_KEY || "").trim();
if (!SB_SECRET_KEY) {
  throw new Error("Missing required env var: SUPABASE_SERVICE_ROLE_KEY (or SB_SECRET_KEY)");
}
 const TEST_USER_ID = mustEnv("TEST_USER_ID");
 const AI_BRAIN_FUNCTION = process.env.AI_BRAIN_FUNCTION || "ai-brain";

// Keep timeouts generous; edge + DB + summarizer can vary.
const WAIT_AFTER_END_SESSION_MS = Number(process.env.WAIT_AFTER_END_SESSION_MS || "1200");
const WAIT_POLL_MAX_MS = Number(process.env.WAIT_POLL_MAX_MS || "15000");
const WAIT_POLL_EVERY_MS = Number(process.env.WAIT_POLL_EVERY_MS || "750");

const client = createClient(SUPABASE_URL, SB_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    // Use the non-JWT secret as both apikey and bearer; supabase-js does this internally,
    // but we set it explicitly to be unambiguous.
    headers: {
      apikey: SB_SECRET_KEY,
      Authorization: `Bearer ${SB_SECRET_KEY}`,
    },
  },
});

function mustEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

async function invokeAiBrain(body) {
  const { data, error } = await client.functions.invoke(AI_BRAIN_FUNCTION, { body });
  if (error) {
    // supabase-js wraps edge errors; surface details
    throw new Error(`ai-brain invoke failed: ${error.message || String(error)}`);
  }
  return data;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll a query until it returns a non-null row, or timeout.
 */
async function pollForMemorySummary({ user_id, conversation_id }) {
  const start = Date.now();
  while (Date.now() - start < WAIT_POLL_MAX_MS) {
    const { data, error } = await client
      .from("memory_summary")
      .select("id, user_id, conversation_id, raw_id, short_summary, observations, created_at, updated_at")
      .eq("user_id", user_id)
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(`memory_summary select failed: ${error.message || String(error)}`);
    if (data?.id) return data;

    await sleep(WAIT_POLL_EVERY_MS);
  }
  throw new Error(`Timed out waiting for memory_summary for conversation_id=${conversation_id}`);
}

async function pollForLatestAssistantMemoryRaw({ user_id, conversation_id }) {
  const start = Date.now();
  while (Date.now() - start < WAIT_POLL_MAX_MS) {
    const { data, error } = await client
      .from("memory_raw")
      .select("*")
      .eq("user_id", user_id)
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) throw new Error(`memory_raw select failed: ${error.message || String(error)}`);
    const rows = Array.isArray(data) ? data : [];

    // Try to find an assistant row by common role/speaker fields.
    const assistantRow = rows.find((r) => {
      const role = String(r?.role ?? r?.speaker ?? r?.actor ?? "").toLowerCase();
      return role.includes("assistant") || role === "bot" || role === "ai";
    }) || rows[0];

    if (assistantRow) return assistantRow;
    await sleep(WAIT_POLL_EVERY_MS);
  }
  throw new Error(`Timed out waiting for memory_raw for conversation_id=${conversation_id}`);
}

function assertNoBioDump(reply) {
  const r = String(reply || "").trim();
  const rl = r.toLowerCase();

  // Hard bans: these are almost always “profile dump” behavior.
  const banned = [
    "i have recorded that",
    "i have on file",
    "i have noted that",
    "according to your profile",
    "based on your profile",
    "my records show",
    "i have stored that",
    "given what i have recorded",
    "things that stand out include",
    "some things that stand out include",
    "what i have recorded",
    "what i do not have recorded",
  ];
  const hit = banned.find((p) => rl.includes(p));
  if (hit) {
    throw new Error(`FAIL no-bio-dump: reply contains banned phrase "${hit}". Reply preview="${r.slice(0, 220)}"`);
  }

  // Inventory-list detection (biography dump), but do NOT punish comma-rich pattern sentences.
  // We fail only when it looks like a list AND it contains multiple biographical tokens.
  const head = rl.slice(0, 420);
  const semicolons = (head.match(/;/g) || []).length;
  const bullets = (head.match(/(^|\n)\s*[-*]\s+/g) || []).length;
  const manyYours = (head.match(/\byour\b/g) || []).length;

  // "Listy" signals
  const listy =
    semicolons >= 2 ||
    bullets >= 2 ||
    manyYours >= 5 ||
    /\binclude\b/.test(head) ||
    /\bstand out\b/.test(head);

  // Bio tokens (identity/profile inventory content)
  const bioTokens = [
    "daughters",
    "divorce",
    "retire",
    "retirement",
    "born",
    "age",
    "years old",
    "thailand",
    "jomtien",
    "pattaya",
    "social security",
    "administration",
    "move to",
    "moved to",
  ];
  let bioHits = 0;
  for (const t of bioTokens) if (head.includes(t)) bioHits++;

  const minBioHits = Number(process.env.E2E_MIN_BIO_TOKEN_HITS_FOR_FAIL || "2");
  if (listy && bioHits >= minBioHits) {
    throw new Error(
      `FAIL no-bio-dump: reply looks like a bio inventory list (listy=${listy}, bioHits=${bioHits}). Preview="${r.slice(0, 260)}"`
    );
  }
}

function extractTextFromMemoryRawRow(row) {
  if (!row || typeof row !== "object") return "";
  const candidates = [
    row.content,
    row.text,
    row.message_text,
    row.message,
    row.body,
    row.raw_text,
    row.assistant_text,
    row.user_text,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  // Some pipelines store JSON in a column; attempt a few common shapes.
  const j = row.value_json ?? row.raw_json ?? row.payload_json ?? null;
  if (j && typeof j === "object") {
    const nested = [j.content, j.text, j.message_text, j.message, j.reply_text];
    for (const c of nested) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
  }
  return "";
}

function overlapHitsBetweenTexts(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  let hits = 0;
  for (const w of A) if (B.has(w)) hits++;
  return hits;
}

async function bestEffortCleanup({ user_id, convoIds, marker }) {
  // Delete in reverse dependency-ish order; best effort only.
  // NOTE: your schema may have FKs; if deletes fail, we log and continue.
  try {
    await client.from("memory_insights").delete().eq("user_id", user_id).contains("metadata", { e2e_marker: marker });
  } catch (_) {}

  for (const cid of convoIds) {
    try {
      await client.from("memory_summary").delete().eq("user_id", user_id).eq("conversation_id", cid);
    } catch (_) {}
    try {
      await client.from("memory_raw").delete().eq("user_id", user_id).eq("conversation_id", cid);
    } catch (_) {}
  }
}

function pick(obj, path, fallback = null) {
  try {
    const parts = path.split(".");
    let cur = obj;
    for (const p of parts) cur = cur?.[p];
    return cur ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Session script: send multiple turns + end_session
 */
async function runSession({ user_id, conversation_id, e2e_marker, turns }) {
  for (const t of turns) {
    const resp = await invokeAiBrain({
      user_id,
      conversation_id,
      message_text: t,
      preferred_locale: "en",
      mode: "legacy",
      e2e_marker,
    });

    // Not all turns must return reply_text depending on your pipeline,
    // but usually they do. Keep it as soft assertion.
    if (resp && typeof resp === "object" && "reply_text" in resp) {
      const rt = String(resp.reply_text || "").trim();
      assert.ok(rt.length >= 1, "Expected non-empty reply_text for normal turn");
    }
  }

  // End session
  const endResp = await invokeAiBrain({
    user_id,
    conversation_id,
    end_session: true,
    message_text: "__END_SESSION__",
    preferred_locale: "en",
    mode: "legacy",
    e2e_marker,
  });

  // We expect an end-session payload object, but shape can vary.
  assert.ok(endResp != null, "Expected end-session response payload");

  // Give DB a moment, then poll for summary row.
  await sleep(WAIT_AFTER_END_SESSION_MS);
  const summaryRow = await pollForMemorySummary({ user_id, conversation_id });

  return { endResp, summaryRow };
}

function hasLongitudinalSnapshot(summaryRow) {
  const obs = summaryRow?.observations;
  const snap = obs?.longitudinal_snapshot;
  if (!snap || typeof snap !== "object") return false;
  // Prefer snapshot_text (UI-ready), but accept structured signals.
  const snapshotText = String(snap.snapshot_text || "").trim();
  const emerging = Array.isArray(snap.emerging_themes_month) ? snap.emerging_themes_month : [];
  const changed = snap.changed_since_last_week || {};
  const up = Array.isArray(changed.up) ? changed.up : [];
  const down = Array.isArray(changed.down) ? changed.down : [];
  return snapshotText.length > 0 || emerging.length > 0 || up.length > 0 || down.length > 0;
}

function snapshotMentionsTheme(summaryRow, themeNeedleLower) {
  const obs = summaryRow?.observations;
  const snap = obs?.longitudinal_snapshot;
  if (!snap || typeof snap !== "object") return false;

  const hay = [
    String(snap.snapshot_text || ""),
    JSON.stringify(snap.emerging_themes_month || []),
    JSON.stringify(snap.changed_since_last_week || {}),
  ]
    .join("\n")
    .toLowerCase();

  return hay.includes(themeNeedleLower);
}

function snapshotHaystack(summaryRow) {
  const snap = summaryRow?.observations?.longitudinal_snapshot;
  if (!snap || typeof snap !== "object") return "";
  return [
    String(snap.snapshot_text || ""),
    JSON.stringify(snap.emerging_themes_month || []),
    JSON.stringify(snap.changed_since_last_week || {}),
    JSON.stringify(snap || {}),
  ]
    .join("\n")
    .toLowerCase();
}

function tokenize(text) {
  // Keep it simple: words length>=5, letters only, lowercased.
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z\s]+/g, " ")
    .split(/\s+/g)
    .filter((w) => w.length >= 5);
}

function unique(arr) {
  return Array.from(new Set(arr));
}

function countOverlapTokens({ seedText, hayText }) {
  const seed = unique(tokenize(seedText));
  const haySet = new Set(tokenize(hayText));
  let hits = 0;
  const matched = [];
  for (const w of seed) {
    if (haySet.has(w)) {
      hits++;
      matched.push(w);
    }
  }
  return { hits, matched: matched.slice(0, 30), seedCount: seed.length };
}

async function assertOnlyLegacySources({ user_id, convoIds }) {
  const allowed = new Set(["legacy_user", "legacy_ai"]);
  const { data, error } = await client
    .from("memory_raw")
    .select("id, conversation_id, source, role, created_at")
    .eq("user_id", user_id)
    .in("conversation_id", convoIds)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`memory_raw select for source assertion failed: ${error.message || String(error)}`);
  const rows = Array.isArray(data) ? data : [];

  const bad = rows.filter((r) => !allowed.has(String(r?.source || "").trim()));
  if (bad.length > 0) {
    const counts = new Map();
    for (const r of bad) {
      const k = String(r?.source || "NULL");
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const bySource = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");

    const preview = bad
      .slice(0, 8)
      .map((r) => ({
        id: r.id,
        conversation_id: r.conversation_id,
        source: r.source,
        role: r.role,
        created_at: r.created_at,
      }));

    throw new Error(
      `FAIL persisted non-legacy memory_raw.source detected. Allowed=legacy_user|legacy_ai. Found=${bySource}. Sample=${JSON.stringify(preview)}`
    );
  }
}

async function main() {
  const marker = `e2e_connect_dots_${uuid().slice(0, 8)}`;
  const convo1 = uuid();
  const convo2 = uuid();
  const convo3 = uuid();

  console.log("E2E connect-the-dots starting:", {
    marker,
    user_id: TEST_USER_ID,
    convo1,
    convo2,
    convo3,
    when: nowIso(),
    function: AI_BRAIN_FUNCTION,
  });

  try {
    // SESSION 1: establish baseline themes
    const session1Turns = [
      `(${marker}) I'm noticing I have a very low tolerance for bullshit at work. I prefer autonomy over obligation.`,
      `(${marker}) When systems feel corrupted, I tend to withdraw rather than argue. I pick peace over participation.`,
      `(${marker}) I'm trying to live intentionally and avoid getting pulled into pointless drama.`,
    ];
    const s1 = await runSession({
      user_id: TEST_USER_ID,
      conversation_id: convo1,
      e2e_marker: marker,
      turns: session1Turns,
    });

    assert.ok(String(s1.summaryRow.short_summary || "").trim().length > 0, "Session 1: expected short_summary");
    console.log("PASS session1 summary:", {
      id: s1.summaryRow.id,
      short_len: String(s1.summaryRow.short_summary || "").length,
    });

    const session1SeedText = session1Turns.join("\n");

    // SESSION 2: repeat + expand themes so longitudinal snapshot has something to “connect”
    const session2Turns = [
      `(${marker}) Again today: I chose not to engage in an argument because it felt like a rigged conversation.`,
      `(${marker}) I value moral clarity more than social harmony, but I also choose peace over participation.`,
      `(${marker}) Autonomy matters a lot to me. If I can't control my time, I feel trapped.`,
      `(${marker}) I'm seeing the same selection principles show up across different topics: work, relationships, politics.`,
    ];
    const session2SeedText = session2Turns.join("\n");
    const s2 = await runSession({
      user_id: TEST_USER_ID,
      conversation_id: convo2,
      e2e_marker: marker,
      turns: session2Turns,
    });

    assert.ok(String(s2.summaryRow.short_summary || "").trim().length > 0, "Session 2: expected short_summary");
    console.log("PASS session2 summary:", {
      id: s2.summaryRow.id,
      short_len: String(s2.summaryRow.short_summary || "").length,
    });

    // CORE ASSERTION: after a second session, we should have longitudinal linkage signals
    assert.ok(
      hasLongitudinalSnapshot(s2.summaryRow),
      "Expected observations.longitudinal_snapshot to be present/non-empty after Session 2"
    );

    // Stronger-but-robust signal:
    // Instead of requiring a single keyword, require token overlap between what the user said
    // (sessions 1+2 seed text) and the longitudinal snapshot content.
    const hay = snapshotHaystack(s2.summaryRow);
    const seedAll = `${session1SeedText}\n${session2SeedText}`;
    const overlap = countOverlapTokens({ seedText: seedAll, hayText: hay });

    // Threshold: 2 overlapping tokens is usually enough to prove the snapshot is grounded
    // in prior-session content without being brittle.
    const minOverlap = Number(process.env.E2E_MIN_SNAPSHOT_TOKEN_OVERLAP || "2");
    if (overlap.hits < minOverlap) {
      const snap = s2.summaryRow?.observations?.longitudinal_snapshot;
      console.log("DEBUG longitudinal_snapshot JSON:", JSON.stringify(snap, null, 2).slice(0, 2000));
      console.log("DEBUG overlap:", overlap);
    }
    assert.ok(
      overlap.hits >= minOverlap,
      `Expected longitudinal snapshot to overlap with prior sessions (token hits=${overlap.hits}, min=${minOverlap}). Matched=${overlap.matched.join(", ")}`
    );

    const snapText = String(pick(s2.summaryRow, "observations.longitudinal_snapshot.snapshot_text", "") || "").trim();
    console.log("PASS longitudinal snapshot:", {
      has_snapshot_text: snapText.length > 0,
      snapshot_text_preview: snapText.slice(0, 140),
      token_overlap_hits: overlap.hits,
      token_overlap_matched: overlap.matched.slice(0, 12),
    });

    // SESSION 3: ask explicitly for “connecting the dots”
    // We validate BOTH:
    //  (a) the immediate reply_text references prior-session themes (token overlap, not brittle keywords), and
    //  (b) the persisted memory_raw row for this turn contains similar content.
    const s3Turn = `(${marker}) What keeps showing up for me lately across sessions? Connect the dots.`;
    const s3Resp = await invokeAiBrain({
      user_id: TEST_USER_ID,
      conversation_id: convo3,
      message_text: s3Turn,
      preferred_locale: "en",
      mode: "legacy",
      e2e_marker: marker,
    });

    const reply = String(s3Resp?.reply_text || "").trim();
    assert.ok(reply.length > 0, "Session 3: expected reply_text");

    // STRICT: fail if the model starts dumping profile facts instead of connecting dots.
    assertNoBioDump(reply);

    // STRONG REQUIREMENT: reply must be anchored to longitudinal snapshot language.
    // This prevents passing via generic “about you” facts.
    const snapHay = snapshotHaystack(s2.summaryRow);
    const overlapSnapStrict = countOverlapTokens({ seedText: snapHay, hayText: reply });
    const minSnapOverlapStrict = Number(process.env.E2E_MIN_REPLY_SNAPSHOT_OVERLAP || "5");
    if (overlapSnapStrict.hits < minSnapOverlapStrict) {
      console.log("DEBUG strict snapshot overlap failed:", overlapSnapStrict);
      console.log("DEBUG reply preview:", reply.slice(0, 500));
      console.log("DEBUG snapshot preview:", snapHay.slice(0, 800));
    }
    assert.ok(
      overlapSnapStrict.hits >= minSnapOverlapStrict,
      `Expected Session 3 reply to use longitudinal snapshot (hits=${overlapSnapStrict.hits}, min=${minSnapOverlapStrict}).`
    );

    // Pull the stored row for the session-3 assistant message (best-effort, schema-flexible).
    const rawRow = await pollForLatestAssistantMemoryRaw({
      user_id: TEST_USER_ID,
      conversation_id: convo3,
    });
    const storedText = extractTextFromMemoryRawRow(rawRow);
    assert.ok(storedText.length > 0, "Session 3: expected a persisted memory_raw text field");

    // Ensure the stored assistant text resembles the returned reply_text (not necessarily identical).
    const minStoredOverlap = Number(process.env.E2E_MIN_REPLY_VS_RAW_TOKEN_OVERLAP || "3");
    const replyVsStoredHits = overlapHitsBetweenTexts(reply, storedText);
    assert.ok(
      replyVsStoredHits >= minStoredOverlap,
      `Session 3: expected reply_text to match persisted memory_raw (hits=${replyVsStoredHits}, min=${minStoredOverlap})`
    );

    // Now the main "connect the dots" validation: does the reply overlap with prior-session content?
    const priorSeed = `${session1SeedText}\n${session2SeedText}`;
    const snapHayStrict = snapshotHaystack(s2.summaryRow);

    const overlapPrior = countOverlapTokens({ seedText: priorSeed, hayText: reply });
    const overlapSnap = countOverlapTokens({ seedText: snapHay, hayText: reply });

    const minReplyOverlap = Number(process.env.E2E_MIN_REPLY_TOKEN_OVERLAP || "2");
    const bestHits = Math.max(overlapPrior.hits, overlapSnap.hits);

    if (bestHits < minReplyOverlap) {
      console.log("DEBUG session3 reply:", reply.slice(0, 500));
      console.log("DEBUG overlapPrior:", overlapPrior);
      console.log("DEBUG overlapSnap:", overlapSnap);
      console.log("DEBUG snapshot preview:", snapHayStrict.slice(0, 800));

    }

    assert.ok(
      bestHits >= minReplyOverlap,
      `Expected Session 3 reply to connect to prior sessions (best token hits=${bestHits}, min=${minReplyOverlap}).`
    );

    console.log("PASS session3 connect-the-dots:", {
      reply_len: reply.length,
      stored_len: storedText.length,
      reply_vs_raw_hits: replyVsStoredHits,
      overlap_prior_hits: overlapPrior.hits,
      overlap_prior_matched: overlapPrior.matched.slice(0, 12),
      overlap_snapshot_hits: overlapSnap.hits,
      overlap_snapshot_matched: overlapSnap.matched.slice(0, 12),
      reply_preview: reply.slice(0, 160),
    });

    // HARD ASSERTION: no transient-lane source values should persist in memory_raw.
    await assertOnlyLegacySources({
      user_id: TEST_USER_ID,
      convoIds: [convo1, convo2, convo3],
    });

    console.log("✅ E2E CONNECT-THE-DOTS PASS");
  } finally {
    console.log("Cleanup (best effort)...");
    await bestEffortCleanup({
      user_id: TEST_USER_ID,
      convoIds: [convo1, convo2, convo3],
      marker,
    });
  }
}

main().catch((e) => {
  console.error("❌ E2E CONNECT-THE-DOTS FAIL:", e?.stack || e);
  process.exit(1);
});
