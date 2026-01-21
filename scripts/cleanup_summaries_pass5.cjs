#!/usr/bin/env node
/**
 * cleanup_summaries_pass5.cjs
 *
 * Fix stray mid-sentence capitalized "You" (e.g., "brother and You") across:
 *   - memory_summary.short_summary
 *   - memory_summary.full_summary
 *   - memory_summary.session_insights.short_summary
 *   - memory_summary.session_insights.full_summary
 *
 * Usage:
 *   node scripts/cleanup_summaries_pass5.cjs --dry-run
 *   node scripts/cleanup_summaries_pass5.cjs --commit
 *
 * Env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

function parseArgs() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const commit = args.has('--commit');
  if (!dryRun && !commit) {
    console.error('ERROR: pass either --dry-run or --commit');
    process.exit(1);
  }
  return { mode: dryRun ? 'dry-run' : 'commit' };
}

function normalizeMidSentenceYouCaps(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;

  // Most common: preceding char is lowercase/number or punctuation (comma/semicolon/colon)
  out = out.replace(/([a-z0-9,;:])\s+You\b/g, '$1 you');

  // Common mid-sentence lead-ins (covers: and You, when You, etc.)
  out = out.replace(
    /\b(and|or|with|when|while|that|where|because|if|as|at|to|for|of|in|about|after|before|during|particularly)\s+You\b/g,
    (_m, w) => `${w} you`
  );

  // Noun + You (covers: agency You worked..., etc.)
  out = out.replace(
    /\b(agency|brother|sister|mother|father|friend|boss|girlfriend|wife|husband|company|team)\s+You\b/g,
    (_m, w) => `${w} you`
  );

  return out;
}

function safeJsonParse(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

function updateSessionInsights(sessionInsights) {
  const si = safeJsonParse(sessionInsights);
  if (!si || typeof si !== 'object') return { updated: null, changed: false };

  let changed = false;

  if (typeof si.short_summary === 'string') {
    const next = normalizeMidSentenceYouCaps(si.short_summary);
    if (next !== si.short_summary) {
      si.short_summary = next;
      changed = true;
    }
  }

  if (typeof si.full_summary === 'string') {
    const next = normalizeMidSentenceYouCaps(si.full_summary);
    if (next !== si.full_summary) {
      si.full_summary = next;
      changed = true;
    }
  }

  return { updated: changed ? si : null, changed };
}

async function main() {
  const { mode } = parseArgs();

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const pageSize = 1000;
  let from = 0;

  let scanned = 0;
  let wouldFix = 0;
  let fixed = 0;

  while (true) {
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('memory_summary')
      .select('id, short_summary, full_summary, session_insights, created_at')
      .order('created_at', { ascending: true })
      .range(from, to);

    if (error) {
      console.error('ERROR fetching rows:', error);
      process.exit(1);
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      scanned++;

      const nextShort = normalizeMidSentenceYouCaps(row.short_summary);
      const nextFull = normalizeMidSentenceYouCaps(row.full_summary);
      const { updated: siUpdated, changed: siChanged } = updateSessionInsights(row.session_insights);

      const changed =
        (typeof row.short_summary === 'string' && nextShort !== row.short_summary) ||
        (typeof row.full_summary === 'string' && nextFull !== row.full_summary) ||
        siChanged;

      if (!changed) continue;

      wouldFix++;

      if (mode === 'commit') {
        const patch = {};
        if (typeof row.short_summary === 'string' && nextShort !== row.short_summary) patch.short_summary = nextShort;
        if (typeof row.full_summary === 'string' && nextFull !== row.full_summary) patch.full_summary = nextFull;
        if (siUpdated) patch.session_insights = siUpdated;

        const { error: upErr } = await supabase
          .from('memory_summary')
          .update(patch)
          .eq('id', row.id);

        if (upErr) {
          console.error('ERROR updating row:', row.id, upErr);
          process.exit(1);
        }
        fixed++;
      }
    }

    from += pageSize;
  }

  console.log('DONE');
  console.log({ scanned, wouldFix, fixed, mode });
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
