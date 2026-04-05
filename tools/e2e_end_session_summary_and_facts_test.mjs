// tools/e2e_end_session_summary_and_facts_test.mjs
// Node 18+ (fetch + crypto.randomUUID)
// Usage (PowerShell example):
//   $env:SUPABASE_URL="https://YOURPROJECT.supabase.co"
//   $env:SUPABASE_ANON_KEY="..."
//   $env:SUPABASE_SERVICE_ROLE_KEY="..."
//   $env:E2E_EMAIL="you@example.com"
//   $env:E2E_PASSWORD="..."
//   node tools/e2e_end_session_summary_and_facts_test.mjs

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import crypto from "node:crypto";
import process from "node:process";

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").trim();
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY ?? "").trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
const E2E_EMAIL = (process.env.E2E_EMAIL ?? "").trim();
const E2E_PASSWORD = (process.env.E2E_PASSWORD ?? "").trim();

// Optional overrides
const FUNCTIONS_PATH = (process.env.SUPABASE_FUNCTIONS_PATH ?? "/functions/v1").trim();
const FUNCTION_NAME = (process.env.AI_BRAIN_FUNCTION_NAME ?? "ai-brain").trim();

// Polling config
const POLL_MS = Number(process.env.E2E_POLL_MS ?? "1000");
const POLL_MAX_TRIES = Number(process.env.E2E_POLL_MAX_TRIES ?? "20");

function must(name, v) {
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function restUrl(path) {
  return `${SUPABASE_URL.replace(/\/$/, "")}${path}`;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep raw
  }
  if (!res.ok) {
    const msg = `HTTP ${res.status} ${res.statusText} for ${url}\n${text}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = text;
    err.json = json;
    throw err;
  }
  return json;
}

async function loginWithPassword(email, password) {
  const url = restUrl(`/auth/v1/token?grant_type=password`);
  const json = await fetchJson(url, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  const access_token = json?.access_token;
  const user_id = json?.user?.id;
  assert.ok(access_token, "Login failed: missing access_token");
  assert.ok(user_id, "Login failed: missing user.id");
  return { access_token, user_id };
}

async function callAiBrain({ access_token, payload }) {
  const url = restUrl(`${FUNCTIONS_PATH}/${encodeURIComponent(FUNCTION_NAME)}`);
  // ai-brain expects Authorization header; apikey required for Supabase gateway
  return await fetchJson(url, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function restSelectService(pathWithQuery) {
  const url = restUrl(pathWithQuery);
  return await fetchJson(url, {
    method: "GET",
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Accept": "application/json",
    },
  });
}

async function restPatchService(pathWithQuery, body) {
  const url = restUrl(pathWithQuery);
  return await fetchJson(url, {
    method: "PATCH",
    headers: {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
      // So we can see what we updated if desired
      "Prefer": "return=representation",
    },
    body: JSON.stringify(body ?? {}),
  });
}

async function poll(fn, { label, maxTries, sleepMs }) {
  let last = null;
  for (let i = 1; i <= maxTries; i++) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      // keep last error for visibility, but continue polling
      last = e;
    }
    await sleep(sleepMs);
  }
  if (last instanceof Error) throw last;
  throw new Error(`Timed out polling: ${label}`);
}

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) p.set(k, v);
  return p.toString();
}

async function main() {
  must("SUPABASE_URL", SUPABASE_URL);
  must("SUPABASE_ANON_KEY", SUPABASE_ANON_KEY);
  must("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);
  must("E2E_EMAIL", E2E_EMAIL);
  must("E2E_PASSWORD", E2E_PASSWORD);

  const { access_token, user_id } = await loginWithPassword(E2E_EMAIL, E2E_PASSWORD);

  const conversation_id = crypto.randomUUID();
  const e2e_marker = `e2e_end_session_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  console.log("E2E end-session summary+facts", { conversation_id, user_id, e2e_marker });

  // 1) Send a few messages containing obvious fact-like statements
  const turns = [
    "I have three daughters: Alicia, Asia, and Amir.",
    "My oldest Alicia and youngest Amir share the same birthday: August 20 (not twins).",
    "My middle daughter Asia is a chiropractor in the Dallas, Texas area.",
    "My first position at SSA (July 1998) was an audio-visual production specialist in the Dallas Regional Office video training studio.",
  ];

  for (const t of turns) {
    await callAiBrain({
      access_token,
      payload: {
        user_id,
        conversation_id,
        message_text: t,
        mode: "legacy",
        preferred_locale: "en",
        target_locale: "th-TH",
        ui_fast: false,
        end_session: false,
        e2e_marker,
      },
    });
  }

  // 2) End session (this should upsert memory_summary + write fact_candidates when enabled)
  const endResp = await callAiBrain({
    access_token,
    payload: {
      user_id,
      conversation_id,
      message_text: "Okay, that's all for today.",
      mode: "legacy",
      preferred_locale: "en",
      target_locale: "th-TH",
      ui_fast: false,
      end_session: true,
      e2e_marker,
    },
  });

  console.log("End-session response keys:", Object.keys(endResp ?? {}));

  // Optional: surface any facts-related hints in the response payload for debugging
  try {
    const es = endResp?.end_session_summary ?? null;
    if (es && typeof es === "object") {
      const summaryKeys = Object.keys(es);
      console.log("end_session_summary keys:", summaryKeys);
      // Print a few known potential fields without assuming schema
      for (const k of ["memory_summary_id", "raw_id", "facts", "facts_review", "facts_count", "kept", "total"]) {
        if (k in es) console.log(`end_session_summary.${k}:`, es[k]);
      }
    }
  } catch {}
  
  // 3) Poll memory_summary
  const summary = await poll(
    async () => {
      const q = qs({
        select: "id,user_id,conversation_id,raw_id,short_summary,created_at",
        user_id: `eq.${user_id}`,
        conversation_id: `eq.${conversation_id}`,
        order: "created_at.desc",
        limit: "1",
      });
      const rows = await restSelectService(`/rest/v1/memory_summary?${q}`);
      if (Array.isArray(rows) && rows.length > 0) return rows[0];
      return null;
    },
    { label: "memory_summary row", maxTries: POLL_MAX_TRIES, sleepMs: POLL_MS },
  );

  assert.ok(summary?.id, "memory_summary row missing id");
  assert.equal(summary.user_id, user_id, "memory_summary.user_id mismatch");
  assert.equal(summary.conversation_id, conversation_id, "memory_summary.conversation_id mismatch");
  assert.ok(summary.raw_id, "memory_summary.raw_id is null/empty (violates expected NOT NULL)");
  assert.ok(
    typeof summary.short_summary === "string" && summary.short_summary.trim().length > 0,
    "memory_summary.short_summary is empty",
  );

  // 4) Verify raw_id exists in memory_raw and belongs to conversation
  const rawRow = await poll(
    async () => {
      const q = qs({
        select: "id,user_id,conversation_id,created_at,role,source",
        id: `eq.${summary.raw_id}`,
        limit: "1",
      });
      const rows = await restSelectService(`/rest/v1/memory_raw?${q}`);
      if (Array.isArray(rows) && rows.length > 0) return rows[0];
      return null;
    },
    { label: "memory_raw for summary.raw_id", maxTries: POLL_MAX_TRIES, sleepMs: POLL_MS },
  );

   assert.equal(rawRow.id, summary.raw_id, "memory_raw.id mismatch");
   assert.equal(rawRow.user_id, user_id, "memory_raw.user_id mismatch");
   assert.equal(rawRow.conversation_id, conversation_id, "memory_raw.conversation_id mismatch");
 
  // 4b) Mark E2E rows as test data for easy cleanup
  // Non-fatal if columns don't exist yet (e.g., before the migration is applied).
  async function markTestRows() {
    const q = qs({ conversation_id: `eq.${conversation_id}` });
    const patch = { is_test: true, test_run_id: e2e_marker };
    try {
      await restPatchService(`/rest/v1/memory_summary?${q}`, patch);
    } catch (e) {
      console.warn("WARN: could not mark memory_summary rows as test (non-fatal).", {
        status: e?.status ?? null,
        message: String(e?.message ?? e),
      });
    }
    try {
      await restPatchService(`/rest/v1/memory_raw?${q}`, patch);
    } catch (e) {
      console.warn("WARN: could not mark memory_raw rows as test (non-fatal).", {
        status: e?.status ?? null,
        message: String(e?.message ?? e),
      });
    }
  }

  await markTestRows();

   // 5) Poll fact candidate table(s).
   // Your codebase has used both "fact_candidates" and "facts_candidates" in different iterations.
   // This E2E probes both and succeeds if either has rows.
   const candidateTables = ["fact_candidates"];
 
   async function tryFetchCandidates(tableName) {
     const q = qs({
       select: "id,user_id,conversation_id,fact_key_guess,source_quote,confidence,extracted_at",
       user_id: `eq.${user_id}`,
       conversation_id: `eq.${conversation_id}`,
       order: "extracted_at.desc",
       limit: "50",
     });
     return await restSelectService(`/rest/v1/${tableName}?${q}`);
   }

  // First: detect which table exists (404 vs not)
  const tableStatus = {};
  for (const t of candidateTables) {
    try {
      await tryFetchCandidates(t);
      tableStatus[t] = "ok";
    } catch (e) {
      tableStatus[t] = (e?.status === 404) ? "missing" : `error:${e?.status ?? "unknown"}`;
    }
  }
  console.log("Candidate table probe:", tableStatus);

  const candidatesResult = await poll(
    async () => {
      for (const t of candidateTables) {
        try {
          const rows = await tryFetchCandidates(t);
          if (Array.isArray(rows) && rows.length > 0) {
            return { table: t, rows };
          }
        } catch {
          // ignore; probe already logged
        }
      }
      return null;
    },
    { label: "fact candidate rows (any table)", maxTries: POLL_MAX_TRIES, sleepMs: POLL_MS },
  ).catch((e) => {
    const msg =
      String(e?.message ?? e) +
      "\n\nDiagnostics:" +
      `\n  - Candidate table probe: ${JSON.stringify(tableStatus)}` +
      "\n\nIf tables exist but stay empty, candidate writes are being gated off." +
      "\nCheck your Supabase Function env flags used in end_session.ts for the write gate, e.g.:" +
      "\n  - END_SESSION_WRITE_FACT_CANDIDATES=true (or your actual flag name)" +
      "\n  - END_SESSION_ENABLE_FACTS_REVIEW=true (if facts review is gated)" +
      "\nAlso confirm eligibility thresholds allow facts extraction for this transcript.";
    const err = new Error(msg);
    err.cause = e;
    throw err;
  });

  const candidates = candidatesResult.rows;
  console.log("Using candidates table:", candidatesResult.table, "rows:", candidates.length);

  assert.ok(Array.isArray(candidates) && candidates.length > 0, "Expected >=1 fact_candidates row");

  // 6) Sanity: at least one candidate should contain one of our known statements
  const joined = candidates.map((c) => String(c.source_quote ?? "")).join("\n---\n");
  const hasBirthday = joined.toLowerCase().includes("august 20");
  const hasChiro = joined.toLowerCase().includes("chiropractor");
  const hasSSA = joined.toLowerCase().includes("audio-visual");
  assert.ok(
    hasBirthday || hasChiro || hasSSA,
    "fact_candidates did not include expected source_quote snippets; extraction may be off",
  );

  console.log("✅ PASS: memory_summary + raw_id integrity + fact_candidates persisted", {
    memory_summary_id: summary.id,
    raw_id: summary.raw_id,
    fact_candidates_count: candidates.length,
  });
}

main().catch((err) => {
  console.error("❌ FAIL:", err?.stack ?? err);
  process.exit(1);
});
