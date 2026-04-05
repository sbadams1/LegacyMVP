// supabase/functions/_shared/relevant_prior.ts
// Shared retrieval helpers used by both legacy (ai-brain) and avatar modes.
// Purpose: fetch a small, relevant set of prior stories + facts for a query,
// and render a deterministic RELEVANT_PRIOR_CONTEXT block.

export type RelevantStoryRow = {
  id: string;
  title?: string | null;
  synopsis?: string | null;
  updated_at?: string | null;
  conversation_id?: string | null;
};

export type RelevantFactRow = {
  id?: string | null;
  fact_key_canonical?: string | null;
  value_json?: any;
  source_quote?: string | null;
  confidence?: number | null;
  status?: string | null;
  extracted_at?: string | null;
  conversation_id?: string | null;
};

function extractSalientTokens(queryText: string): string[] {
  const text = String(queryText ?? "").toLowerCase();
  const rawTokens = (text.match(/[a-z]{4,}/g) ?? []).slice(0, 60);
  const stop = new Set<string>([
    "that","this","what","does","mean","says","about","based","know","your","with","have","from","like","just","into","when","then","them","they","were","been","because","could","would","should","there","here","make","made","tell","story","stories","remember","recall","connect","dots","please","save","record",
  ]);

  const uniq: string[] = [];
  for (const t of rawTokens) {
    if (stop.has(t)) continue;
    if (!uniq.includes(t)) uniq.push(t);
    if (uniq.length >= 4) break;
  }
  return uniq;
}

export async function fetchRelevantPriorForQuery(args: {
  supabase: any;
  user_id: string;
  queryText: string;
  story_limit?: number;
  fact_limit?: number;
}): Promise<{ tokens: string[]; stories: RelevantStoryRow[]; facts: RelevantFactRow[] }> {
  const { supabase, user_id, queryText } = args;
  const story_limit = typeof args.story_limit === "number" ? args.story_limit : 4;
  const fact_limit = typeof args.fact_limit === "number" ? args.fact_limit : 8;

  const tokens = extractSalientTokens(queryText);
  if (tokens.length === 0) return { tokens, stories: [], facts: [] };

  const orStories = tokens.map((k) => `title.ilike.%${k}%,synopsis.ilike.%${k}%`).join(",");
  const orFacts = tokens.map((k) => `fact_key_canonical.ilike.%${k}%,source_quote.ilike.%${k}%`).join(",");

  const { data: stories } = await supabase
    .from("story_recall")
    .select("id, title, synopsis, updated_at, conversation_id")
    .eq("user_id", user_id)
    .or(orStories)
    .order("updated_at", { ascending: false })
    .limit(story_limit);

  const { data: facts } = await supabase
    .from("fact_candidates")
    .select("id, fact_key_canonical, value_json, source_quote, confidence, status, extracted_at, conversation_id")
    .eq("user_id", user_id)
    .not("fact_key_canonical", "is", null)
    .in("status", ["accepted", "active", "captured"])
    .or(orFacts)
    .order("confidence", { ascending: false })
    .limit(fact_limit);

  return { tokens, stories: (stories ?? []) as any, facts: (facts ?? []) as any };
}

export function buildRelevantPriorContextBlock(stories: RelevantStoryRow[], facts: RelevantFactRow[]): string {
 const storyLines = (stories ?? []).map((s: any) => {
    const title = String(s.title ?? "").trim();
    const syn = String(s.synopsis ?? "").trim();
    const head = title ? `${title} (id=${s.id})` : `Story (id=${s.id})`;
    const body = syn ? syn.slice(0, 240) : "";
    return `- ${head}${body ? `: ${body}` : ""}`;
  });

  const factLines = (facts ?? []).map((f: any) => {
    const k = String(f.fact_key_canonical ?? "").trim();
    const v = JSON.stringify(f.value_json ?? null);
    const quote = String(f.source_quote ?? "").trim();
    const q = quote ? ` — "${quote.slice(0, 120)}"` : "";
    return `- ${k}: ${v}${q}`;
  });

  if (storyLines.length === 0 && factLines.length === 0) return "";

  return [
    "RELEVANT_PRIOR_CONTEXT (evidence-backed; do not invent):",
    storyLines.length ? "Prior stories:" : "Prior stories: (none)",
    ...storyLines,
    factLines.length ? "Prior facts:" : "Prior facts: (none)",
    ...factLines,
  ].join("\n");
}

export async function loadRelevantPriorContextBlock(
  supabase: any,
  user_id: string,
  queryText: string,
): Promise<string> {
  try {
    const { stories, facts } = await fetchRelevantPriorForQuery({ supabase, user_id, queryText });
    return buildRelevantPriorContextBlock(stories, facts);
  } catch (e) {
    console.log("RELEVANT_PRIOR_CONTEXT: fetch failed (non-fatal)", String(e));
    return "";
  }
}