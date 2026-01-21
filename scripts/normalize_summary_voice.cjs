/* eslint-disable no-console */

const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.argv.includes('--dry-run');
const COMMIT = process.argv.includes('--commit');

if (!DRY_RUN && !COMMIT) {
  console.error('Specify --dry-run or --commit');
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required');
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BATCH_SIZE = 200;

// ---------- helpers ----------
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function collapseWhitespace(text) {
  if (!isNonEmptyString(text)) return '';
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeLeadingYouCapitalization(text) {
  if (!isNonEmptyString(text)) return '';
  return text.replace(/^\s*YOU\b/, 'You').replace(/^\s*you\b/, 'You').trim();
}

function ensureSecondPerson(summary) {
  if (!isNonEmptyString(summary)) return '';

  let s = summary.trim();

  // Remove common meta prefixes
  s = s.replace(/^\s*(User|Assistant|System)\s*:\s*/i, '').trim();

  // Convert “the user / the donor” references first
  s = s.replace(/\bthe user\b/gi, 'You');
  s = s.replace(/\bthe donor\b/gi, 'You');

  // Conservative first-person → second-person swaps
  // (order matters: longer phrases first)
  const reps = [
    [/\bI am\b/g, 'You are'],
    [/\bI was\b/g, 'You were'],
    [/\bI have\b/g, 'You have'],
    [/\bI had\b/g, 'You had'],
    [/\bI'm\b/g, "You're"],
    [/\bI've\b/g, "You've"],
    [/\bI'd\b/g, "You'd"],
    [/\bI'll\b/g, "You'll"],
    // standalone I last (word boundary)
    [/\bI\b/g, 'You'],

    [/\bme\b/g, 'you'],
    [/\bmy\b/g, 'your'],
    [/\bmine\b/g, 'yours'],
    [/\bmyself\b/g, 'yourself'],
  ];

  for (const [re, to] of reps) s = s.replace(re, to);

  // Fix common artifacts
  s = s.replace(/\bYou is\b/g, 'You are');
  s = s.replace(/\bYou has\b/g, 'You have');

  return normalizeLeadingYouCapitalization(collapseWhitespace(s));
}

function stableJsonObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function shouldConsiderText(text) {
  if (!isNonEmptyString(text)) return false;
  // quick precheck — avoids doing work on already-good rows
  return (
    /\bI\b/.test(text) ||
    /\bmy\b/i.test(text) ||
    /\bme\b/i.test(text) ||
    /\bthe user\b/i.test(text) ||
    /^\s*YOU\b/.test(text)
  );
}

function computeShortFromFull(full) {
  const t = collapseWhitespace(full);
  if (!t) return '';
  let cut = t.length > 240 ? t.slice(0, 240) : t;
  const idx = cut.search(/[.!?]\s/);
  if (idx > 40) cut = cut.slice(0, idx + 1);
  if (!/[.!?]$/.test(cut)) cut += '.';
  return cut;
}

// ---------- fetch candidates ----------
// PostgREST cannot parse session_insights::text in filters; instead, filter on jsonb keys via ->>
async function fetchBadPovRows(limit, offset) {
  // We fetch rows likely to contain first-person markers in either:
  // - memory_summary.short_summary / full_summary
  // - session_insights.short_summary / full_summary
  // then we finalize in JS.
  return supabase
    .from('memory_summary')
    .select('id, short_summary, full_summary, session_insights, created_at')
    .or(
      [
        // columns
        'short_summary.ilike.% I %',
        'short_summary.ilike.I %',
        'short_summary.ilike.% my %',
        'short_summary.ilike.% me %',
        'short_summary.ilike.%the user%',
        'short_summary.ilike.YOU %',
        'full_summary.ilike.% I %',
        'full_summary.ilike.I %',
        'full_summary.ilike.% my %',
        'full_summary.ilike.% me %',
        'full_summary.ilike.%the user%',
        'full_summary.ilike.YOU %',

        // jsonb keys
        'session_insights->>short_summary.ilike.% I %',
        'session_insights->>short_summary.ilike.I %',
        'session_insights->>short_summary.ilike.% my %',
        'session_insights->>short_summary.ilike.% me %',
        'session_insights->>short_summary.ilike.%the user%',
        'session_insights->>short_summary.ilike.YOU %',
        'session_insights->>full_summary.ilike.% I %',
        'session_insights->>full_summary.ilike.I %',
        'session_insights->>full_summary.ilike.% my %',
        'session_insights->>full_summary.ilike.% me %',
        'session_insights->>full_summary.ilike.%the user%',
        'session_insights->>full_summary.ilike.YOU %',
      ].join(',')
    )
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);
}

// ---------- main ----------
async function run() {
  let offset = 0;

  let processed = 0;
  let scanned = 0;
  let wouldFix = 0;
  let fixed = 0;

  while (true) {
    const { data: rows, error } = await fetchBadPovRows(BATCH_SIZE, offset);
    if (error) throw error;
    if (!rows || rows.length === 0) break;

    scanned += rows.length;

    for (const row of rows) {
      processed++;

      const si = stableJsonObject(row.session_insights);

      // Authoritative source of truth: session_insights
      const siShortRaw = isNonEmptyString(si.short_summary) ? String(si.short_summary) : '';
      const siFullRaw = isNonEmptyString(si.full_summary) ? String(si.full_summary) : '';

      // Mirror columns exist but are not authoritative
      const colShortRaw = isNonEmptyString(row.short_summary) ? String(row.short_summary) : '';
      const colFullRaw = isNonEmptyString(row.full_summary) ? String(row.full_summary) : '';

      const anyBad =
        shouldConsiderText(siShortRaw) ||
        shouldConsiderText(siFullRaw) ||
        shouldConsiderText(colShortRaw) ||
        shouldConsiderText(colFullRaw);

      if (!anyBad) continue;

      // Normalize authoritative fields first.
      // If session_insights is missing but columns exist, we can backfill into session_insights.
      const baseShort = siShortRaw || colShortRaw;
      const baseFull = siFullRaw || colFullRaw;

      let nextSiShort = ensureSecondPerson(baseShort);
      let nextSiFull = ensureSecondPerson(baseFull);

      // If we have full but no short, derive short (still second-person)
      if (!nextSiShort && nextSiFull) nextSiShort = computeShortFromFull(nextSiFull);

      // If we have short but no full, keep short and leave full empty (don’t invent)
      if (!nextSiFull && nextSiShort) nextSiFull = ensureSecondPerson(nextSiFull);

      // Still nothing meaningful? skip.
      if (!nextSiShort && !nextSiFull) continue;

      // Mirror columns from session_insights authoritative values
      const nextColShort = nextSiShort || '';
      const nextColFull = nextSiFull || '';

      const changed =
        nextSiShort !== (siShortRaw || '') ||
        nextSiFull !== (siFullRaw || '') ||
        nextColShort !== (colShortRaw || '') ||
        nextColFull !== (colFullRaw || '');

      if (!changed) continue;

      wouldFix++;

      console.log(`\nVOICE-FIX ${row.id}`);
      if (siShortRaw !== nextSiShort) console.log(`  si.short: "${siShortRaw}" -> "${nextSiShort}"`);
      if (siFullRaw !== nextSiFull) console.log(`  si.full : "${siFullRaw}" -> "${nextSiFull}"`);
      if (colShortRaw !== nextColShort) console.log(`  col.short: "${colShortRaw}" -> "${nextColShort}"`);
      if (colFullRaw !== nextColFull) console.log(`  col.full : "${colFullRaw}" -> "${nextColFull}"`);

      if (COMMIT) {
        const nextSI = {
          ...si,
          short_summary: nextSiShort || si.short_summary,
          full_summary: nextSiFull || si.full_summary,
          voice_pov: 'second_person',
          voice_normalized_by: 'normalize_summary_voice.cjs',
          voice_normalized_at: new Date().toISOString(),
        };

        const { error: upErr } = await supabase
          .from('memory_summary')
          .update({
            session_insights: nextSI,
            short_summary: nextColShort || row.short_summary,
            full_summary: nextColFull || row.full_summary,
          })
          .eq('id', row.id);

        if (upErr) {
          console.error('UPDATE ERROR:', row.id, upErr);
          continue;
        }

        fixed++;
      }
    }

    offset += rows.length;
  }

  console.log('\nDONE');
  console.log({
    scanned,
    processed,
    wouldFix,
    fixed: COMMIT ? fixed : 0,
    mode: DRY_RUN ? 'dry-run' : 'commit',
  });
}

run().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
