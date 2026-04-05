#!/usr/bin/env node
/**
 * E2E Memory Summary Effectiveness Test
 *
 * Usage:
 *   node tools/e2e_memory_summary_effectiveness_test.mjs --conversation <uuid> [--expect "text"]... [--minLen 80]
 *
 * Requires:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Notes:
 * - This is a post-session audit test: it reads memory_summary rows and verifies quality.
 * - It avoids coupling to your edge-function request schema.
 */

import assert from "node:assert/strict";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

function parseArgs(argv) {
  const args = {
    conversation: null,
    expect: [],
    expectFactKeys: [],
    minLen: 80,
    failOnWarnings: false,
    limit: 3,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--conversation" || a === "-c") args.conversation = argv[++i];
    else if (a === "--expect") args.expect.push(argv[++i]);
    else if (a === "--expectFactKey") args.expectFactKeys.push(argv[++i]);
    else if (a === "--expectFactKeys") {
      const raw = argv[++i];
      const parts = String(raw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      args.expectFactKeys.push(...parts);
    }
    else if (a === "--minLen") args.minLen = Number(argv[++i]);
    else if (a === "--failOnWarnings") args.failOnWarnings = true;
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(`
E2E Memory Summary Effectiveness Test

Required:
  --conversation <uuid>   Conversation ID to validate

Optional:
  --expect "text"         Require substring to appear in short_summary or reframed.short_summary
                          (repeatable)
  --expectFactKey <key>   Require that the summary output includes at least one token from the value of a
                          fact in session_insights.facts_review.items with this exact fact_key (repeatable)
  --expectFactKeys "a,b"  Comma-separated convenience form for --expectFactKey
                          --minLen <n>            Minimum length for short_summary usefulness (default: 80)
  --failOnWarnings        Treat warnings as failures (default: false)
  --limit <n>             How many latest rows to inspect (default: 3)

Env:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
`.trim());
      process.exit(0);
    }
  }

  if (!args.conversation) throw new Error("Missing --conversation <uuid>");
  if (!Number.isFinite(args.minLen) || args.minLen < 0) throw new Error("--minLen must be a non-negative number");
  if (!Number.isFinite(args.limit) || args.limit < 1) throw new Error("--limit must be >= 1");
  return args;
}

function safeJsonParse(maybeJson) {
  if (maybeJson == null) return null;
  if (typeof maybeJson === "object") return maybeJson; // already parsed
  const s = String(maybeJson).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function norm(s) {
  return String(s ?? "").trim().toLowerCase();
}

function looksLikeTranscript(s) {
  // crude heuristic: lots of role markers or table-like formatting
  const t = norm(s);
  if (!t) return false;
  if (t.includes("| created_at") && t.includes("| role")) return true;
  if (t.includes("role:") && t.includes("content:")) return true;
  return false;
}

function isProceduralPlaceholder(s) {
  const t = norm(s);
  if (!t) return true;
  const needles = [
    "checked in briefly",
    "brief check-in",
    "brief check in",
    "opened the app",
    "did not record a detailed story",
    "no detailed story",
    "no story in this session",
    "no summary was captured",
    "presence check",
  ];
  return needles.some((n) => t.includes(n));
}

function isGarbageSummary(s) {
  const t = norm(s);
  if (!t) return true;
  if (looksLikeTranscript(t)) return true;
  if (isProceduralPlaceholder(t)) return true;
  // “assistant style” filler that isn't informative
  if (t === "ok" || t === "n/a" || t === "none") return true;
  return false;
}

function extractReceiptsByLabel(observations) {
  const obs = safeJsonParse(observations) ?? {};
  const snap = obs.longitudinal_snapshot ?? {};
  const rbl = snap.receipts_by_label ?? {};
  if (rbl && typeof rbl === "object") return rbl;
  return {};
}

function flattenReceipts(receiptsByLabel) {
  const out = [];
  for (const k of Object.keys(receiptsByLabel)) {
    const arr = receiptsByLabel[k];
    if (Array.isArray(arr)) {
      for (const v of arr) out.push(String(v ?? "").trim());
    }
  }
  return out.filter(Boolean);
}

function pickBestShortText(row) {
  // Prefer reframed.short_summary if present, else memory_summary.short_summary
  const si = safeJsonParse(row.session_insights) ?? {};
  const reframed = si.reframed ?? {};
  const a = String(reframed.short_summary ?? "").trim();
  if (a) return { text: a, from: "session_insights.reframed.short_summary" };

  const b = String(row.short_summary ?? "").trim();
  if (b) return { text: b, from: "memory_summary.short_summary" };

  return { text: "", from: "none" };
}

function buildDisplayHay(bestText, row, si) {
  const parts = [
    String(bestText ?? "").trim(),
    String(row?.short_summary ?? "").trim(),
    String(si?.reframed?.short_summary ?? "").trim(),
    String(si?.reframed?.full_summary ?? "").trim(),
    String(si?.full_summary ?? "").trim(),
  ].filter(Boolean);
  return parts.join("\n");
}

function tokenizeValue(v) {
  if (v == null) return [];
  if (typeof v === "number" || typeof v === "boolean") return [String(v)];
  const s = String(v).replace(/^"+|"+$/g, "").trim();
  if (!s) return [];
  const raw = s.split(/[\s,;:()\[\]{}"“”'’]+/g).map((t) => t.trim()).filter(Boolean);
  const stop = new Set([
    "the","a","an","and","or","of","to","in","on","for","with","as","at","by","from",
    "user","their","they","them","he","she","his","her","parents","details",
    "true","false",
  ]);
  return raw
    .map((t) => t.replace(/^[^\w]+|[^\w]+$/g, ""))
    .filter((t) => t && !stop.has(t.toLowerCase()))
    .filter((t) => /\d/.test(t) ? t.length >= 2 : t.length >= 3);
}

function extractFactTokensByKey(si, factKey) {
  const fr = si?.facts_review ?? si?.factsReview ?? null;
  const items = fr && Array.isArray(fr.items) ? fr.items : [];
  const it = items.find((x) => x && String(x.fact_key ?? "") === String(factKey));
  if (!it) return [];
  const tokens = [
    ...tokenizeValue(it.value_json),
    ...tokenizeValue(it.receipt_quote),
  ];
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}

function warnOrFail(warnings, args) {
  if (!warnings.length) return;
  const msg = warnings.map((w) => `- ${w}`).join("\n");
  if (args.failOnWarnings) {
    throw new Error(`WARNINGS (treated as failures):\n${msg}`);
  } else {
    console.warn(`WARNINGS:\n${msg}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing env SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY");
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false },
  });

  // Pull the newest memory_summary rows for this conversation (in case you upsert repeatedly)
  const { data: rows, error } = await supabase
    .from("memory_summary")
    .select("id, conversation_id, raw_id, short_summary, observations, session_insights, created_at, updated_at")
    .eq("conversation_id", args.conversation)
    .order("updated_at", { ascending: false })
    .limit(args.limit);

  if (error) throw error;
  assert(rows && rows.length > 0, `No memory_summary rows found for conversation_id=${args.conversation}`);

  // Evaluate the most recent row as primary
  const row = rows[0];

  const warnings = [];

  // 1) Short summary must exist and not be garbage
  const best = pickBestShortText(row);

// === DIAGNOSTIC LOGS (temporary) ===
console.log("=== MEMORY SUMMARY DIAGNOSTIC ===");
console.log("Row ID:", row.id);
console.log("Conversation ID:", row.conversation_id);

console.log("memory_summary.short_summary:");
console.log(String(row.short_summary ?? "<null>"));

const si = safeJsonParse(row.session_insights) ?? {};
console.log("session_insights.reframed.short_summary:");
console.log(String(si?.reframed?.short_summary ?? "<null>"));

console.log("Selected by pickBestShortText():", best.from);
console.log("Selected summary text:");
console.log(best.text);
console.log("=== END DIAGNOSTIC ===");
// === END DIAGNOSTIC LOGS ===

  assert(best.text, `Missing short summary (checked ${best.from})`);
  assert(!isGarbageSummary(best.text), `Short summary is garbage/procedural (from ${best.from}): "${best.text}"`);

  if (best.text.length < args.minLen) {
    warnings.push(`short summary length (${best.text.length}) < --minLen (${args.minLen})`);
  }

  // 2) Receipts must not contain procedural placeholders
  const rbl = extractReceiptsByLabel(row.observations);
  const receipts = flattenReceipts(rbl);

  const badReceipts = receipts.filter((r) => isProceduralPlaceholder(r) || isGarbageSummary(r));
  if (badReceipts.length > 0) {
    throw new Error(
      `Found ${badReceipts.length} polluted receipts (procedural/garbage). Example:\n` +
        badReceipts.slice(0, 5).map((x) => `  - ${x}`).join("\n")
    );
  }

  // 3) Optional “expected substrings” check
  for (const exp of args.expect) {
    const needle = String(exp ?? "").trim();
    if (!needle) continue;
    const si = safeJsonParse(row.session_insights) ?? {};
    const hay = buildDisplayHay(best.text, row, si);
    assert(
      hay.toLowerCase().includes(needle.toLowerCase()),
      `Expected to find "${needle}" in summary output, but did not.`
    );
  }

  // 4) Optional “expected fact keys/tokens” check (general, avoids hardcoded literals)
  if (args.expectFactKeys && args.expectFactKeys.length) {
    const si = safeJsonParse(row.session_insights) ?? {};
    const hay = buildDisplayHay(best.text, row, si).toLowerCase();

    for (const fkRaw of args.expectFactKeys) {
      const fk = String(fkRaw ?? "").trim();
      if (!fk) continue;
      const tokens = extractFactTokensByKey(si, fk);
      assert(tokens.length > 0, `No facts_review item found for fact_key="${fk}" (cannot validate tokens).`);
      const ok = tokens.some((t) => hay.includes(String(t).toLowerCase()));
      assert(
        ok,
        `Expected summary output to include at least one token from fact_key="${fk}", but none were found. Tokens tried: ${tokens.join(", ")}`
      );
    }
  }

  warnOrFail(warnings, args);

  console.log("✅ PASS memory_summary effectiveness");
  console.log(`Row id: ${row.id}`);
  console.log(`Short summary source: ${best.from}`);
  console.log(`Short summary: ${best.text}`);
  console.log(`Receipts checked: ${receipts.length}`);
}

main().catch((err) => {
  console.error("❌ FAIL memory_summary effectiveness");
  console.error(err?.stack || String(err));
  process.exit(1);
});
