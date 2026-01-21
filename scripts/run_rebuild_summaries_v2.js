#!/usr/bin/env node
/**
 * Local runner for rebuild-summaries-v2 Edge Function.
 *
 * Usage:
 *   node scripts/run_rebuild_summaries_v2.js \
 *     --url https://<project>.functions.supabase.co/rebuild-summaries-v2 \
 *     --anon <ANON_OR_JWT> \
 *     --user_id <uuid> \
 *     --batch 20 \
 *     --dry_run true
 *
 * Notes:
 * - Use a JWT with permission to invoke the function (or your anon key if you allow it).
 * - For safety: start with --dry_run true and --batch 5.
 */
(async () => {

const args = process.argv.slice(2);
function getArg(name, def) {
  const ix = args.indexOf(`--${name}`);
  if (ix === -1) return def;
  return args[ix + 1] ?? def;
}

const url = getArg("url");
const token = getArg("anon") || getArg("token"); // Authorization Bearer
const userId = getArg("user_id", "");
const batchSize = Number(getArg("batch", "20"));
const dryRun = (getArg("dry_run", "false") === "true");
const onlyGarbage = (getArg("only_garbage", "true") === "true");
const force = (getArg("force", "false") === "true");
const rawIdsCsv = getArg("raw_ids", "");
const rawIdsFile = getArg("raw_ids_file", "");
let scopeRawIds = [];
if (rawIdsCsv) {
  scopeRawIds = rawIdsCsv.split(",").map(s => s.trim()).filter(Boolean);
}
if (rawIdsFile) {
  const fs = await import("node:fs");
  const content = fs.readFileSync(rawIdsFile, "utf8");
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // support either raw_id per line or CSV w/ header (raw_id,...) -> take first column
  const parsed = lines
    .filter(l => !/^raw_id\b/i.test(l))
    .map(l => l.split(",")[0].trim())
    .filter(Boolean);
  scopeRawIds = scopeRawIds.concat(parsed);
}
// de-dupe and cap
scopeRawIds = Array.from(new Set(scopeRawIds)).slice(0, 2000);

const maxLoops = Number(getArg("max_loops", "100000"));
const sleepMs = Number(getArg("sleep_ms", "400"));

if (!url) {
  console.error("Missing --url");
  process.exit(1);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let cursor = null;
let totals = { processed: 0, updated: 0, skipped: 0, errors: 0 };
for (let i = 0; i < maxLoops; i++) {
const scope = {
  ...(userId ? { user_id: userId } : {}),
  ...(scopeRawIds.length ? { raw_ids: scopeRawIds } : {}),
};

const body = {
  batch_size: batchSize,
  cursor,
  dry_run: dryRun,
  only_garbage: onlyGarbage,
  force,
  scope,
};

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const txt = await res.text();
  if (!res.ok) {
    console.error("Non-OK:", res.status, txt);
    process.exit(2);
  }

  const json = JSON.parse(txt);
  totals.processed += json.processed || 0;
  totals.updated += json.updated || 0;
  totals.skipped += json.skipped || 0;
  totals.errors += json.errors || 0;

  console.log(
    `batch ${i + 1}: processed=${json.processed} updated=${json.updated} skipped=${json.skipped} errors=${json.errors} done=${json.done}`
  );

  if (Array.isArray(json.samples) && json.samples.length) {
    const s = json.samples[0];
    console.log("sample:", {
      id: s.id,
      user_words: s.user_words,
      short_summary: (s.short_summary || "").slice(0, 120),
      reflections_count: s.reflections_count,
    });
  }

  if (json.done) break;

  cursor = json.cursor_next;
  await sleep(sleepMs);
}

console.log("TOTALS:", totals);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
