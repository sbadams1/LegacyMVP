/* eslint-disable no-console */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

const DRY_RUN = process.argv.includes('--dry-run');
const COMMIT = process.argv.includes('--commit');

if (!DRY_RUN && !COMMIT) {
  console.error('Specify --dry-run or --commit');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const BATCH_SIZE = 10;
const MIN_MEANINGFUL_WORDS = 40;

// Boilerplate filter
function stripBoilerplate(text) {
  return text
    .replace(/hey.*are you there\??/gi, '')
    .replace(/play gemini/gi, '')
    .trim();
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

async function fetchGarbageRows(limit, offset) {
  return supabase
    .from('memory_summary')
    .select('id, raw_id, conversation_id, short_summary, session_insights')
    .or(`
      short_summary.ilike.%checked in briefly%,
      short_summary.ilike.%opened the app%,
      session_insights.is.null,
      session_insights->>summary.is.null
    `)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);
}

async function fetchTranscript(rawId) {
  const { data, error } = await supabase
    .from('memory_raw')
    .select('transcript')
    .eq('id', rawId)
    .maybeSingle();

  if (error || !data?.transcript) return null;
  return data.transcript;
}

async function summarize(transcript) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          'You are repairing historical session summaries. ' +
          'Summarize only what the user actually said. ' +
          'Do not add interpretation, advice, or insight.',
      },
      {
        role: 'user',
        content:
          `Summarize this session in 3–5 sentences.\n\nTranscript:\n${transcript}`,
      },
    ],
  });

  return response.choices[0]?.message?.content?.trim() || null;
}

async function run() {
  let offset = 0;
  let processed = 0;
  let repaired = 0;

  while (true) {
    const { data: rows } = await fetchGarbageRows(BATCH_SIZE, offset);
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      processed++;

      const transcriptRaw = await fetchTranscript(row.raw_id);
      if (!transcriptRaw) continue;

      const cleaned = stripBoilerplate(transcriptRaw);
      if (wordCount(cleaned) < MIN_MEANINGFUL_WORDS) {
        console.log(`SKIP (too short): ${row.id}`);
        continue;
      }

      const summary = await summarize(cleaned);
      if (!summary) continue;

      const shortSummary = summary.split('. ').slice(0, 1).join('. ') + '.';

      console.log(`\nREPAIR ${row.id}`);
      console.log(`→ ${shortSummary}`);

      if (COMMIT) {
        const nextInsights = {
          ...(row.session_insights || {}),
          summary,
          repaired_at: new Date().toISOString(),
          repair_version: 'pass1_summary_only',
        };

        await supabase
          .from('memory_summary')
          .update({
            short_summary: shortSummary,
            session_insights: nextInsights,
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id);

        repaired++;
      }
    }

    offset += BATCH_SIZE;
  }

  console.log('\nDONE');
  console.log({ processed, repaired, mode: DRY_RUN ? 'dry-run' : 'commit' });
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
