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

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function stableJsonObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function collapseWhitespace(text) {
  if (!isNonEmptyString(text)) return '';
  return text.replace(/\s+/g, ' ').trim();
}

function stripMarkdownFences(text) {
  if (!isNonEmptyString(text)) return '';
  return text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
}

function looksLikeJsonObjectString(text) {
  if (!isNonEmptyString(text)) return false;
  const t = text.trim();
  return t.startsWith('{') && t.endsWith('}') && (t.includes('"short_summary"') || t.includes('"full_summary"'));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractIfStringifiedJson(summaryText) {
  const cleaned = stripMarkdownFences(summaryText || '');
  if (!looksLikeJsonObjectString(cleaned)) return null;

  const obj = safeJsonParse(cleaned);
  if (!obj || typeof obj !== 'object') return null;

  const short_summary = isNonEmptyString(obj.short_summary) ? String(obj.short_summary) : '';
  const full_summary = isNonEmptyString(obj.full_summary) ? String(obj.full_summary) : '';

  if (!short_summary && !full_summary) return null;
  return { short_summary, full_summary };
}

function normalizeLeadingYou(text) {
  if (!isNonEmptyString(text)) return '';
  return text.replace(/^\s*YOU\b/, 'You').replace(/^\s*you\b/, 'You').trim();
}

/**
 * Convert sentences starting with "They ..." to "You ..."
 * (second-person summaries should not have "They" as narrator subject)
 */
function banTheyAsSubject(text) {
  if (!isNonEmptyString(text)) return '';
  let s = text;

  s = s.replace(/^\s*They\b/g, 'You');
  s = s.replace(/([.!?]\s+)They\b/g, '$1You');

  return s;
}

function fixYouVerbAgreement(text) {
  if (!isNonEmptyString(text)) return '';
  let s = text;

  // "You are ... and wants/has/is ..." coordination
  s = s.replace(/\bYou are\b([^.!?]*)\band wants\b/gi, (m, between) => `You are${between}and want`);
  s = s.replace(/\bYou are\b([^.!?]*)\band has\b/gi, (m, between) => `You are${between}and have`);
  s = s.replace(/\bYou are\b([^.!?]*)\band is\b/gi, (m, between) => `You are${between}and are`);
  s = s.replace(/\bYou have\b([^.!?]*)\band has\b/gi, (m, between) => `You have${between}and have`);

  // Core "You + verb-s" mistakes
  const fixes = [
    ['feels', 'feel'],
    ['finds', 'find'],
    ['prefers', 'prefer'],
    ['wants', 'want'],
    ['has', 'have'],
    ['is', 'are'],
    ['discusses', 'discuss'],
    ['reflects', 'reflect'],
    ['expresses', 'express'],
    ['describes', 'describe'],
    ['shares', 'share'],
    ['recounts', 'recount'],
    ['recalls', 'recall'],
    ['questions', 'question'],
    ['greets', 'greet'],
    ['mentions', 'mention'],
    ['notes', 'note'],
    ['acknowledges', 'acknowledge'],
    ['emphasizes', 'emphasize'],
    ['highlights', 'highlight'],
    ['states', 'state'],
    ['reports', 'report'],
    ['continues', 'continue'],
    ['contrasts', 'contrast'],
    ['revisits', 'revisit'],
    ['checks', 'check'],
    ['aims', 'aim'],
    ['struggles', 'struggle'],
    ['grapples', 'grapple'],
    ['likens', 'liken'],
  ];

  for (const [bad, good] of fixes) {
    const re = new RegExp(`\\bYou\\s+${bad}\\b`, 'gi');
    s = s.replace(re, `You ${good}`);
  }

  // "When you was" / "You was"
  s = s.replace(/\bWhen you was\b/gi, 'When you were');
  s = s.replace(/\bYou was\b/gi, 'You were');

  return s;
}

/**
 * Lowercase "You" when it's clearly mid-sentence after punctuation/word char.
 * We keep start-of-sentence "You" intact.
 */
function normalizeMidSentenceYouCaps(text) {
  if (!isNonEmptyString(text)) return '';
  let s = text;

  // After a comma/semicolon/colon and space, "You" usually should be "you"
  s = s.replace(/([,;:])\s+You\b/g, '$1 you');

  // After a lowercase letter/number (mid-sentence)
  s = s.replace(/([a-z0-9])\s+You\b/g, '$1 you');

  return s;
}

/**
 * Sentence-level pronoun normalization:
 * If a sentence is narrated as "You ..." (or "When you ..." / "This morning, you ..."),
 * then within that same sentence, convert they/their/them/themselves → you/your/you/yourself.
 *
 * This is what fixes the remaining rows you pasted.
 */

function fixSecondPersonConjunctionAgreement(text) {
  // Fix dropped-subject clauses like: "You went ... and was ..." or "..., but is ..."
  const sentenceSplit = /(?<=[.!?])\s+/;
  const sentences = text.split(sentenceSplit);

  const fixed = sentences.map((s) => {
    if (!/\bYou\b/i.test(s)) return s;

    return s
      .replace(/\b(and|but)\s+is\b/gi, (_, conj) => `${conj} are`)
      .replace(/\b(and|but)\s+was\b/gi, (_, conj) => `${conj} were`)
      .replace(/\b(and|but)\s+has\b/gi, (_, conj) => `${conj} have`);
  });

  return fixed.join(' ');
}

function normalizeSecondPersonPronounsBySentence(text) {
  if (!isNonEmptyString(text)) return '';
  const raw = text;

  // split on sentence boundaries while keeping punctuation in the sentence
  const parts = raw.split(/(?<=[.!?])\s+/);

  const out = parts.map((sentence) => {
    let s = sentence;

    const trimmed = s.trimStart();

    const isSecondPersonSentence =
      /^You\b/i.test(trimmed) ||
      /^When you\b/i.test(trimmed) ||
      /^This morning,\s*you\b/i.test(trimmed) ||
      /^Today,\s*you\b/i.test(trimmed) ||
      /^Recently,\s*you\b/i.test(trimmed);

    if (!isSecondPersonSentence) return s;

    // pronouns
    s = s.replace(/\bthey\b/gi, 'you');
    s = s.replace(/\btheir\b/gi, 'your');
    s = s.replace(/\bthem\b/gi, 'you');
    
s = s.replace(/\bthemselves\b/gi, 'yourself');

    // fix occasional third-person possessives that leaked into a second-person sentence
    // (kept intentionally narrow to avoid rewriting cases like "your friend and his girlfriend")
    s = s
      .replace(/\bhis mother\b/gi, 'your mother')
      .replace(/\bher mother\b/gi, 'your mother')
      .replace(/\bhis father\b/gi, 'your father')
      .replace(/\bher father\b/gi, 'your father')
      .replace(/\bhis parents\b/gi, 'your parents')
      .replace(/\bher parents\b/gi, 'your parents')
      .replace(/\bhis ex[- ]wife\b/gi, 'your ex-wife')
      .replace(/\bher ex[- ]wife\b/gi, 'your ex-wife')
      .replace(/\bhis ex[- ]husband\b/gi, 'your ex-husband')
      .replace(/\bher ex[- ]husband\b/gi, 'your ex-husband')
      .replace(/\bhis divorce\b/gi, 'your divorce')
      .replace(/\bher divorce\b/gi, 'your divorce')
      .replace(/\bhis life\b/gi, 'your life')
      .replace(/\bher life\b/gi, 'your life');


    // fix "you've" and "you're" capitalization if it became weird
    s = s.replace(/\bYou\'re\b/g, "You're");
    s = s.replace(/\bYou\'ve\b/g, "You've");

    return s;
  });

  return out.join(' ');
}

function ensureSecondPerson(summary) {
  if (!isNonEmptyString(summary)) return '';

  let s = stripMarkdownFences(summary).trim();

  // strip leaked prefixes like "User: ..."
  s = s.replace(/^\s*(User|Assistant|System)\s*:\s*/i, '').trim();

  // “the user/donor” -> You
  s = s.replace(/\bthe user\b/gi, 'You');
  s = s.replace(/\bthe donor\b/gi, 'You');

  // first-person -> second-person (case-insensitive)
  const reps = [
    [/\bI am\b/gi, 'You are'],
    [/\bI was\b/gi, 'You were'],
    [/\bI have\b/gi, 'You have'],
    [/\bI had\b/gi, 'You had'],

    [/\bI'm\b/gi, "You're"],
    [/\bI’m\b/gi, "You're"],

    [/\bI've\b/gi, "You've"],
    [/\bI’ve\b/gi, "You've"],

    [/\bI'd\b/gi, "You'd"],
    [/\bI’d\b/gi, "You'd"],

    [/\bI'll\b/gi, "You'll"],
    [/\bI’ll\b/gi, "You'll"],

    [/\bI\b/gi, 'You'],
    [/\bme\b/gi, 'you'],
    [/\bmy\b/gi, 'your'],
    [/\bmine\b/gi, 'yours'],
    [/\bmyself\b/gi, 'yourself'],
  ];
  for (const [re, to] of reps) s = s.replace(re, to);

  s = collapseWhitespace(s);
  s = normalizeLeadingYou(s);

  // ordering matters
  s = banTheyAsSubject(s);
  s = fixYouVerbAgreement(s);
  s = fixSecondPersonConjunctionAgreement(s);

  // **new**: sentence-level they/their → you/your when sentence is second-person
  s = normalizeSecondPersonPronounsBySentence(s);

  // cleanup casing
  s = normalizeMidSentenceYouCaps(s);

  s = collapseWhitespace(s);
  return s;
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

function hasBadArtifacts(text) {
  if (!isNonEmptyString(text)) return false;
  const t = text;

  // JSON/fences/meta
  if (t.includes('```')) return true;
  if (t.includes('"short_summary"') || t.includes('"full_summary"')) return true;
  if (/^\s*json\s*\{?/i.test(t)) return true;

  // POV and first-person variants
  if (/\bthe user\b/i.test(t)) return true;
  if (/\bI'm\b/i.test(t) || /\bI’m\b/i.test(t) || /\bI've\b/i.test(t) || /\bI’ve\b/i.test(t)) return true;
  if (/\bI\b/.test(t) || /\bmy\b/i.test(t) || /\bme\b/i.test(t)) return true;

  // grammar / leaks we care about
  if (/\bYou is\b|\bYou has\b|\bYou discusses\b/i.test(t)) return true;
  if (/\bYou\b[^.!?]{0,240}\b(and|but)\s+(is|was|has)\b/i.test(t)) return true;
  if (/\bYou\b[^.!?]{0,240}\b(his|her)\s+(mother|father|parents|life|divorce|ex[- ]wife|ex[- ]husband)\b/i.test(t)) return true;
  if (/(^|[.!?]\s+)They\b/.test(t)) return true;

  // remaining drift patterns
  if (/\bYou\b[^.!?]*\btheir\b/i.test(t)) return true;
  if (/\bYou\b[^.!?]*\bthey\b/i.test(t)) return true;
  if (/\bYou\b[^.!?]*\band wants\b/i.test(t)) return true;

  return false;
}

async function fetchAllRows(limit, offset) {
  return supabase
    .from('memory_summary')
    .select('id, short_summary, full_summary, session_insights, created_at')
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);
}

async function run() {
  let offset = 0;
  let scanned = 0;
  let wouldFix = 0;
  let fixed = 0;

  while (true) {
    const { data: rows, error } = await fetchAllRows(BATCH_SIZE, offset);
    if (error) throw error;
    if (!rows || rows.length === 0) break;

    scanned += rows.length;

    for (const row of rows) {
      const si = stableJsonObject(row.session_insights);

      const colShortRaw = isNonEmptyString(row.short_summary) ? String(row.short_summary) : '';
      const colFullRaw = isNonEmptyString(row.full_summary) ? String(row.full_summary) : '';
      let siShortRaw = isNonEmptyString(si.short_summary) ? String(si.short_summary) : '';
      let siFullRaw = isNonEmptyString(si.full_summary) ? String(si.full_summary) : '';

      const quickLooksBad =
        hasBadArtifacts(colShortRaw) ||
        hasBadArtifacts(colFullRaw) ||
        hasBadArtifacts(siShortRaw) ||
        hasBadArtifacts(siFullRaw) ||
        looksLikeJsonObjectString(stripMarkdownFences(colShortRaw)) ||
        looksLikeJsonObjectString(stripMarkdownFences(colFullRaw)) ||
        looksLikeJsonObjectString(stripMarkdownFences(siShortRaw)) ||
        looksLikeJsonObjectString(stripMarkdownFences(siFullRaw));

      if (!quickLooksBad) continue;

      // Extract stringified JSON blobs if present (from any field)
      const ex =
        extractIfStringifiedJson(siShortRaw) ||
        extractIfStringifiedJson(siFullRaw) ||
        extractIfStringifiedJson(colShortRaw) ||
        extractIfStringifiedJson(colFullRaw);

      if (ex) {
        if (isNonEmptyString(ex.short_summary)) siShortRaw = ex.short_summary;
        if (isNonEmptyString(ex.full_summary)) siFullRaw = ex.full_summary;
      }

      // session_insights authoritative; backfill from columns if missing
      if (!siShortRaw && colShortRaw) siShortRaw = colShortRaw;
      if (!siFullRaw && colFullRaw) siFullRaw = colFullRaw;

      const nextSiFull = ensureSecondPerson(siFullRaw);
      let nextSiShort = ensureSecondPerson(siShortRaw);
      if (!nextSiShort && nextSiFull) nextSiShort = computeShortFromFull(nextSiFull);

      if (!nextSiShort && !nextSiFull) continue;

      const nextColShort = nextSiShort;
      const nextColFull = nextSiFull || null;

      const changed =
        nextSiShort !== (isNonEmptyString(si.short_summary) ? String(si.short_summary) : '') ||
        nextSiFull !== (isNonEmptyString(si.full_summary) ? String(si.full_summary) : '') ||
        nextColShort !== colShortRaw ||
        (nextColFull || null) !== (colFullRaw || null);

      if (!changed) continue;

      wouldFix++;

      if (DRY_RUN) {
        console.log(`\nCLEANUP ${row.id}`);
        console.log(`  col.short: "${colShortRaw}" -> "${nextColShort}"`);
      }

      if (COMMIT) {
        const nextSI = {
          ...si,
          short_summary: nextSiShort,
          full_summary: nextSiFull,
          voice_pov: 'second_person',
          cleanup_pass: 'cleanup_summaries_pass2.cjs',
          cleanup_at: new Date().toISOString(),
        };

        const { error: upErr } = await supabase
          .from('memory_summary')
          .update({
            session_insights: nextSI,
            short_summary: nextColShort,
            full_summary: nextColFull,
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
    wouldFix,
    fixed: COMMIT ? fixed : 0,
    mode: DRY_RUN ? 'dry-run' : 'commit',
  });
}

run().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
