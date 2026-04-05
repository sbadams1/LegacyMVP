#!/usr/bin/env node
import assert from "node:assert/strict";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

function parseArgs(argv) {
  const out = { conversation: null, limit: 10, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--conversation" || a === "-c") out.conversation = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--dryRun") out.dryRun = true;
  }
  if (!out.conversation) throw new Error("Missing --conversation <uuid>");
  return out;
}

function safeJsonParse(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  const s = String(v).trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function norm(s) { return String(s ?? "").trim().toLowerCase(); }

function looksLikeTranscript(s) {
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
  if (t === "ok" || t === "n/a" || t === "none") return true;
  return false;
}

function cleanReceiptsArray(arr) {
  if (!Array.isArray(arr)) return [];
  const cleaned = arr
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .filter((x) => !isProceduralPlaceholder(x) && !isGarbageSummary(x) && !looksLikeTranscript(x));
  // de-dupe
  return Array.from(new Set(cleaned));
}

function cleanSnapshot(snap) {
  if (!snap || typeof snap !== "object") return snap;

  const out = { ...snap };

  // receipts_by_label
  if (out.receipts_by_label && typeof out.receipts_by_label === "object" && !Array.isArray(out.receipts_by_label)) {
    const rbl = out.receipts_by_label;
    const cleanedRbl = {};
    for (const k of Object.keys(rbl)) {
      const v = cleanReceiptsArray(rbl[k]);
      if (v.length) cleanedRbl[k] = v.slice(0, 3);
    }
    out.receipts_by_label = cleanedRbl;
  }

  // recurring_tensions receipts
  if (Array.isArray(out.recurring_tensions)) {
    out.recurring_tensions = out.recurring_tensions.map((rt) => {
      const next = { ...rt };
      if (Array.isArray(next.receipts)) next.receipts = cleanReceiptsArray(next.receipts).slice(0, 3);
      return next;
    });
  }

  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing env SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data: rows, error } = await supabase
    .from("memory_summary")
    .select("id, observations, updated_at")
    .eq("conversation_id", args.conversation)
    .order("updated_at", { ascending: false })
    .limit(args.limit);

  if (error) throw error;
  assert(rows && rows.length > 0, `No memory_summary rows found for conversation_id=${args.conversation}`);

  let changedCount = 0;

  for (const row of rows) {
    const obs = safeJsonParse(row.observations) ?? {};
    const snap = obs.longitudinal_snapshot ?? null;

    const before = JSON.stringify(snap ?? {});
    const cleanedSnap = cleanSnapshot(snap);
    const after = JSON.stringify(cleanedSnap ?? {});

    if (before !== after) {
      changedCount++;
      if (args.dryRun) {
        console.log(`DRY RUN would update row ${row.id}`);
      } else {
        const nextObs = { ...obs, longitudinal_snapshot: cleanedSnap };
        const { error: upErr } = await supabase
          .from("memory_summary")
          .update({ observations: nextObs, updated_at: new Date().toISOString() })
          .eq("id", row.id);
        if (upErr) throw upErr;
        console.log(`✅ Updated row ${row.id}`);
      }
    }
  }

  console.log(`Done. Rows changed: ${changedCount}${args.dryRun ? " (dry run)" : ""}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
