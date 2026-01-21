/* eslint-disable no-console */

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const DRY_RUN = process.argv.includes('--dry-run');
const COMMIT = process.argv.includes('--commit');

if (!DRY_RUN && !COMMIT) {
  console.error('Specify --dry-run or --commit');
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required');
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const BATCH_SIZE = 25;

// Tune these as you like
const MIN_MEANINGFUL_WORDS = 80; // prevents junk repairs
const MIN_USER_TURNS = 2;

// --- Helpers ---

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function stripMarkdownFences(text) {
  if (!isNonEmptyString(text)) return '';
  // Remove ```json ... ``` or ``` ... ```
  return text
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
}

function stripBoilerplate(text) {
  if (!isNonEmptyString(text)) return '';
  return text
    .replace(/hey.*are you there\??/gi, '')
    .replace(/play gemini/gi, '')
    .replace(/\b(i'?m\s+here\.?)\b/gi, '')
    .trim();
}

function wordCount(text) {
  if (!isNonEmptyString(text)) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function countUserTurnsFromNormalized(normalizedTranscript) {
  if (!isNonEmptyString(normalizedTranscript)) return 0;
  // Count common user markers across your formats
  const m1 = normalizedTranscript.match(/^\s*(user|legacy_user)\s*:/gim) || [];
  const m2 = normalizedTranscript.match(/"role"\s*:\s*"user"/gim) || [];
  return Math.max(m1.length, m2.length);
}

function normalizeTranscript(raw) {
  // Handles:
  // - string transcript
  // - array of turns [{role, content}, ...] or [{role, source, content}, ...]
  // - object with turns/messages arrays
  if (raw == null) return '';

  if (typeof raw === 'string') return raw.trim();

  // Some Supabase drivers return jsonb already parsed (object/array)
  if (Array.isArray(raw)) {
    const lines = raw
      .map((t) => {
        if (!t) return '';
        const role = t.role || t.source || 'unknown';
        const content = t.content || t.text || t.message || '';
        if (!isNonEmptyString(content)) return '';
        return `${String(role)}: ${String(content).trim()}`;
      })
      .filter(Boolean);
    return lines.join('\n').trim();
  }

  if (typeof raw === 'object') {
    const turns =
      (Array.isArray(raw.turns) && raw.turns) ||
      (Array.isArray(raw.messages) && raw.messages) ||
      (Array.isArray(raw.items) && raw.items) ||
      null;

    if (turns) return normalizeTranscript(turns);

    // Fallback: try common fields
    if (isNonEmptyString(raw.transcript)) return raw.transcript.trim();
    if (isNonEmptyString(raw.content)) return raw.content.trim();
    return JSON.stringify(raw);
  }

  return String(raw);
}

function looksLikeJsonObject(text) {
  if (!isNonEmptyString(text)) return false;
  const t = text.trim();
  return t.startsWith('{') && t.endsWith('}');
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collapseWhitespace(text) {
  if (!isNonEmptyString(text)) return '';
  return text.replace(/\s+/g, ' ').trim();
}

function makeShortFromFull(full) {
  const t = collapseWhitespace(full);
  if (!t) return '';
  // First sentence-ish up to ~240 chars, end with punctuation.
  let cut = t;
  if (cut.length > 240) cut = cut.slice(0, 240);
  const idx = cut.search(/[.!?]\s/);
  if (idx > 40) cut = cut.slice(0, idx + 1);
  if (!/[.!?]$/.test(cut)) cut += '.';
  return cut;
}

function normalizeLeadingYouCapitalization(text) {
  if (!isNonEmptyString(text)) return '';
  return text.replace(/^\s*YOU\b/, 'You').replace(/^\s*you\b/, 'You').trim();
}

function ensureSecondPerson(summary) {
  if (!isNonEmptyString(summary)) return '';

  let s = summary.trim();

  // Remove common meta prefixes that sometimes leak into old rows
  s = s.replace(/^\s*(User|Assistant|System)\s*:\s*/i, '').trim();

  // Convert “the user / the donor” references first
  s = s.replace(/\bthe user\b/gi, 'You');
  s = s.replace(/\bthe donor\b/gi, 'You');

  // Light first-person → second-person normalization (best-effort)
  // NOTE: This is intentionally conservative (word-boundaries) to avoid mangling.
  const reps = [
    [/\bI am\b/g, 'You are'],
    [/\bI was\b/g, 'You were'],
    [/\bI have\b/g, 'You have'],
    [/\bI had\b/g, 'You had'],
    [/\bI\b/g, 'You'],
    [/\bI'm\b/g, "You're"],
    [/\bI've\b/g, "You've"],
    [/\bI'd\b/g, "You'd"],
    [/\bI'll\b/g, "You'll"],
    [/\bme\b/g, 'you'],
    [/\bmy\b/g, 'your'],
    [/\bmine\b/g, 'yours'],
    [/\bmyself\b/g, 'yourself'],
  ];

  for (const [re, to] of reps) s = s.replace(re, to);

  // Fix a couple common grammar artifacts post-conversion
  s = s.replace(/\bYou is\b/g, 'You are');
  s = s.replace(/\bYou has\b/g, 'You have');

  return normalizeLeadingYouCapitalization(collapseWhitespace(s));
}

// --- Supabase fetches ---

async function fetchCandidateRows(limit, offset) {
  // NOTE:
  // 1) We exclude rows already marked as skip (to prevent infinite reprocessing).
  // 2) We still include polluted short_summary patterns + missing session_insights keys.
  return supabase
    .from('memory_summary')
    .select('id, raw_id, conversation_id, short_summary, full_summary, session_insights')
    .neq('session_insights->>summary_quality', 'skip')
    .or(
      [
        // classic garbage
        'short_summary.ilike.%checked in briefly%',
        'short_summary.ilike.%opened the app%',

        // meta/JSON pollution
        'short_summary.ilike.%```%',
        'short_summary.ilike.%\"short_summary\"%',
        'short_summary.ilike.%{\"short_summary\"%',
        'short_summary.ilike.%json%',
        'short_summary.ilike.%{\"full_summary\"%',

        // missing jsonb keys (keeps your “source of truth” goal),
        // BUT we will now write a skip marker so they don’t loop forever.
        'session_insights.is.null',
        'session_insights->>short_summary.is.null',
        'session_insights->>full_summary.is.null',
      ].join(',')
    )
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);
}

async function fetchTranscriptForRawId(rawId) {
  const { data, error } = await supabase
    .from('memory_raw')
    .select('id, transcript, content')
    .eq('id', rawId)
    .maybeSingle();

  if (error) return { raw: null, error };

  // Prefer transcript, else content
  const raw = data?.transcript ?? data?.content ?? null;
  return { raw, error: null };
}

// --- OpenAI summarization ---

async function summarizeToJsonSecondPerson(normalizedTranscript) {
  // Hard force JSON, no markdown, and SECOND PERSON.
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: [
          'You are repairing historical session summaries for a personal legacy app.',
          'Rules:',
          '- Summaries MUST be in second person (use "You", "your").',
          '- Never use first person ("I", "my") and never say "the user".',
          '- Summarize only what was actually said. No advice, no coaching, no interpretation.',
          '- Do NOT output markdown or code fences.',
          '- Output STRICT JSON ONLY with keys: short_summary, full_summary, summary_quality.',
          '- summary_quality must be one of: "ok", "thin", "skip".',
        ].join('\n'),
      },
      {
        role: 'user',
        content:
          `Create a repaired summary for this session.\n\n` +
          `TRANSCRIPT:\n${normalizedTranscript}`,
      },
    ],
    response_format: { type: 'json_object' },
  });

  const raw = response.choices?.[0]?.message?.content ?? '';
  const cleaned = stripMarkdownFences(raw);

  const json = looksLikeJsonObject(cleaned) ? safeJsonParse(cleaned) : null;
  if (!json) return null;

  const fullRaw = stripMarkdownFences(String(json.full_summary ?? '')).trim();
  const shortRaw = stripMarkdownFences(String(json.short_summary ?? '')).trim();
  const qualityRaw = String(json.summary_quality ?? 'ok').toLowerCase().trim();

  let summary_quality = 'ok';
  if (qualityRaw === 'thin' || qualityRaw === 'skip' || qualityRaw === 'ok') summary_quality = qualityRaw;

  const full_summary = ensureSecondPerson(fullRaw);
  const short_summary = ensureSecondPerson(shortRaw) || makeShortFromFull(full_summary);

  if (!full_summary && !short_summary) return null;

  return { short_summary, full_summary, summary_quality };
}

// --- Run ---

async function run() {
  let offset = 0;
  let processed = 0;
  let wouldRepair = 0;
  let repaired = 0;
  let markedSkip = 0;

  while (true) {
    const { data: rows, error } = await fetchCandidateRows(BATCH_SIZE, offset);
    if (error) throw error;
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      processed++;

      const { raw, error: rawErr } = await fetchTranscriptForRawId(row.raw_id);
      if (rawErr || raw == null) continue;

      const normalized = normalizeTranscript(raw);
      const cleaned = stripBoilerplate(stripMarkdownFences(normalized));
      const userTurns = countUserTurnsFromNormalized(normalized);
      const wc = wordCount(cleaned);

      // ✅ Skip gate (and now we MARK skip so these rows don't re-queue forever)
      if (wc < MIN_MEANINGFUL_WORDS && userTurns < MIN_USER_TURNS) {
        console.log(`SKIP (too short): ${row.id} (userTurns=${userTurns}, words=${wc})`);

        if (COMMIT) {
          const existingSI =
            (row.session_insights && typeof row.session_insights === 'object' && row.session_insights) || {};

          const nextSI = {
            ...existingSI,
            summary_quality: 'skip',
            skip_reason: 'too_thin',
            min_meaningful_words: MIN_MEANINGFUL_WORDS,
            min_user_turns: MIN_USER_TURNS,
            repaired_by: 'backfill_summaries_pass1.cjs',
            repaired_at: new Date().toISOString(),
          };

          const { error: upErr } = await supabase
            .from('memory_summary')
            .update({ session_insights: nextSI })
            .eq('id', row.id);

          if (upErr) {
            console.error('UPDATE ERROR (skip marker):', row.id, upErr);
          } else {
            markedSkip++;
          }
        }

        continue;
      }

      const repairedJson = await summarizeToJsonSecondPerson(cleaned);
      if (!repairedJson) continue;

      // If still polluted, don’t write
      const bad =
        repairedJson.short_summary.includes('```') ||
        repairedJson.short_summary.includes('"short_summary"') ||
        repairedJson.short_summary.trim().startsWith('{') ||
        /\bthe user\b/i.test(repairedJson.short_summary) ||
        /\bI\b/.test(repairedJson.short_summary) ||
        /\bmy\b/i.test(repairedJson.short_summary);

      if (bad) {
        console.log(`SKIP (meta/voice detected from model): ${row.id}`);
        continue;
      }

      wouldRepair++;

      console.log(`\nREPAIR ${row.id}`);
      console.log(`→ short: ${repairedJson.short_summary}`);

      if (COMMIT) {
        const existingSI =
          (row.session_insights && typeof row.session_insights === 'object' && row.session_insights) || {};

        const nextSI = {
          ...existingSI,
          short_summary: repairedJson.short_summary,
          full_summary: repairedJson.full_summary,
          summary_quality: repairedJson.summary_quality,
          repaired_by: 'backfill_summaries_pass1.cjs',
          repaired_at: new Date().toISOString(),
        };

        const { error: upErr } = await supabase
          .from('memory_summary')
          .update({
            short_summary: repairedJson.short_summary,
            full_summary: repairedJson.full_summary,
            session_insights: nextSI,
          })
          .eq('id', row.id);

        if (upErr) {
          console.error('UPDATE ERROR:', row.id, upErr);
          continue;
        }

        repaired++;
      }
    }

    offset += rows.length;
  }

  console.log('\nDONE');
  console.log({
    processed,
    wouldRepair,
    repaired: COMMIT ? repaired : 0,
    markedSkip: COMMIT ? markedSkip : 0,
    mode: DRY_RUN ? 'dry-run' : 'commit',
  });
}

run().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
