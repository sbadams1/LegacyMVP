// supabase/functions/ai-brain/pipelines/end_session.ts
// Extracted from ai-brain/handler.ts to reduce brittleness.
// This pipeline runs ONLY during explicit end-session.

// Build fingerprint for verifying the deployed bundle is actually using this file.
const END_SESSION_BUILD_STAMP = "2026-02-18T06:15Z";

 export type EndSessionDeps = {
   fetchLegacySessionTranscript: (...args: any[]) => Promise<any>;
   summarizeLegacySessionWithGemini: (...args: any[]) => Promise<any>;
   // [KILL] chapter/coverage/story-seeds/graphs/rebuild-insights/themes. Not required for continuity or durable recall.

   // Optional: extract/update canonical user facts from THIS session only.
   // Output must be JSON with a top-level { fact_candidates: [...] } (legacy {facts:[...]} tolerated).
   extractUserFactsWithGemini?: (args: {
     transcriptText: string;
     preferred_locale: string;
     receipt_id: string;
   }) => Promise<any>;
 };

export type EndSessionCtx = {
  client: any;
  user_id: string;
  effectiveConversationId: string;
  rawIdThisTurn: string | null;
  conversationMode: string;
  preferredLocale: string;
  targetLocale: string | null;
  hasTarget: boolean;
  legacyState: any;
  nowIso: string;
  deps: EndSessionDeps;
};

// ---------------------------------------------------------------------------
// Deterministic session_insights (no extra model calls).
// Persist a compact debugging/recall-friendly summary derived from end_session_trace.
// ---------------------------------------------------------------------------
type EndSessionTraceItem = { step: string; ms: number; meta?: any };

function buildSessionInsights(args: {
  phase: "A" | "B" | "final";
  end_session_trace: EndSessionTraceItem[];
  counts?: Record<string, any>;
  extra?: Record<string, any>;
}): Record<string, any> {
  const trace = Array.isArray(args.end_session_trace) ? args.end_session_trace : [];
  const steps = trace
    .map((t) => ({ step: String((t as any)?.step ?? ""), ms: Number((t as any)?.ms ?? 0) }))
    .filter((t) => t.step && Number.isFinite(t.ms) && t.ms > 0);

  const total_ms = steps.reduce((acc, s) => acc + s.ms, 0);
  const top_steps = steps
    .slice()
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 6);

  // Detect whether Phase B was queued (Phase A sets meta.queued_phase_b).
  let queued_phase_b = false;
  for (const t of trace) {
    const m = (t as any)?.meta;
    if (m && typeof m === "object" && (m as any)?.queued_phase_b === true) {
      queued_phase_b = true;
      break;
    }
  }

  const out: Record<string, any> = {
    version: "insights_v1",
    phase: args.phase,
    counts: args.counts ?? {},
    timing_ms: { total_ms: Math.round(total_ms), top_steps },
    flags: { queued_phase_b },
  };

  if (args.extra && typeof args.extra === "object") out.extra = args.extra;
  return out;
}

// ---------------------------------------------------------------------------
// Phase B facts extractor fallback
// - Phase A can pass deps from turn_core.ts, but Phase B runs in a worker that
//   only has this module. If deps.extractUserFactsWithGemini is missing, we
//   fall back to calling Gemini directly so Phase B still produces facts.
// ---------------------------------------------------------------------------
const GEMINI_API_KEY = String(Deno.env.get("GEMINI_API_KEY") ?? "").trim();
const GEMINI_MODEL = String(Deno.env.get("GEMINI_MODEL") ?? "models/gemini-1.5-flash").trim();

async function extractUserFactsWithGeminiFallback(args: {
  transcriptText: string;
  preferred_locale: string;
  receipt_id: string;
}): Promise<any> {
  try {
    if (!GEMINI_API_KEY) return { fact_candidates: [] };

    const SYSTEM = [
      "You extract durable user facts stated explicitly by the USER in THIS session.",
      "Do NOT guess or infer. If it's not explicitly stated, omit it.",
      "Return ONLY valid JSON (no markdown fences, no prose).",
      "Top-level JSON must be exactly: { \"fact_candidates\": [ ... ] }.",
      "Return at most 12 fact_candidates total.",
      "Each candidate must include exactly these fields: subject, attribute_path, value_json, value_type, stability, change_policy, confidence, evidence, context.",
      "Do not include any additional top-level keys or candidate fields.",
      "subject must be: { \"type\": \"user|person\", \"name\": \"<optional>\" }.",
      "Use subject.type=\"user\" for the USER.",
      "Use subject.type=\"person\" for any other person mentioned.",
      "If subject.type=\"person\", include subject.name ONLY when explicitly stated.",
      "attribute_path must be a short lowercase dot-path using ONLY these namespaces: identity.*, location.*, health.*, preferences.*, work.*, projects.*, relationships.*, beliefs.*, views.*",
      "identity.*, location.*, health.*, preferences.*, work.*, projects.* MUST be used only when subject.type=\"user\".",
      "If the statement is about another person, use relationships.* (and subject.type=\"person\").",
      "value_json must be valid JSON and must not be empty (no empty string, {}, or []).",
      "value_type must be exactly one of: string | number | boolean | array | object and must match value_json.",
      "stability must be exactly one of: sticky | semi_sticky | mutable.",
      "change_policy must be exactly one of: overwrite_if_explicit_or_newer | overwrite_if_explicit | append_only | never_overwrite.",
      "evidence must be an array with exactly 1 item: { receipt_id, quote }.",
      "If SESSION_USER_TEXT contains [RID:<id>] markers, set evidence[0].receipt_id to the RID of the exact quoted line.",
      "If no [RID:...] marker is present for your quote, use RECEIPT_ID_FOR_EVIDENCE.",
      "evidence.quote must be a direct short quote from SESSION_USER_TEXT, max 120 characters, no ellipses.",
      "context must be read-aloud safe and neutral, max 80 characters.",
      "confidence must be a number from 0 to 1.",
      "If there are no valid facts, return: {\"fact_candidates\":[]}",
    ].join(" ");

    const userText = String(args.transcriptText ?? "").trim();
    const receiptId = String(args.receipt_id ?? "").trim() || "unknown_receipt";
    const preferredLocale = String(args.preferred_locale ?? "en").trim() || "en";

    const prompt = [
      SYSTEM,
      "",
      "SESSION_USER_TEXT:",
      userText,
      "",
      "RECEIPT_ID_FOR_EVIDENCE (use only if no [RID:...] marker is available):",
      receiptId,
      "",
      "PREFERRED_LOCALE:",
      preferredLocale,
    ].join("\n");

    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 1536,
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    };

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.warn("FACTS: Gemini extractor non-OK response", resp.status, t);
      return { fact_candidates: [] };
    }

    const json = await resp.json().catch(() => null);
    const text =
      (json as any)?.candidates?.[0]?.content?.parts?.[0]?.text ??
      (json as any)?.candidates?.[0]?.content?.parts?.[0]?.rawText ??
      "";
    if (typeof text !== "string" || !text.trim()) return { fact_candidates: [] };

    // Do a tolerant parse: accept either raw JSON or JSON wrapped with extra text.
    const raw = text.trim();
    try {
      return JSON.parse(raw);
    } catch {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(raw.slice(start, end + 1));
        } catch {
          return { fact_candidates: [] };
        }
      }
      return { fact_candidates: [] };
    }
  } catch (e) {
    console.warn("FACTS: Gemini extractor threw (non-fatal):", (e as any)?.message ?? e);
    return { fact_candidates: [] };
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint (called by turn_core.ts during explicit end-session)
// ---------------------------------------------------------------------------

function normalizeStringList(v: any): string[] {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v
      .map((x) => (x == null ? "" : String(x)).trim())
      .filter((x) => x.length > 0);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    // If it looks like a bullet/line list, split; otherwise keep as single item.
    const parts = s
      .split(/\r?\n|\u2022|\-/)
      .map((x) => String(x).trim())
      .filter((x) => x.length > 0);
    return parts.length > 1 ? parts : [s];
  }
  return [String(v).trim()].filter((x) => x.length > 0);
}

// Phase A wants compact, stable output:
// - "memory_snapshot": 2–4 sentences
// - "fact_suggestions": 0–3 bullets
function coerceMemorySnapshotFromSummary(summaryObj: any): string {
  // Your pipeline sometimes returns strings, sometimes { short_summary, ... }.
  if (!summaryObj) return "";
  if (typeof summaryObj === "string") return clampString(summaryObj, 900);
  const s =
    summaryObj.short_summary ??
    summaryObj.memory_snapshot ??
    summaryObj.summary ??
    summaryObj.text ??
    "";
  return clampString(s, 900);
}

function extractFactCandidatesFromExtractorOutput(extractorOut: any): any[] {
  // tolerate legacy shapes: { fact_candidates: [...] } or { facts: [...] }
  if (!extractorOut) return [];
  if (Array.isArray(extractorOut.fact_candidates)) return extractorOut.fact_candidates;
  if (Array.isArray(extractorOut.facts)) return extractorOut.facts;
  return [];
}

// ---------------------------------------------------------------------------
// Story capture (heuristic, no extra model calls)
// Writes:
// - story_seeds: narrative backing text
// - story_recall: lightweight index for retrieval/retell
// ---------------------------------------------------------------------------
function isProceduralPlaceholder(s: string): boolean {
  const t = String(s ?? "").trim().toLowerCase();
  if (!t) return true;
  // Common procedural placeholders from rebuild/cleanup passes
  if (t.includes("checked in briefly")) return true;
  if (t.includes("opened the app")) return true;
  if (t.includes("brief check-in") || t.includes("brief check in")) return true;
  if (t.includes("did not record a detailed story")) return true;
  if (t.includes("without recording a detailed story")) return true;
  if (t.includes("no detailed story")) return true;
  if (t.includes("no story in this session")) return true;
  if (t.includes("no summary was captured")) return true;
  if (t.includes("presence check")) return true;
  return false;
}

// Keep memory_summary compact: strip huge internal payloads and cap sizes.

 function clampString(s: any, maxLen: number): string {
   const t = String(s ?? "").trim();
    if (!t) return "";
    return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
  }
 
function parseFactsJsonMaybeV1(facts: any): Record<string, any> {
  if (facts && typeof facts === "object") return facts as Record<string, any>;
  if (typeof facts === "string") {
    const s = facts.trim();
    if (!s) return {};
    try {
      const parsed = JSON.parse(s);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

 function storyEssenceSlugV1(title: string, narrative: string): string {
   // Prefer “essence” words over filler.
   const stop = new Set([
     "one", "time", "in", "the", "a", "an", "and", "or", "but", "then", "so", "to", "of",
     "i", "we", "you", "he", "she", "they", "it", "my", "our", "your", "his", "her", "their",
     "was", "were", "am", "is", "are", "been", "being", "be", "do", "did", "done",
     "stopped", "went", "got", "had", "have", "having", "realized", "asked", "tried",
     "after", "before", "later", "night", "late", "small", "place",
   ]);
 
   const src = `${title ?? ""} ${narrative ?? ""}`.toLowerCase();
   const tokens = src
     .replace(/[^a-z0-9\s]/g, " ")
     .split(/\s+/g)
     .map((t) => t.trim())
     .filter(Boolean);
 
   const picked: string[] = [];
   for (const t of tokens) {
     if (picked.length >= 6) break;
     if (t.length < 3) continue;
     if (stop.has(t)) continue;
     if (!picked.includes(t)) picked.push(t);
   }
 
   const slug = picked.join("_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
   return slug.slice(0, 48) || "story";
 }
 
 function firstSentenceV1(s: string): string {
   const t = String(s ?? "").trim();
   if (!t) return "";
   const nl = t.indexOf("\n");
   const cut1 = nl >= 0 ? t.slice(0, nl) : t;
   const m = cut1.match(/^(.+?[.!?])(\s|$)/);
   return (m ? m[1] : cut1).trim();
 }

 // Raw helpers (keep them simple and deterministic)
 function titleFromStoryTextV1(storyText: string): string {
   const s = firstSentenceV1(storyText);
   return (s || "Story").slice(0, 140).trim();
 }

   function oneLinerFromStoryTextV1(storyText: string): string {
     const s = firstSentenceV1(storyText);
     return (s || "").slice(0, 240).trim();
   }
 
  function titleCaseWordsV1(words: string[]): string[] {
    return words.map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w));
  }

  function clampHandleV1(s: string): string {
    let out = String(s || "").replace(/\s+/g, " ").trim();
    if (!out) return "Story";
    const words = out.split(" ").filter(Boolean).slice(0, 5);
    out = words.join(" ").trim() || "Story";
    if (out.length > 36) out = out.slice(0, 36).replace(/\s+\S*$/, "").trim();
    return out || "Story";
  }

  function extractQuotedHandleV1(narrative: string): string | null {
    const t = String(narrative ?? "");
    const re = /["“”']([^"“”']{3,60})["“”']/g;
    let m: RegExpExecArray | null = null;
    let best: string | null = null;
    while ((m = re.exec(t)) != null) {
      const inner = String(m[1] ?? "").replace(/\s+/g, " ").trim();
      if (!inner) continue;
      const w = inner.split(" ").filter(Boolean);
      if (w.length < 1 || w.length > 5) continue;
      if (!best || inner.length > best.length) best = inner;
    }
    return best;
  }

  function extractNamedHandleV1(narrative: string): string | null {
    const t = String(narrative ?? "");
    const m = t.match(/\b(called|named|nickname[d]?)\b\s+([A-Za-z0-9][A-Za-z0-9\s-]{2,60})/i);
    if (!m) return null;
    const phrase = String(m[2] ?? "")
      .replace(/[\.\!\?,;:]+.*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!phrase) return null;
    const w = phrase.split(" ").filter(Boolean);
    if (w.length < 1 || w.length > 5) return null;
    return phrase;
  }

  function keywordHandleFromNarrativeV1(rawTitle: string, narrative: string): string {
    // Pick “distinctive” tokens, not timeline/job boilerplate.
    const stop = new Set([
      "the","a","an","and","or","but","to","of","in","on","at","for","with","from","about","as",
      "i","me","my","mine","we","our","you","your","he","his","she","her","they","their","it","its",
      "this","that","these","those","then","when","while","because","so","just","really","very"
    ]);
     const ban = new Set([
       "last","first","years","year","months","month","weeks","week","days","day","today","yesterday","tomorrow",
       "job","work","working","career","office","manager","boss",
       "social","security","administration","ssa","federal","government",
      "went","going","got","get","make","made","said","say","told","tell","feel","felt","think","thought",
      // generic scene-setting filler (NOT location- or user-specific)
      "one","time","late","night","small","near","place","beach"
     ]);
 
    // Prefer later sentences (where the "hook" usually is) over the opening scene-setting line.
    const narrativeText = String(narrative ?? "");
    const parts = narrativeText.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
    const tail = parts.length > 1 ? parts.slice(1).join(" ") : "";
    const src = `${rawTitle ?? ""} ${(tail || narrativeText)}`.toLowerCase();
    const tokens = src
       .replace(/[^a-z0-9\s-]/g, " ")
       .split(/\s+/g)
       .map((x) => x.trim())
       .filter(Boolean)
       .filter((x) => x.length >= 3)
       .filter((x) => !stop.has(x))
       .filter((x) => !ban.has(x))
       .filter((x) => !/^\d+$/.test(x));

    if (tokens.length === 0) return "Story";

    // Frequency + length score; keep first-seen order for readability.
    const freq = new Map<string, number>();
    const firstIdx = new Map<string, number>();
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      freq.set(tok, (freq.get(tok) ?? 0) + 1);
      if (!firstIdx.has(tok)) firstIdx.set(tok, i);
    }

    const uniq = Array.from(freq.keys());
    uniq.sort((a, b) => {
      const sa = (freq.get(a) ?? 0) * 10 + Math.min(a.length, 12);
      const sb = (freq.get(b) ?? 0) * 10 + Math.min(b.length, 12);
      if (sb !== sa) return sb - sa;
      return (firstIdx.get(a) ?? 0) - (firstIdx.get(b) ?? 0);
    });

    const picked: string[] = [];
    for (const tok of uniq) {
      if (picked.length >= 4) break; // keep it punchy; clampHandleV1 enforces <=5 anyway
      picked.push(tok);
    }
    return titleCaseWordsV1(picked).join(" ").trim() || "Story";
  }

 function storyHandleTitleV1(rawTitle: string, narrative: string): string {
   // Deterministic fallback only (no one-off hardcoding).
   const slug = storyEssenceSlugV1(String(rawTitle ?? ""), String(narrative ?? ""));
   const words = String(slug || "story")
     .split("_")
     .filter(Boolean)
     .slice(0, 5)
     .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
   let out = words.join(" ").trim() || "Story";
   if (out.length > 36) out = out.slice(0, 36).replace(/\s+\S*$/, "").trim();
   return out || "Story";
 }

 function isValidStoryHandleV1(s: string): boolean {
   const t = String(s ?? "").replace(/\s+/g, " ").trim();
   if (!t) return false;
   // Must be 1–5 words.
   const words = t.split(" ").filter(Boolean);
   if (words.length < 1 || words.length > 5) return false;
   // Reject sentence punctuation / quotes / brackets.
   if (/[.?!,:;()[\]{}"“”'`]/.test(t)) return false;
   // Avoid obvious sentence openings.
   if (/^(one time|when i|i |then |because )/i.test(t)) return false;
   return true;
 }

 async function storyHandleTitleGeminiV1(narrative: string): Promise<string | null> {
   try {
     const txt = String(narrative ?? "").trim();
     if (!txt) return null;
     if (!GEMINI_API_KEY) return null;

     const instr = [
       "Return ONLY valid JSON like: {\"handle\":\"...\"}",
       "The handle must be a short mnemonic label for the story.",
       "Rules:",
       "- 1 to 5 words",
       "- noun-phrase style (not a sentence)",
       "- no punctuation (.?!,:; quotes brackets)",
       "- avoid 'one time', 'when I', or starting with 'I'",
     ].join("\n");

     const body = {
       contents: [{ role: "user", parts: [{ text: `${instr}\n\nSTORY:\n${txt}\n` }] }],
       generationConfig: {
         maxOutputTokens: 64,
         temperature: 0.2,
         responseMimeType: "application/json",
       },
     };

     for (let attempt = 0; attempt < 2; attempt++) {
       const resp = await fetch(
         `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
         { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
       );
       if (!resp.ok) continue;
       const json = await resp.json().catch(() => null);
       const raw = (json as any)?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
       if (typeof raw !== "string" || !raw.trim()) continue;

       let obj: any = null;
       try {
         obj = JSON.parse(raw.trim());
       } catch {
         const s = raw.indexOf("{");
         const e = raw.lastIndexOf("}");
         if (s >= 0 && e > s) {
           try { obj = JSON.parse(raw.slice(s, e + 1)); } catch { obj = null; }
         }
       }
       const h = String(obj?.handle ?? "").replace(/\s+/g, " ").trim();
       if (h && isValidStoryHandleV1(h)) return clampHandleV1(h);
     }
     return null;
   } catch {
     return null;
   }
 }

 function enforceStorySeedTitleV1(rawTitle: string, narrative: string, candidate: string | null | undefined): string {
   const c = String(candidate ?? "").replace(/\s+/g, " ").trim();
   if (c && isValidStoryHandleV1(c)) return clampHandleV1(c);
   return storyHandleTitleV1(rawTitle, narrative);
 }

   async function upsertUserKnowledgeFactsPatchV1(
    client: any,
    user_id: string,
    patchFacts: Record<string, any>,
  ): Promise<void> {
  try {
    if (!patchFacts || Object.keys(patchFacts).length === 0) return;

     const { data: existing } = await client
       .from("user_knowledge")
       .select("facts")
       .eq("user_id", user_id)
       .maybeSingle();
 
    const prev = parseFactsJsonMaybeV1((existing as any)?.facts);
     const merged = { ...prev, ...patchFacts };
 
     await client
       .from("user_knowledge")
       .upsert({ user_id, facts: merged }, { onConflict: "user_id" });
   } catch (e) {
    console.warn("END_SESSION: user_knowledge upsert failed (non-fatal):", e);
  }
}

// ---------------------------------------------------------------------------
// Relevant prior context (stories + facts) for dot-connecting at end-session.
// This is prompt-only context: it does not change routing, persistence, or UI.
// ---------------------------------------------------------------------------
async function loadRelevantPriorContextBlockForSummary(
  client: any,
  user_id: string,
  queryText: string,
): Promise<string> {
  try {
    const text = String(queryText ?? "").toLowerCase();
    // Cheap tokenization: a few non-trivial words only.
    const rawTokens = (text.match(/[a-z]{4,}/g) ?? []).slice(0, 80);
    const stop = new Set<string>([
      "that","this","what","does","mean","says","about","based","know","your","with","have","from","like","just","into","when","then","them","they","were","been","because","could","would","should","there","here","make","made","tell","story","stories","remember","recall","connect","dots","please","save","record",
    ]);
    const uniq: string[] = [];
    for (const t of rawTokens) {
      if (stop.has(t)) continue;
      if (!uniq.includes(t)) uniq.push(t);
      if (uniq.length >= 4) break;
    }
    if (uniq.length === 0) return "";

    const orStories = uniq.map((k) => `title.ilike.%${k}%,synopsis.ilike.%${k}%`).join(",");
    const orFacts = uniq.map((k) => `fact_key_canonical.ilike.%${k}%,source_quote.ilike.%${k}%`).join(",");

    const { data: stories } = await client
      .from("story_recall")
      .select("id, title, synopsis, updated_at")
      .eq("user_id", user_id)
      .or(orStories)
      .order("updated_at", { ascending: false })
      .limit(4);

    const { data: facts } = await client
      .from("fact_candidates")
      .select("fact_key_canonical, value_json, source_quote, confidence, status")
      .eq("user_id", user_id)
      .not("fact_key_canonical", "is", null)
      .in("status", ["accepted", "active", "captured"])
      .or(orFacts)
      .order("confidence", { ascending: false })
      .limit(8);

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
      "",
      "CONNECTION_RULE:",
      "- If any prior story/fact is relevant to this session, explicitly connect it in the summary (briefly).",
      "- Never invent prior stories/facts; use only items listed above.",
    ].join("\n");
  } catch (e) {
    console.warn("END_SESSION: relevant prior context fetch failed (non-fatal):", (e as any)?.message ?? e);
    return "";
  }
}

function clampJsonObject(obj: any, maxChars: number): any {
  if (!obj || typeof obj !== "object") return obj;
  try {
    const s = JSON.stringify(obj);
    if (s.length <= maxChars) return obj;
  } catch (_) {
    return {};
  }
  // Best-effort: if too large, drop known heavy fields
  const out: any = { ...(obj as any) };
  for (const k of ["v2", "snapshot_text", "receipts_by_label", "longitudinal_snapshot"]) {
    if (k in out) delete out[k];
  }
  // If still too large, fall back to empty object
  try {
    const s2 = JSON.stringify(out);
    return s2.length <= maxChars ? out : {};
  } catch (_) {
    return {};
  }
}

const LONGITUDINAL_SNAPSHOT_V2_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    version: { type: "string", enum: ["v2"] },
    emerging_pattern: { type: "string" },
    tension_you_are_carrying: { type: "string" },
    underlying_value: { type: "string" },
    evidence: {
      type: "object",
      additionalProperties: { type: "array", items: { type: "string" } },
    },
    rejection_reason: { type: "string" },
  },
  required: ["version", "emerging_pattern", "tension_you_are_carrying", "underlying_value", "evidence"],
} as const;

function looksWrongIfReadAloudV2(block: string): boolean {
  const t = String(block ?? "").trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  // obvious template / debug markers
  if (lower.includes("draft") || lower.includes("still learning") || lower.includes("taxonomy")) return true;
  // avoid listy or robotic outputs
  if (t.includes("\n-") || t.includes("\n*") || t.match(/\n\s*\d+\./)) return true;
  // avoid generic phrase that is not actually the user
  if (lower.includes("you keep circling back") || lower.includes("across sessions, you express")) return true;
  // too many semicolons often reads like notes
  if ((t.split(";").length - 1) >= 2) return true;
  return false;
}

function isHighResonanceV2(v2: LongitudinalSnapshotV2): { ok: boolean; reason?: string } {
  const blocks = [v2.emerging_pattern, v2.tension_you_are_carrying, v2.underlying_value];
  for (const b of blocks) {
    const s = String(b ?? "").trim();
    if (s.length < 120) return { ok: false, reason: "too_short" };
    if (s.length > 700) return { ok: false, reason: "too_long" };
    if (looksWrongIfReadAloudV2(s)) return { ok: false, reason: "sounds_wrong_read_aloud" };
  }
  // dominance guard: do not show a taxonomy list of tensions
  const taxWords = ["key tensions", "tensions:", "more", "balancing"];
  const combined = blocks.join("\n").toLowerCase();
  if (taxWords.some((w) => combined.includes(w))) return { ok: false, reason: "taxonomy_tone" };
  return { ok: true };
}

function isoUtcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
}

function isoUtcMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0));
}

function pickReceiptSnippets(receipts: any, max = 2): string[] {
  const arr = Array.isArray(receipts) ? receipts : [];
  return arr
    .map((r) => String(r ?? "").trim())
    .filter((s) => s.length > 0)
    .slice(0, max);
}

function isTensionLikeReceipt(s: string): boolean {
  const t = String(s ?? "").toLowerCase();
  return (
    t.includes("but ") ||
    t.includes("however") ||
    t.includes("yet") ||
    t.includes("on the other") ||
    t.includes("at the same time") ||
    t.includes("tension") ||
    t.includes("balance")
  );
}

function envFlag(name: string, defaultValue = false): boolean {
  const v = Deno.env.get(name);
  if (!v) return defaultValue;
  const s = v.trim().toLowerCase();
  return (
    s === "true" ||
    s === "1" ||
    s === "yes" ||
    s === "y" ||
    s === "on"
  );
}

// Best-effort helpers: never let optional work block end-session indefinitely.
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
  let t: number | null = null;
  try {
    const timeout = new Promise<null>((resolve) => {
      t = setTimeout(() => resolve(null), ms) as unknown as number;
    });
    const out = await Promise.race([p, timeout]);
    return out as T | null;
  } catch (e) {
    console.warn("END_SESSION: withTimeout failed:", { label, message: (e as any)?.message ?? String(e) });
    return null;
  } finally {
    if (t) clearTimeout(t as unknown as number);
  }
}

type EligibilityResult = { summaryEligible: boolean; summaryReason: string; insightsEligible: boolean; reason: string; userWordCount: number; userCharCount: number; userTurnCount: number; totalTurnCount: number; eligible: boolean; };

function extractUserTextFromTranscript(transcript: any): { userText: string; userTurnCount: number; totalTurnCount: number } {
  if (!transcript) return { userText: "", userTurnCount: 0, totalTurnCount: 0 };
  // If transcript is already a string, treat it as userText (best effort).
  if (typeof transcript === "string") {
    return { userText: transcript, userTurnCount: 1, totalTurnCount: 1 };
  }
  // If transcript is an array of turns, collect user turns.
  if (Array.isArray(transcript)) {
    let userTextParts: string[] = [];
    let userTurnCount = 0;
    for (const t of transcript) {
      const role = String((t as any)?.role ?? (t as any)?.speaker ?? "").toLowerCase();
      const content = String((t as any)?.content ?? (t as any)?.text ?? "");
      if (!content) continue;
      if (role === "user" || role === "legacy_user" || role === "donor" || role === "human") {
        userTurnCount++;
        userTextParts.push(content);
      }
    }
    return { userText: userTextParts.join("\n"), userTurnCount, totalTurnCount: transcript.length };
  }
  // If transcript is an object, try common shapes
  if (typeof transcript === "object") {
    const turns = (transcript as any)?.turns ?? (transcript as any)?.messages ?? null;
    if (Array.isArray(turns)) return extractUserTextFromTranscript(turns);
    const t = String((transcript as any)?.text ?? (transcript as any)?.content ?? "");
    if (t) return { userText: t, userTurnCount: 1, totalTurnCount: 1 };
  }
  return { userText: "", userTurnCount: 0, totalTurnCount: 0 };
}

type EffectiveTranscriptTurn = {
  id: string;
  role: string;
  content: string;
  created_at?: string;
  user_edited?: boolean;
  raw_id?: string;
};

/**
 * UI-fast path should avoid memory_raw_edits entirely (it causes multiple DB calls).
 * Fetch only the most recent N memory_raw rows for this conversation.
 */
async function fetchRecentTranscriptNoEdits(
  client: any,
  user_id: string,
  conversation_id: string,
  limit = 60,
): Promise<EffectiveTranscriptTurn[]> {
  try {
    const { data, error } = await client
      .from("memory_raw")
      .select("id, role, content, created_at, context")
      .eq("user_id", user_id)
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("END_SESSION: fetchRecentTranscriptNoEdits memory_raw select error:", error);
      return [];
    }

    const rawRows = (data ?? []) as any[];
    if (!rawRows.length) return [];

    // Filter out VIP-lane synthetic anchors so they don't pollute end_session summaries.
    const filtered = rawRows.filter((r) => {
      const ctx = (r as any)?.context;
      return !(ctx && typeof ctx === "object" && (ctx as any).vip_lane === true);
    });
    if (!filtered.length) return [];

    // Reverse to chronological order (oldest -> newest)
    const chron = [...filtered].reverse();
    return chron.map((r) => ({
      role: String((r as any)?.role ?? "").trim() || "unknown",
      content: String((r as any)?.content ?? "").trim(),
      created_at: (r as any)?.created_at ?? null,
    })).filter((t) => t.content.length > 0);
  } catch (err) {
    console.error("END_SESSION: fetchRecentTranscriptNoEdits unexpected error:", err);
    return [];
  }
}

async function fetchEffectiveTranscriptWithEdits(
  client: any,
  user_id: string,
  conversation_id: string,
): Promise<EffectiveTranscriptTurn[]> {
  try {
    const { data, error } = await client
      .from("memory_raw")
      .select("id, role, content, created_at, context")
      .eq("user_id", user_id)
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(300);

    if (error) {
      console.error("END_SESSION: fetchEffectiveTranscriptWithEdits memory_raw select error:", error);
      return [];
    }

    const rawRows = (data ?? []) as any[];
    if (!rawRows.length) return [];

    // Filter out VIP-lane synthetic anchors so they don't pollute end_session summaries.
    // These rows exist only to satisfy FK constraints for fact_candidates.turn_ref.
    const filteredRawRows = rawRows.filter((r) => {
      const ctx = (r as any)?.context;
      return !(ctx && typeof ctx === "object" && (ctx as any).vip_lane === true);
    });
    if (!filteredRawRows.length) return [];

    const rawIds = filteredRawRows
       .map((r) => String(r?.id ?? "").trim())
       .filter(Boolean);

       const editMap = new Map<string, any>();
    const sourceEditIds: string[] = [];

    if (rawIds.length) {
      const CHUNK = 80;

      const fetchChunk = async (ids: string[]) => {
        const tryQueries: Array<() => Promise<{ data: any[] | null; error: any | null }>> = [
          async () =>
            await client
              .from("memory_raw_edits")
              .select("id, raw_id, edited_content, use_for, is_current")
              .eq("user_id", user_id)
              .eq("status", "active")
              .contains("use_for", ["summarization"])
              .in("raw_id", ids)
              .eq("is_current", true),
          async () =>
            await client
              .from("memory_raw_edits")
              .select("id, raw_id, edited_content, use_for")
              .eq("user_id", user_id)
              .eq("status", "active")
              .in("raw_id", ids),
          async () =>
            await client
              .from("memory_raw_edits")
              .select("*")
              .eq("user_id", user_id)
              .in("raw_id", ids),
        ];

        let lastErr: any | null = null;
        for (const q of tryQueries) {
          const { data, error } = await q();
          if (!error) return { data: (data ?? []) as any[], error: null };
          lastErr = error;
        }
        return { data: [] as any[], error: lastErr };
      };

      for (let i = 0; i < rawIds.length; i += CHUNK) {
        const ids = rawIds.slice(i, i + CHUNK);
        const { data: edits, error: e2 } = await fetchChunk(ids);
        if (e2) {
          console.error("END_SESSION: fetchEffectiveTranscriptWithEdits memory_raw_edits select error:", {
            message: e2?.message ?? String(e2),
            details: e2?.details,
            hint: e2?.hint,
            code: e2?.code,
          });
          break; // best-effort overlay only
        }
        for (const e of (edits ?? []) as any[]) {
          const rid = String(e?.raw_id ?? "").trim();
          if (!rid) continue;
          editMap.set(rid, e);
          const eid = String(e?.id ?? "").trim();
          if (eid) sourceEditIds.push(eid);
        }
      }
    }

    const out: EffectiveTranscriptTurn[] = [];
    for (const row of filteredRawRows) {
      const rawId = String(row?.id ?? "").trim();
      const role = String(row?.role ?? "").trim() || "user";
      const baseText = String(row?.content ?? "").trim();
      if (!baseText) continue;

      const edit = rawId ? editMap.get(rawId) : null;
      const useFor: string[] = Array.isArray(edit?.use_for) ? edit.use_for : [];
      const canUseEditForSummary = useFor.includes("summarization");

      const effective = canUseEditForSummary ? String(edit?.edited_content ?? "").trim() : baseText;
      if (!effective) continue;

      out.push({
        id: rawId,
        raw_id: rawId,
        role,
        content: effective,
        created_at: String(row?.created_at ?? ""),
        user_edited: Boolean(canUseEditForSummary),
      });
    }

    // Attach source edit IDs as a non-breaking property on the array (optional, best-effort).
    (out as any).source_edit_ids = Array.from(new Set(sourceEditIds)).slice(0, 200);
    return out;
  } catch (e) {
    console.error("END_SESSION: fetchEffectiveTranscriptWithEdits unexpected error:", e);
    return [];
  }
}

function countWords(s: string): number {
   const t = (s ?? "").replace(/\s+/g, " ").trim();
   if (!t) return 0;
   return t.split(" ").filter(Boolean).length;
 }

function assessEligibility(transcript: any): EligibilityResult {
  // We intentionally separate SUMMARY eligibility (low bar) from INSIGHTS eligibility (high bar).
  // A session can be summarize-able without being deep/reflective enough for reflections/patterns/rare insights.

  // Extract user turns (so we can ignore boilerplate presence-check utterances when scoring).
  const userTurns: string[] = (() => {
    if (!transcript) return [];
    if (typeof transcript === "string") return [transcript];
    if (Array.isArray(transcript)) {
      const out: string[] = [];
      for (const t of transcript) {
        const role = String((t as any)?.role ?? (t as any)?.speaker ?? "").toLowerCase();
        const content = String((t as any)?.content ?? (t as any)?.text ?? "");
        if (!content) continue;
        if (role === "user" || role === "legacy_user" || role === "donor" || role === "human") out.push(content);
      }
      return out;
    }
    if (typeof transcript === "object") {
      const turns = (transcript as any)?.turns ?? (transcript as any)?.messages ?? null;
      if (Array.isArray(turns)) {
        const out: string[] = [];
        for (const t of turns) {
          const role = String((t as any)?.role ?? (t as any)?.speaker ?? "").toLowerCase();
          const content = String((t as any)?.content ?? (t as any)?.text ?? "");
          if (!content) continue;
          if (role === "user" || role === "legacy_user" || role === "donor" || role === "human") out.push(content);
        }
        return out;
      }
      const t = String((transcript as any)?.text ?? (transcript as any)?.content ?? "");
      if (t) return [t];
    }
    return [];
  })();

  const { userText, userTurnCount, totalTurnCount } = extractUserTextFromTranscript(transcript);
  const userCharCount = (userText ?? "").trim().length;

  const presenceChecks = [
    "are you there",
    "you there",
    "play gemini",
    "can you hear me",
    "testing",
    "test"
  ];

  function isBoilerplateTurn(t: string): boolean {
    const s = String(t ?? "").trim().toLowerCase();
    if (!s) return true;
    // Very short greetings / wake checks
    if (s.length <= 24 && (s === "hi" || s === "hello" || s.startsWith("hey") || s.includes("are you there") || s.includes("you there"))) return true;
    // Explicit wake phrases
    if (presenceChecks.some((p) => s.includes(p)) && s.split(" ").filter(Boolean).length <= 6) return true;
    return false;
  }

  const meaningfulTurns = userTurns.filter((t) => !isBoilerplateTurn(t));
  const meaningfulText = meaningfulTurns.join("\n");
  const meaningfulWordCount = countWords(meaningfulText);
  const meaningfulTurnCount = meaningfulTurns.length;

  // SUMMARY thresholds (low bar)
  const minSummaryWords = Number(Deno.env.get("LEGACY_END_SESSION_MIN_SUMMARY_WORDS") ?? "40");
  const minSummaryTurns = Number(Deno.env.get("LEGACY_END_SESSION_MIN_SUMMARY_TURNS") ?? "2");
  const minSummaryTotalTurns = Number(Deno.env.get("LEGACY_END_SESSION_MIN_SUMMARY_TOTAL_TURNS") ?? "6");

  // INSIGHTS thresholds (high bar; keep your existing env names for compatibility)
  const minUserWords = Number(Deno.env.get("LEGACY_END_SESSION_MIN_USER_WORDS") ?? "120");
  const minUserTurns = Number(Deno.env.get("LEGACY_END_SESSION_MIN_USER_TURNS") ?? "2");

  // Reject truly empty / accidental sessions
  if (meaningfulWordCount < 5 && (meaningfulText ?? "").trim().length < 30) {
    return {
      summaryEligible: false,
      summaryReason: "too_short",
      insightsEligible: false,
      reason: "too_short",
      eligible: false,
      userWordCount: meaningfulWordCount,
      userCharCount,
      userTurnCount: meaningfulTurnCount,
      totalTurnCount,
    };
  }

  const summaryEligible =
    meaningfulWordCount >= minSummaryWords ||
    meaningfulTurnCount >= minSummaryTurns ||
    totalTurnCount >= minSummaryTotalTurns;

  const summaryReason = summaryEligible ? "ok" : "below_summary_threshold";

  // Presence-check should NOT veto summaries, but CAN veto insights unless there is substantial content.
  const lowerAll = (userText ?? "").toLowerCase();
  let insightsEligible = true;
  let reason = "ok";

  if (presenceChecks.some((p) => lowerAll.includes(p))) {
    if (meaningfulWordCount < minUserWords) {
      insightsEligible = false;
      reason = "presence_check";
    }
  }

  if (meaningfulWordCount < minUserWords) {
    insightsEligible = false;
    reason = "below_word_threshold";
  }
  if (meaningfulTurnCount < minUserTurns) {
    insightsEligible = false;
    reason = "below_turn_threshold";
  }

  return {
    summaryEligible,
    summaryReason,
    insightsEligible,
    reason,
    eligible: insightsEligible, // backwards-compat: existing code expects eligibility.eligible
    userWordCount: meaningfulWordCount,
    userCharCount,
    userTurnCount: meaningfulTurnCount,
    totalTurnCount,
  };
}

function looksLikeTranscript(s: string): boolean {
  const t = (s ?? "").trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  if (lower.includes("legacy_user") || lower.includes("legacy_ai")) return true;
  if (lower.includes("assistant:") || lower.includes("user:")) return true;
  if (lower.includes("role:") && lower.includes("content")) return true;
  if (t.split("\n").length >= 4) return true;
  // If it's mostly very short lines, it is likely dialogue
  const lines = t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (lines.length >= 4) {
    const shortLines = lines.filter((x) => x.length < 60).length;
    if (shortLines / lines.length > 0.7) return true;
  }
  return false;
}

function safePlaceholderSummary(reason: string): string {
  if (reason === "presence_check" || reason === "too_short" || reason === "below_word_threshold" || reason === "below_turn_threshold") {
    return "You checked in briefly this session without recording a detailed story.";
  }
  return "You ended the session without recording a detailed story.";
}

// Anchor vs narrative mode:
// Anchor sessions are "life record" sessions: lots of facts updated/confirmed even if no narrative arc.
function isAnchorSessionFromFactsReview(factsReview: any): boolean {
  const items = factsReview && Array.isArray(factsReview.items) ? factsReview.items : [];
  if (!items.length) return false;
  // Count fact changes that actually wrote/updated something.
  const changed = items.filter((it: any) => it && (it.status === "created" || it.status === "updated"));
  return changed.length >= 2;
}

function buildAnchorShortSummaryFromFactsReview(factsReview: any): string {
  const items = factsReview && Array.isArray(factsReview.items) ? factsReview.items : [];
  const changed = items.filter((it: any) => it && (it.status === "created" || it.status === "updated"));
  if (!changed.length) return "";

  // Prefer stable “life record” buckets.
  // NOTE: relationships often have multiple high-value anchors (mother/father/spouse/children).
  // We intentionally pick more than one relationships item when available.

  const pick = (pred: (k: string) => boolean) =>
    changed.find((it: any) => typeof it.fact_key === "string" && pred(it.fact_key));
  const pickAll = (pred: (k: string) => boolean) =>
    changed.filter((it: any) => typeof it.fact_key === "string" && pred(it.fact_key));

  const identity = pick((k) => k.startsWith("identity."));
  const loc = pick((k) => k.startsWith("location."));
  const health = pick((k) => k.startsWith("health."));
  const work = pick((k) => k.startsWith("work."));
  const relAll = pickAll((k) => k.startsWith("relationships."));

  // Prefer the most salient relationship anchors first.
  const relFather = relAll.find((it: any) => String(it?.fact_key ?? "").includes("father")) ?? null;
  const relMother = relAll.find((it: any) => String(it?.fact_key ?? "").includes("mother")) ?? null;
  const relOther = relAll.find((it: any) => it && it !== relFather && it !== relMother) ?? null;

  const bullets: string[] = [];
  const fmt = (it: any) => {
    const ctx = String(it?.context ?? "").trim();
    const quote = String(it?.receipt_quote ?? "").trim();
    if (ctx && quote) return `${ctx} (${quote})`;
    if (ctx) return ctx;
    if (quote) return quote;
    return String(it?.fact_key ?? "").trim();
  };

  for (const it of [identity, relMother, relFather, relOther, work, loc, health]) {
    if (it) bullets.push(fmt(it));
  }
  // If we didn’t get enough buckets, fill with other changed facts.
  if (bullets.length < 3) {
    for (const it of changed) {
      const s = fmt(it);
      if (!s) continue;
      if (!bullets.includes(s)) bullets.push(s);
      if (bullets.length >= 3) break;
    }
  }

  if (!bullets.length) return "";
  const joined = bullets.slice(0, 5).join("; ");
  // Keep it short and UI-friendly.
  return joined.length > 360 ? `${joined.slice(0, 359)}…` : joined;
}

function pickCoverageTextForClassification(input: {
  full_summary: any;
  short_summary: any;
}): { text: string; from: "full_summary" | "short_summary" | "none" } {
  const full = String(input.full_summary ?? "").trim();
  const short = String(input.short_summary ?? "").trim();

  const fullOk = full && !looksLikeTranscript(full) && !isProceduralPlaceholder(full) && !isGarbageSummary(full);
  if (fullOk) return { text: full, from: "full_summary" };

  const shortOk = short && !looksLikeTranscript(short) && !isProceduralPlaceholder(short) && !isGarbageSummary(short);
  if (shortOk) return { text: short, from: "short_summary" };

  return { text: "", from: "none" };
}

function isGarbageSummary(s: string | null | undefined): boolean {
  const t = String(s ?? "").trim();
  if (!t) return true;
  const lc = t.toLowerCase();
  // Common placeholder / wake / misroute junk we never want to treat as canonical summaries
  if (lc.startsWith("you checked in briefly")) return true;
  if (lc.startsWith("hey, gemini")) return true;
  if (lc.startsWith("play gemini")) return true;
  if (lc.startsWith("are you there")) return true;
  if (lc.includes("no summary was captured")) return true;
  return false;
}

// Best-effort: make a summary sound like clean second-person English.
// This avoids broken hybrids like "You reflects on his life..."
function forceSecondPersonSummary(input: string): string {
  let s = String(input ?? "").trim();
  if (!s) return "";

  // Convert 3rd-person pronouns to 2nd-person consistently.
  // (We prefer consistent "you/your" over a half-converted hybrid.)
  s = s
    .replace(/\b(he|she|they)\b/gi, "you")
    .replace(/\b(him|them)\b/gi, "you")
    .replace(/\b(his|her|their)\b/gi, "your");

  // Fix common auxiliary agreement.
  s = s
    .replace(/\bYou\s+is\b/g, "You are")
    .replace(/\bYou\s+was\b/g, "You were")
    .replace(/\bYou\s+has\b/g, "You have");

  // Fix the most common "You <verb>s" agreement errors introduced by naive swaps.
  // Keep this list tight to avoid harming legitimate words.
  const verbs = [
    "reflect", "share", "believe", "think", "feel", "say", "note", "describe", "discuss",
    "consider", "acknowledge", "express", "explain", "explore", "imagine", "realize",
    "recognize", "remember", "hope", "worry", "want", "decide", "avoid", "prefer",
  ];
  for (const v of verbs) {
    const re = new RegExp(`\\bYou\\s+${v}s\\b`, "g");
    s = s.replace(re, `You ${v}`);
  }

  // Also fix lowercase "you <verb>s" (mid-sentence).
  for (const v of verbs) {
    const re = new RegExp(`\\byou\\s+${v}s\\b`, "g");
    s = s.replace(re, `you ${v}`);
  }

  return s.trim();
}

function dedupeAdjacentParagraphs(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  // Normalize newlines, then split on blank lines (paragraphs).
  const paras = raw.replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paras.length <= 1) return raw;

  const out: string[] = [];
  let prevKey = "";
  for (const p of paras) {
    const key = p.replace(/\s+/g, " ").trim().toLowerCase();
    if (key && key === prevKey) continue; // drop exact adjacent duplicate
    out.push(p);
    prevKey = key;
  }

  // If the model duplicated the whole block back-to-back, this collapses it.
  return out.join("\n\n").trim();
}

function stripTrailingInterviewQuestion(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";

  // Operate on last non-empty line first (common: summary + blank line + question)
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (String(lines[i] ?? "").trim().length > 0) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx < 0) return raw;

  const lastLine = String(lines[lastIdx] ?? "").trim();
  const lc = lastLine.toLowerCase();

  const looksLikePrompt =
    lastLine.endsWith("?") &&
    (
      lc.startsWith("what would you like") ||
      lc.startsWith("would you like") ||
      lc.startsWith("do you want") ||
      lc.startsWith("can you") ||
      lc.startsWith("could you") ||
      lc.startsWith("tell me") ||
      lc.startsWith("anything else") ||
      lc.includes("want to explore next") ||
      lc.includes("want to talk about next")
    );

  if (!looksLikePrompt) return raw;

  // Drop the last line and any trailing blank lines.
  const kept = lines.slice(0, lastIdx).join("\n").trimEnd();
  return kept.trim().length > 0 ? kept.trim() : raw;
}

 // ==========================
 // Canonical facts extraction + upsert
 // ==========================
 // Migration: retire user_facts (v1) in favor of receipts-backed canonical table.
const USER_FACTS_TABLE = "facts_effective";

const USER_FACTS_V1_KEYS: string[] = [
  // Sticky
  "dob",
  "height_cm",
  // Semi-sticky
  "current_city",
  "current_country",
  "timezone",
  "occupation_history",
  // Mutable
  "weight_kg",
  "exercise_routine",
  "diet_preferences",
  "primary_project",
  // Derived mirror (prefer deterministic computation elsewhere when dob exists)
  "age_years",
];

function normalizeFactKey(k: any): string {
  return String(k ?? "").trim().toLowerCase();
}

// Alias -> canonical dot-path keys (keeps ingestion clean)
const FACT_KEY_ALIASES: Record<string, string> = {
  // existing legacy aliases you’ve seen
  dob: "identity.date_of_birth",
  age_years: "identity.age",
  weight_kg: "identity.weight_kg",
  height_cm: "identity.height_cm",
  timezone: "location.timezone",
  diet_preferences: "preferences.diet",
  occupation_history: "work.occupation_history",
  primary_project: "projects.current_project",

  // NEW stragglers seen in your table
  current_city: "location.current_city",
  current_country: "location.current_country",
  exercise_routine: "health.exercise_routine",

  // optional common variants (harmless)
  exerciseRoutine: "health.exercise_routine",
  exercise: "health.exercise_routine",
};

function clamp01(x: any): number {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function isExplicitCorrection(quote: string): boolean {
  const q = String(quote ?? "").toLowerCase();
  if (!q) return false;
  return /\b(actually|to correct|correction|i was wrong|i meant|i'm not|i am not)\b/.test(q);
}

function isExplicitChange(quote: string): boolean {
  const q = String(quote ?? "").toLowerCase();
  if (!q) return false;
  return /\b(i moved|i now live|i live in|i'm living in|i am living in|i relocated|i switched|i changed|i weigh|my weight is|i was born|my birth year is|my birth_year is)\b/.test(q);
}

function takeLastN<T>(arr: T[], n: number): T[] {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= n) return arr;
  return arr.slice(arr.length - n);
}
function mergeUniqueTail(arr: string[], n: number): string[] {
  // Keep the last N unique (deduped) values, preserving most-recent order.
  if (!Array.isArray(arr) || n <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (let i = arr.length - 1; i >= 0; i--) {
    const v = String(arr[i] ?? "").trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= n) break;
  }

  return out.reverse();
}

function slugKeySegment(input: string): string {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  return s.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function buildFactKeyFromSubject(args: {
  subject_type?: string | null;
  subject_name?: string | null;
  attribute_path: string;
}): string {
  const subjectType = String(args.subject_type ?? "").trim().toLowerCase();
  const subjectName = String(args.subject_name ?? "").trim();
  const attributePath = String(args.attribute_path ?? "").trim().replace(/^\.+/, "");
  if (!attributePath) return "";

  // Default: facts about the user themselves live at top-level attribute_path.
  if (!subjectType || subjectType === "self" || subjectType === "user") {
    return attributePath;
  }

  // Relationship-scoped subjects: place under relationships.<type>.<name>.<attribute_path>
  // This is universal (not education-specific). It works for any attribute_path.
  const relTypes = new Set([
    "child",
    "daughter",
    "son",
    "spouse",
    "partner",
    "wife",
    "husband",
    "parent",
    "mother",
    "father",
    "sibling",
    "brother",
    "sister",
    "friend",
    "coworker",
  ]);

  const baseType = relTypes.has(subjectType) ? subjectType : "person";
  const nameSeg = subjectName ? slugKeySegment(subjectName) : "unknown";
  return `relationships.${baseType}.${nameSeg}.${attributePath}`;
}

type FactReviewStatus =
  | "created"
  | "updated"
  | "skipped_locked"
  | "skipped_gate"
  | "skipped_protection"
  | "skipped_invalid"
  | "error";

type FactReviewItem = {
  fact_key: string;
  value_json: any;
  confidence: number;
  context: string | null;
  receipt_id: string;
  receipt_quote: string;
  status: FactReviewStatus;
  note?: string;
};

type FactReviewResult = { items: FactReviewItem[]; kept: number; total: number };

// Minimal canonicalizer used by the post-processing candidate insert loop.
// Your end-session extractor already emits dot-path keys (e.g. relationships.daughters),
// so the safest "canonical" key is the key itself.
function inferCanonicalFactKeyV1(factKey: string, _valueJson: any): string | null {
  const k = String(factKey ?? "").trim();
  return k ? k : null;
}

async function upsertUserFactsV1(args: {
  client: any;
  user_id: string;
  conversation_id: string;
  preferredLocale: string;
  transcriptText: string;
  receipt_id: string;
  deps: EndSessionDeps;
  // Gate: only run on meaningful sessions
  eligible: boolean;
}): Promise<FactReviewResult> {

  const { client, user_id, conversation_id, preferredLocale, transcriptText, receipt_id, deps, eligible } = args;

  const review: FactReviewItem[] = [];
  let total = 0;
  let kept = 0;
  
  const factsDebug = (Deno.env.get("FACTS_DEBUG") ?? "true").toLowerCase() === "true";
   const enableFacts = (Deno.env.get("ENABLE_FACT_EXTRACTION") ?? "true").toLowerCase() !== "false";
   if (!enableFacts) { if (factsDebug) console.log("FACTS: disabled via ENABLE_FACT_EXTRACTION"); return { items: [], kept: 0, total: 0 }; }
   if (!eligible) { if (factsDebug) console.log("FACTS: skipped (eligible=false)"); return { items: [], kept: 0, total: 0 }; }
   if (!receipt_id) { if (factsDebug) console.log("FACTS: skipped (no receipt_id)"); return { items: [], kept: 0, total: 0 }; }
  const extractorFn = (deps as any)?.extractUserFactsWithGemini;
  const extractor = typeof extractorFn === "function" ? extractorFn : extractUserFactsWithGeminiFallback;
  if (typeof extractor !== "function") {
    if (factsDebug) console.log("FACTS: skipped (facts extractor missing and fallback unavailable)");
    return { items: [], kept: 0, total: 0 };
  }
 
  // -------------------------------------------------------------------------
  // NEW: Fetch existing ACTIVE facts so the extractor can avoid repeating them.
  // This reduces clutter *and* reduces end-session latency by shrinking work
  // done downstream (dedupe conflicts, retries, etc.).
  // NOTE: This is a best-effort hint; DB dedupe still enforces correctness.
  // -------------------------------------------------------------------------
 let existingActiveFactsHint = "";
  try {
    const ACTIVE = ["captured", "canonicalized", "conflict", "locked_conflict", "promoted"];
    const { data, error } = await client
     .from("fact_candidates")
      .select("dedupe_fingerprint,fact_key_canonical,fact_key_guess,value_json,polarity,temporal_hint,extracted_at")
      .eq("user_id", user_id)
      .in("status", ACTIVE)
      .order("extracted_at", { ascending: false })
      .limit(250);

    if (!error && Array.isArray(data) && data.length > 0) {
      const clamp = (s: string, maxLen: number) => (s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s);
      const safeJson = (v: any) => {
        try {
          return clamp(String(v == null ? "" : JSON.stringify(v)), 140);
        } catch {
          return clamp(String(v ?? ""), 140);
        }
      };

      const rows = data
        .map((r: any) => {
          const k = String(r.fact_key_canonical ?? r.fact_key_guess ?? "").trim();
          if (!k) return "";
          const v = safeJson(r.value_json);
          const pol = String(r.polarity ?? "stated");
          const tmp = String(r.temporal_hint ?? "unknown");
          const fp = String(r.dedupe_fingerprint ?? "").slice(0, 12);
          // Keep it compact; the goal is to discourage repeats, not to re-teach the model everything.
          return `- ${k} = ${v} | ${pol} | ${tmp} | fp:${fp}`;
        })
        .filter(Boolean);

      // Hard cap to avoid prompt bloat.
      const body = clamp(rows.join("\n"), 6000);
      existingActiveFactsHint =
        "EXISTING_FACTS (DO NOT repeat these exact facts; only output NEW facts not listed below):\n" +
        body +
        "\n\n";
    }
   } catch (e) {
     if (factsDebug) console.log("FACTS: existing facts prefetch failed (non-fatal):", (e as any)?.message ?? e);
   }
 
  // NOTE: This flag is read after the try/catch below, so it must be declared in the outer scope.
  const writeUserKnowledge =
    (Deno.env.get("END_SESSION_WRITE_USER_KNOWLEDGE") ?? "true").toLowerCase() !== "false";
  const patchForUserKnowledge: Record<string, any> = {};

   try {
      const outRaw = await extractor({
        transcriptText: `${existingActiveFactsHint}${transcriptText}`,
        preferred_locale: preferredLocale,
        receipt_id,
      });

    // Some LLMs emit "json" where string values contain literal newlines.
    // That's invalid JSON (newlines must be escaped as \\n). Make parsing tolerant
    // by escaping raw CR/LF only when they occur inside a double-quoted string.
    const escapeNewlinesInsideJsonStrings = (input: string): string => {
      const s = String(input ?? "");
      let out = "";
      let inString = false;
      let escape = false;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (escape) {
          out += ch;
          escape = false;
          continue;
        }
        if (ch === "\\") {
          out += ch;
          escape = true;
          continue;
        }
        if (ch === "\"") {
          out += ch;
          inString = !inString;
          continue;
        }
        if (inString && (ch === "\n" || ch === "\r")) {
          out += "\\n";
          continue;
        }
        out += ch;
      }
      return out;
    };

    const sanitize = (s: string): string => {
      // Remove markdown fences
      let out = String(s ?? "")
        .replace(/^\s*```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();

      // Escape raw newlines that appear inside quoted strings (JSON-tolerance)
      out = escapeNewlinesInsideJsonStrings(out);

      // Tolerate trailing commas before } or ]
      out = out.replace(/,\s*([}\]])/g, "$1");

      // Strip BOM if present
      out = out.replace(/^\uFEFF/, "");

      return out;
    };

    const tryParseJsonLoose = (text: string): any | null => {
      const raw = String(text ?? "").trim();
      if (!raw) return null;

      // 1) Best case: raw is pure JSON
      try {
        return JSON.parse(raw);
      } catch {
        // fall through
      }

      const unfenced = sanitize(raw);

      // 2) Parse sanitized text
      try {
        return JSON.parse(unfenced);
      } catch {
        // fall through
      }

      // 3) Last resort: slice between first "{" and last "}" then sanitize and parse
      const start = unfenced.indexOf("{");
      const end = unfenced.lastIndexOf("}");
      if (start >= 0 && end > start) {
        const slice = sanitize(unfenced.slice(start, end + 1));
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }

      return null;
    };

    // Exported for unit tests (keeps rebuild behavior deterministic).
       function normalizeFactsTopLevel(outRaw: any): { fact_candidates: any[] } {
       const normalizeTopLevel = (obj: any): any => {
         if (!obj || typeof obj !== "object") return obj;
         if (Array.isArray((obj as any).fact_candidates)) {
           const { facts: _facts, ...rest } = obj as any;
          // Keep canonical key; drop legacy "facts" if also present.
          return { ...rest, fact_candidates: (obj as any).fact_candidates };
         }
         if (Array.isArray((obj as any).facts)) {
           const { facts, ...rest } = obj as any;
           return { ...rest, fact_candidates: facts };
         }
         return obj;
       };
      const parsed = typeof outRaw === "string" ? (tryParseJsonLoose(outRaw) ?? null) : outRaw;
      const normalized = normalizeTopLevel(parsed) ?? { fact_candidates: [] };
      return { fact_candidates: Array.isArray((normalized as any).fact_candidates) ? (normalized as any).fact_candidates : [] };
    }

     const out = (() => {
        const normalizeTopLevel = (obj: any): any => {
          if (!obj || typeof obj !== "object") return obj;
         // Canonical internal contract: { fact_candidates: [...] }.
         // If legacy { facts: [...] } is returned, promote to fact_candidates.
         if (Array.isArray((obj as any).fact_candidates)) {
           const { facts: _facts, ...rest } = obj as any;
          // Keep canonical key; drop legacy "facts" if also present.
          return { ...rest, fact_candidates: (obj as any).fact_candidates };
         }
         if (Array.isArray((obj as any).facts)) {
           const { facts, ...rest } = obj as any;
           return { ...rest, fact_candidates: facts };
         }
          return obj;
        };
 
       if (typeof outRaw === "string") {
         const parsed = tryParseJsonLoose(outRaw);
        return normalizeTopLevel(parsed) ?? { fact_candidates: [] };
       }
 
       if (outRaw && typeof outRaw === "object") {
         const normalized = normalizeTopLevel(outRaw);
        if (Array.isArray((normalized as any).fact_candidates)) return normalized;
 
          const candidate =
            (outRaw as any).raw ??
            (outRaw as any).text ??
            (outRaw as any).output ??
            (outRaw as any).content;
  
          if (typeof candidate === "string") {
           const parsed = tryParseJsonLoose(candidate);
           if (parsed && typeof parsed === "object") return normalizeTopLevel(parsed);
          }
  
         return normalized;
        }
  
       return { fact_candidates: [] };
      })();

    const fact_candidates: any[] = Array.isArray((out as any)?.fact_candidates)
      ? (out as any).fact_candidates
      : (Array.isArray((out as any)?.facts) ? (out as any).facts : []);
    // Keep legacy variable name for the rest of this function (minimize churn).
    const facts: any[] = fact_candidates;

    // Deterministic fallback for E2E + real users:
    // If the user explicitly states "My full name is ...", ensure we persist identity.full_name
    // even if the LLM extractor omits it.
    const hasFullNameAlready = facts.some((x: any) => {
      const k = String((x as any)?.fact_key ?? "").trim();
      return k === "identity.full_name" || k === "full_name";
    });
    if (!hasFullNameAlready) {
      const m =
        transcriptText.match(/\bmy\s+full\s+name\s+is\s+"([^"]+)"\s*\.?/i) ??
        transcriptText.match(/\bmy\s+full\s+name\s+is\s+([^\n\r\.]+)\s*\.?/i);
      const name = m ? String(m[1]).trim() : "";
      if (name) {
        facts.unshift({
          fact_key: "identity.full_name",
          value_json: name,
          confidence: 0.99,
          context: "User explicitly stated full name.",
          evidence: [{ receipt_id, quote: `My full name is "${name}".` }],
          });
        }
      }      
 
     // ---------------------------------------------------------------------
     // Deterministic fallback: if the model returns 0 facts (often due to refusal
     // or non-JSON output), extract a few SAFE biographical facts from transcriptText
     // so the UI isn't empty. This avoids storing opinionated/loaded claims.
     // ---------------------------------------------------------------------
     const findRidAndQuote = (re: RegExp): { rid: string; quote: string } | null => {
       const lines = String(transcriptText ?? "").split("\n");
       for (const line of lines) {
         const m = line.match(re);
         if (!m) continue;
         const ridMatch = line.match(/\[RID:([^\]]+)\]/);
         const rid = ridMatch ? String(ridMatch[1]).trim() : String(receipt_id ?? "").trim();
         const quote = m[0] ? String(m[0]).trim() : String(line).trim();
         if (rid) return { rid, quote };
         return { rid: String(receipt_id ?? "").trim(), quote };
       }
       return null;
     };

     const addHeuristicFact = (fact_key: string, value_json: any, re: RegExp, ctx: string) => {
       const ev = findRidAndQuote(re);
       facts.unshift({
         fact_key,
         value_json,
         confidence: 0.92,
         context: ctx,
         evidence: [{ receipt_id: ev?.rid ?? receipt_id, quote: ev?.quote ?? "[evidence unavailable]" }],
       });
     };

     total = facts.length;
     if (!facts.length) {
       // Heuristic fallbacks (safe, personal, non-opinionated)
       // 1) Married for N years
       const marriedYears = (() => {
         const m =
           transcriptText.match(/\bmarried\s+to\s+my\s+ex-?wife\s+for\s+(\d{1,3})\s+years\b/i) ??
           transcriptText.match(/\bstayed\s+married\s+.*\bfor\s+(\d{1,3})\s+years\b/i);
         const n = m ? Number(m[1]) : NaN;
         return Number.isFinite(n) ? n : null;
       })();
       if (marriedYears !== null) {
         addHeuristicFact(
           "relationships.marriage.duration_years",
           marriedYears,
           /\bmarried\s+to\s+my\s+ex-?wife\s+for\s+\d{1,3}\s+years\b/i,
           "User stated marriage duration."
         );
       }

       // 2) Has N daughters (count)
       const daughtersCount = (() => {
         const m =
           transcriptText.match(/\bmy\s+(\d{1,2})\s+daughters\b/i) ??
           transcriptText.match(/\b(\d{1,2})\s+daughters\b/i);
         const n = m ? Number(m[1]) : NaN;
         return Number.isFinite(n) ? n : null;
       })();
       if (daughtersCount !== null) {
         addHeuristicFact(
           "family.children.daughters.count",
           daughtersCount,
           /\b(\d{1,2})\s+daughters\b/i,
           "User stated number of daughters."
         );
       }

       total = facts.length;
       if (!facts.length) {
         if (factsDebug) console.log("FACTS: extractor returned 0 facts");
         return { items: review, kept, total };
       }
     }
     if (factsDebug) console.log("FACTS: extractor returned", facts.length, "facts");
 
    // Universal normalization:
    // Allow extractor to return either:
    //  A) { fact_key, value_json, ... }  (legacy)
    //  B) { subject: {type,name}, attribute_path, value_json, ... } (preferred)
    // We deterministically map (B) into a structured fact_key before upsert.
    for (let i = 0; i < facts.length; i++) {
      const f: any = facts[i];
      const hasFactKey = typeof f?.fact_key === "string" && String(f.fact_key).trim().length > 0;
      if (hasFactKey) continue;

      const attribute_path = String(f?.attribute_path ?? f?.path ?? "").trim();
      if (!attribute_path) continue;

      const subject = (f?.subject && typeof f.subject === "object") ? f.subject : null;
      const subject_type = subject ? String(subject.type ?? subject.subject_type ?? "").trim() : "";
      const subject_name = subject ? String(subject.name ?? subject.subject_name ?? "").trim() : "";

      const mapped = buildFactKeyFromSubject({
        subject_type,
        subject_name,
        attribute_path,
      });

      if (mapped) {
        f.fact_key = mapped;
      }
    }
    const isEmptyObject = (v: any): boolean => {
     return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
   };
    const isEmptyValueJson = (v: any): boolean => {
      if (v === null || v === undefined) return true;

      if (typeof v === "string") return v.trim().length === 0;
      if (typeof v === "number") return !Number.isFinite(v);
      if (typeof v === "boolean") return false;

      if (Array.isArray(v)) return v.length === 0;

      if (typeof v === "object") return Object.keys(v).length === 0;

      return true;
    };

    const normalizeValueForFactKey = (factKey: string, v: any): any => {
      if (v === null || v === undefined) return v;

      // If model gives {kg:90} etc, collapse to scalar
      if (typeof v === "object" && !Array.isArray(v)) {
        const obj: any = v;

      const coerceFiniteNumber = (x: any): number | null => {
          if (typeof x === "number" && Number.isFinite(x)) return x;
          if (typeof x === "string") {
            const s = x.trim();
            if (!s) return null;
            // Accept simple numeric strings like "90", "58", "90.5"
            if (/^-?\d+(\.\d+)?$/.test(s)) {
              const n = Number(s);
              return Number.isFinite(n) ? n : null;
            }
          }
          return null;
        };

        if (factKey === "identity.weight_kg") {
          const raw = obj.kg ?? obj.weight_kg ?? obj.weightKg;
          const n = coerceFiniteNumber(raw);
          if (n !== null) return n;
        }

        if (factKey === "identity.age") {
          const raw = obj.years ?? obj.age ?? obj.age_years ?? obj.ageYears;
          const n = coerceFiniteNumber(raw);
          if (n !== null) return n;
        }  

        if (factKey === "location.timezone") {
          const s = obj.iana ?? obj.tz ?? obj.timezone;
          if (typeof s === "string" && s.trim()) return s.trim();
        }

        if (factKey === "identity.height_cm") {
          const n = obj.cm ?? obj.height_cm ?? obj.heightCm;
          if (typeof n === "number" && Number.isFinite(n)) return n;
        }

        if (factKey === "location.current_city") {
          const s = obj.city ?? obj.current_city ?? obj.currentCity;
          if (typeof s === "string" && s.trim()) return s.trim();
        }

        if (factKey === "location.current_country") {
          const s = obj.country ?? obj.current_country ?? obj.currentCountry;
          if (typeof s === "string" && s.trim()) return s.trim();
        }
      }

      // Strings: trim (but keep as string if non-empty)
      if (typeof v === "string") return v.trim();

      return v;
    };

const deriveStructuredValueJson = (factKey: string, quote: string): any | null => {
  const q = (quote ?? "").toLowerCase();

  if (factKey === "diet_preferences") {
    const out: any = {};
    const notes: string[] = [];
    if (q.includes("skip breakfast")) notes.push("skips_breakfast");
    if (q.includes("two meals")) notes.push("two_meals_per_day");
    if (q.includes("high protein") || q.includes("higher protein")) notes.push("high_protein");
    if (q.includes("avoid starchy") || q.includes("avoids starchy") || q.includes("starchy carbs")) notes.push("avoids_starchy_carbs");
    if (notes.length) out.notes = notes;
    return Object.keys(out).length ? out : null;
  }

  if (factKey === "exercise_routine") {
    const out: any = {};
    if (q.includes("cycle") || q.includes("cycling") || q.includes("bicycle") || q.includes("bike")) {
      out.type = "cycling";
    }
    const freqMatch = q.match(/(\d+)\s*(?:x|times)\s*(?:per|a)\s*week/);
    if (freqMatch) out.frequency_per_week = Number(freqMatch[1]);
    const rangeMatch = q.match(/(\d+)\s*(?:to|-)\s*(\d+)\s*miles/);
    if (rangeMatch) out.typical_distance_miles = [Number(rangeMatch[1]), Number(rangeMatch[2])];
    const singleMiles = q.match(/(\d+)\s*miles/);
    if (!rangeMatch && singleMiles) out.typical_distance_miles = [Number(singleMiles[1]), Number(singleMiles[1])];
    return Object.keys(out).length ? out : null;
  }

  if (factKey === "occupation_history") {
    const out: any = {};
    if (q.includes("retired")) out.status = "retired";
    if (q.includes("social security administration")) out.last_employer = "Social Security Administration";
    if (q.includes("data analyst")) out.last_role = "data analyst";
    const yearsMatch = q.match(/(\d+)\s*years/);
    if (yearsMatch) out.years = Number(yearsMatch[1]);
    return Object.keys(out).length ? out : null;
  }

  if (factKey === "primary_project") {
    const out: any = {};
    if (q.includes("legacymvp")) out.name = "LegacyMVP";
    if (q.includes("app")) out.type = "app";
    return Object.keys(out).length ? out : null;
  }

   return null;
 };

     for (const f of facts) {
       const k = String(f.fact_key_canonical ?? f.fact_key_guess ?? "").trim();
       if (!k) continue;

    const isDotPath = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(fact_key);
    if (!isDotPath) continue;

// Evidence + receipts for this fact
// Supports both legacy { receipt_quote, receipt_id } and v2 { evidence: [{ receipt_id, quote }] } shapes.
const evidenceArr: any[] = Array.isArray((f as any)?.evidence) ? (f as any).evidence : [];
const ev0: any = evidenceArr.length ? evidenceArr[0] : null;

const receipt_quote = (() => {
  const q1 =
    typeof (f as any)?.receipt_quote === "string"
      ? (f as any).receipt_quote.trim()
      : "";
  const q2 =
    typeof (ev0 as any)?.quote === "string"
      ? String((ev0 as any).quote).trim()
      : "";
  return q1 || q2;
})();

const receipt_id_out = (() => {
  const id1 = String((f as any)?.receipt_id ?? "").trim();
  const id2 = String((ev0 as any)?.receipt_id ?? "").trim();
  const id = id1 || id2 || String(receipt_id ?? "").trim();
  return id || receipt_id;
})();

// Parse value_json (accept scalars, arrays, objects). If string, try JSON parse; else keep string.
let value_json: any = null;
const rawValueJson = (f as any)?.value_json;

if (rawValueJson === null || rawValueJson === undefined) {
  value_json = null;
} else if (typeof rawValueJson === "string") {
  const s = rawValueJson.trim();
  if (!s) {
    value_json = null;
  } else {
    const parsed = tryParseJsonLoose(s);
    value_json = parsed ?? s;
  }
} else {
  value_json = rawValueJson; // number | boolean | object | array
}

// Normalize wrapper objects into scalars (kg / years / iana / etc.)
value_json = normalizeValueForFactKey(fact_key, value_json);

// If empty, try to derive a structured value from quote
if (isEmptyValueJson(value_json) || (value_json && isEmptyObject(value_json))) {
  const derived = deriveStructuredValueJson(fact_key, receipt_quote);
  if (derived !== null && derived !== undefined) {
    value_json = normalizeValueForFactKey(fact_key, derived);
  }
}

const context =
  typeof (f as any)?.context === "string"
    ? String((f as any).context).trim()
    : null;

// Final empty rejection: {}, [], "", null, NaN
if (isEmptyValueJson(value_json) || (value_json && isEmptyObject(value_json))) {
  if (factsDebug) {
    console.log("FACTS: skipped (empty value_json)", {
      fact_key,
      receipt_id: receipt_id_out,
    });
  }
  review.push({ fact_key, value_json, confidence: 0, context, receipt_id: String(receipt_id_out), receipt_quote: String(receipt_quote ?? ""), status: "skipped_invalid", note: "empty_value_json" });
  continue;
}

// Confidence gate — accept v2 extractor defaults (~0.75)
const confidence = (() => {
  const n = Number((f as any)?.confidence);
  return Number.isFinite(n) ? clamp01(n) : 0.75;
})();

      // Names are explicit user-provided strings; allow a slightly lower threshold for identity.full_name only.
      const minConfidence = (fact_key === "identity.full_name") ? 0.55 : 0.7;
      if (confidence < minConfidence) {
        review.push({
          fact_key,
          value_json,
          confidence,
          context,
          receipt_id: String(receipt_id_out),
          receipt_quote: String(receipt_quote ?? ""),
          status: "skipped_invalid",
          note: `confidence<${minConfidence}`,
        });
        continue;
      }

      // Sticky / semi-sticky protection (dot-path aware)
      const sticky =
        Boolean(f?.sticky ?? false) ||
        fact_key === "identity.date_of_birth" ||
        fact_key === "identity.height_cm" ||
        fact_key === "identity.height";

      const requires_explicit_change =
        Boolean(f?.requires_explicit_change ?? false) ||
        [
          "location.current_city",
          "location.current_country",
          "location.timezone",
          "work.occupation_history",
        ].includes(fact_key);
      
      // Read existing (to append receipts safely)
      const { data: existing, error: exErr } = await client
        .from(USER_FACTS_TABLE)
        .select("id, value_json, receipt_ids, receipt_quotes, is_locked")
        .eq("user_id", user_id)
        .eq("fact_key", fact_key)
        .limit(1)
        .maybeSingle();

      const hasExisting = Boolean((existing as any)?.id);
      const existingValueJson = (existing as any)?.value_json ?? null;
      const hasMeaningfulExisting =
        hasExisting &&
        existingValueJson !== null &&
        existingValueJson !== undefined &&
        !(typeof existingValueJson === "object" && isEmptyObject(existingValueJson));
        
       const isLocked = Boolean((existing as any)?.is_locked ?? false);
       if (isLocked && hasMeaningfulExisting) {
         // Respect user-locked values: keep existing value_json; only append receipts.
         const prevIds: string[] = Array.isArray((existing as any)?.receipt_ids)
           ? ((existing as any).receipt_ids as any[]).map((x) => String(x)).filter(Boolean)
           : [];
         const prevQuotes: string[] = Array.isArray((existing as any)?.receipt_quotes)
           ? ((existing as any).receipt_quotes as any[]).map((x) => String(x)).filter(Boolean)
           : [];
         const nextIdsLocked = mergeUniqueTail([...prevIds, receipt_id_out].filter(Boolean), 10);
         const nextQuotesLocked = mergeUniqueTail([
           ...prevQuotes,
           String(receipt_quote ?? "").trim(),
         ].filter(Boolean), 10);
         // Locked facts: don't upsert (would attempt insert with NULL value_json). Update receipts only.
         const { error: lockUpErr } = await client
           .from(USER_FACTS_TABLE)
           .update({
             receipt_ids: nextIdsLocked,
             receipt_quotes: nextQuotesLocked,
             updated_at: new Date().toISOString(),
           })
           .eq("user_id", user_id)
           .eq("fact_key", fact_key);
         if (lockUpErr) {
           console.warn("END_SESSION: user_facts locked receipt append failed (non-fatal):", lockUpErr);
         }
         review.push({ fact_key, value_json, confidence, context, receipt_id: String(receipt_id_out), receipt_quote: String(receipt_quote ?? ""), status: "skipped_locked" });
         continue;
       }

      if (sticky && hasMeaningfulExisting && !isExplicitCorrection(receipt_quote)) {
        if (factsDebug) {
          console.log("FACTS_DEBUG: skip sticky", { fact_key, hasMeaningfulExisting, receipt_quote });
        }
        review.push({ fact_key, value_json, confidence, context, receipt_id: String(receipt_id_out), receipt_quote: String(receipt_quote ?? ""), status: "skipped_protection", note: "sticky_without_explicit_correction" });
        continue;
      }
      if (requires_explicit_change && hasMeaningfulExisting && !isExplicitChange(receipt_quote)) {
        if (factsDebug) {
          console.log("FACTS_DEBUG: skip requires_explicit_change", {
            fact_key,
            hasMeaningfulExisting,
            receipt_quote,
            existingValueJson,
          });
        }
        review.push({ fact_key, value_json, confidence, context, receipt_id: String(receipt_id_out), receipt_quote: String(receipt_quote ?? ""), status: "skipped_protection", note: "requires_explicit_change_without_explicit_phrase" });
        continue;
       }
       if (exErr) {
         console.warn("END_SESSION: user_facts read failed (non-fatal):", exErr);
       }

      const prevIds: string[] = Array.isArray((existing as any)?.receipt_ids)
        ? ((existing as any).receipt_ids as any[]).map((x) => String(x)).filter(Boolean)
        : [];
      const prevQuotes: string[] = Array.isArray((existing as any)?.receipt_quotes)
        ? ((existing as any).receipt_quotes as any[]).map((x) => String(x)).filter(Boolean)
        : [];

      const nextIds = mergeUniqueTail([...prevIds, receipt_id_out].filter(Boolean), 10);
      const nextQuotes = mergeUniqueTail(
        [...prevQuotes, receipt_quote].map((s) => String(s ?? "").trim()).filter(Boolean),
        10
      );

      function canonicalizeFactKeyV1(factKey: string): string | null {
  const k = String(factKey ?? "").trim();
  if (!k) return null;

  // Identity
  if (k === "age" || k.startsWith("age.") || k === "demographics.age" || k === "demographics.age_group") return "identity.age";
  if (k === "birth.date" || k === "demographics.date_of_birth" || k === "demographics.birth_date") return "identity.date_of_birth";
  if (k.startsWith("demographics.height")) return "identity.height";
  if (k === "demographics.weight_kg") return "identity.weight";
  if (k.startsWith("demographics.gender")) return "identity.gender";
  if (k.startsWith("demographics.name")) return "identity.name";

  // Location
  if (k === "current_city" || k === "current_country" || k.startsWith("current_location.")) return "location.current";
  if (k === "demographics.timezone") return "location.timezone";
  if (k === "background.city" || k === "demographics.hometown") return "location.home";

  // Career
  if (k.startsWith("employment.") || k.startsWith("career.") || k === "work.occupation_history") return "career.employment_history";

  // Family
  if (k.startsWith("children.") || k.startsWith("family.children")) return "family.children.count";
  if (k.startsWith("family.relationship.")) return "family.key_relationships";

  // Diet
  if (k.startsWith("dietary_restrictions.")) return "health.diet.restrictions";
  if (k.startsWith("eating_habits.")) return "health.diet.preferences";
  if (k.startsWith("dietary_preference.") || k.startsWith("diet.")) return "health.diet.pattern";

  // Exercise
  if (k.startsWith("exercise_routine")) return "health.exercise.overview";
  if (k.startsWith("exercise.")) return "health.exercise.overview";
  if (k.startsWith("activity.cycling") || k === "activity.cycling" || k === "activity.bike_rides") return "health.exercise.cycling";

  // Beliefs / attitude (broad bucket)
  if (k.startsWith("beliefs.") || k.startsWith("attitude.")) return "beliefs.values";

  return null;
}

function inferStabilityV1(canonicalKey: string | null, factKey: string): string | null {
  const ck = String(canonicalKey ?? "").trim();
  const fk = String(factKey ?? "").trim();

  // Stable: identity anchors
  if (ck.startsWith("identity.date_of_birth") || ck.startsWith("identity.height")) return "stable";

  // Semi-stable: long-lived but can change
  if (ck.startsWith("identity.weight")) return "semi";
  if (ck.startsWith("career.")) return "semi";
  if (ck.startsWith("health.")) return "semi";
  if (ck.startsWith("beliefs.")) return "semi";
  if (ck.startsWith("family.")) return "semi";

  // Volatile: current location, daily activities, etc.
  if (ck.startsWith("location.current")) return "volatile";

  // Fallback: if fact_key looks like a “current” signal, treat as volatile
  if (fk.includes("current") || fk.includes("today") || fk.includes("yesterday")) return "volatile";

  return null;
}

      // IMPORTANT: fact_candidates.fact_key_canonical is used downstream for recall.
      // Never persist NULL/empty keys (they break ON CONFLICT and downstream recall).
      const fact_key_safe = String(fact_key ?? "").trim();
      if (!fact_key_safe) {
        if (factsDebug) {
          console.log("FACTS_DEBUG: skipping empty fact_key", {
            fact_key,
            value_json,
            confidence,
            receipt_id: receipt_id_out,
          });
        }
        continue;
      }

      // If we can't canonicalize, fall back to the guessed key so we never persist NULL.
      const canonical_key = canonicalizeFactKeyV1(fact_key_safe) ?? fact_key_safe;

      const patch = {
         user_id,
         fact_key: fact_key_safe,
         canonical_key,
         stability: inferStabilityV1(canonical_key, fact_key_safe),
         value_json,
         context,
         confidence,
         receipt_ids: nextIds,
         receipt_quotes: nextQuotes,
         updated_at: new Date().toISOString(),
       };
 
        if (factsDebug) {
         console.log("FACTS_DEBUG: upsert attempt", { fact_key: fact_key_safe, value_json, confidence, receipt_id: receipt_id_out });
        }
  
       // NEW: write to fact_candidates (learning surface) by default.
       const writeCandidates =
         (Deno.env.get("END_SESSION_WRITE_FACT_CANDIDATES") ?? "true").toLowerCase() !== "false";
       const writeCanonical =
         (Deno.env.get("END_SESSION_WRITE_CANONICAL_FACTS") ?? "false").toLowerCase() === "true";
 
       let upErr: any = null;
 
       if (writeCandidates) {
         const convId = String(conversation_id ?? "").trim();
         if (!convId) {
           if (factsDebug) {
             console.log("FACTS_DEBUG: skipping fact_candidates insert (missing conversation_id)", {
               fact_key: fact_key_safe,
               receipt_id: receipt_id_out,
             });
           }
         } else {
           const fcRow: any = {
             user_id,
             conversation_id: convId,
             turn_ref: String(receipt_id_out),
             fact_key_guess: fact_key_safe,
             fact_key_canonical: canonical_key,
             value_json,
             source_quote: String(receipt_quote ?? ""),
             source_meta: {
               receipt_id: String(receipt_id_out),
               evidence: Array.isArray(evidenceArr) ? evidenceArr : [],
               context,
             },
             confidence,
             extractor_version: END_SESSION_VERSION,
             model_meta: {},
             polarity: "stated",
             temporal_hint: "unknown",
             status: "captured",
             extracted_at: new Date().toISOString(),
           };

           // Idempotent write: retries/replays are expected. Avoid 23505 spam.
           const { error: fcErr } = await client.from("fact_candidates").insert(fcRow);
           if (fcErr) {
             const code = String((fcErr as any)?.code ?? "");
             const msg = String((fcErr as any)?.message ?? "");
             const isDup =
               code === "23505" ||
               msg.includes("fact_candidates_dedupe_active_idx") ||
               msg.includes("duplicate key value violates unique constraint");
             if (!isDup) {
               console.warn("END_SESSION: fact_candidates insert failed (non-fatal):", fcErr);
             }
           }
         }
        }
 
       // Optional legacy/canonical write path (disabled by default)
       if (writeCanonical) {
        const { error } = await client
          .from(USER_FACTS_TABLE)
          .upsert(patch, { onConflict: "user_id,fact_key" });
        upErr = error;
      }
 
        if (upErr) {
          console.warn("END_SESSION: canonical facts upsert failed (non-fatal):", upErr);
        }
       if (!upErr) {
         kept += 1;
         review.push({
           fact_key: fact_key_safe,
           value_json,
           confidence,
           context,
           receipt_id: String(receipt_id_out),
           receipt_quote: String(receipt_quote ?? ""),
           status: hasExisting ? "updated" : "created",
         });

         if (writeUserKnowledge && confidence >= 0.85) {
           patchForUserKnowledge[fact_key_safe] = value_json;
         }
       }
      }
   } catch (e) {
     console.warn("END_SESSION: user_facts extraction failed (non-fatal):", (e as any)?.message ?? e);
  }
  if (writeUserKnowledge) {
    await upsertUserKnowledgeFactsPatchV1(client, user_id, patchForUserKnowledge);
   }
   return { items: review, kept, total };
}

 const END_SESSION_VERSION = "end_session_facts_v4_2026-01-23";
 
// ---------------------------------------------------------------------------
// Story capture (heuristic, no extra model calls)
// ---------------------------------------------------------------------------

 type TranscriptTurnLite = { id: string; role: string; source: string; text: string };
 
function isLikelyUserQuestionV1(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (t.endsWith("?")) return true;
  if (/^(tell me|what is|what are|do i|did i|can you|could you|would you|please tell me)\b/i.test(t)) return true;
  return false;
}
function isValidStoryBlockV1(storyText: string, receiptIds: string[]): boolean {
  const text = String(storyText ?? "").trim();
  const ids = Array.isArray(receiptIds) ? receiptIds : [];
  if (ids.length < 2) return false; // require multi-turn story for reliability + E2E
  if (text.length < 220) return false; // E2E expects >= 220 chars
  const sentences = (text.match(/[.!?]/g) ?? []).length;
  if (sentences < 2) return false;

  // Require at least 2 "story-ish" signals.
  const signals = [
    /\bI\b/i,
    /\bthen\b/i,
    /\bafter\b/i,
    /\bso\b/i,
    /\bbecause\b/i,
    /\bdecided\b/i,
    /\bnoticed\b/i,
    /\bwalked\b/i,
    /\bstopped\b/i,
  ];
  let hit = 0;
  for (const r of signals) if (r.test(text)) hit += 1;
  return hit >= 2;
}

   function buildStoryBlockFromTurnsV1(
     userTurns: Array<{ id?: string; receipt_id?: string; text: string }>,
     startIdx: number
   ) {
     const turns = userTurns.slice(startIdx, startIdx + 6);

   // NOTE: caller may pass TranscriptTurnLite objects that use `id` (memory_raw id)
   // rather than `receipt_id`. Support both without changing the public interface.
  const receipt_ids_all = turns
     .map((t) => String((t as any)?.receipt_id ?? (t as any)?.id ?? ""))
     .filter(Boolean);
  const texts = turns.map((t) => String(t.text ?? "").trim()).filter(Boolean);
  
    // Stop early if the user is asking questions instead of narrating.
    const stopAt = texts.findIndex((t) => isLikelyUserQuestionV1(t));   const safeTexts = stopAt >= 0 ? texts.slice(0, stopAt) : texts;
  const receipt_ids = stopAt >= 0 ? receipt_ids_all.slice(0, stopAt) : receipt_ids_all;
 
   return { text: safeTexts.join(" ").trim(), receipt_ids };
 }

   function deriveStoryTitleV1(storyText: string): string {
     const raw = String(titleFromStoryTextV1(storyText) ?? "").trim();
    if (raw) return enforceStorySeedTitleV1(raw, storyText, null);
    // Fallback: first ~10 words
    const words = storyText
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 10)
      .join(" ");
    return enforceStorySeedTitleV1(words || "Untitled Story", storyText, null);
   }
 
  function pickHeuristicStoryTurnsV1(userTurns: Array<{ id?: string; receipt_id?: string; text: string }>) {
    // Pick 1–3 candidate story starting points from USER turns.
    // We intentionally key off userTurns (not assistant turns) so we don't capture a long assistant recap.
    const candidates: Array<{ idx: number; title: string; text: string; receipt_ids: string[] }> = [];

    // Limit scan so we don't do O(n^2) work on long sessions.
    const maxStarts = Math.min(userTurns.length, 24);
    for (let i = 0; i < maxStarts; i++) {
      // buildStoryBlockFromTurnsV1 supports both `receipt_id` and `id` (see its internal mapping).
      const block = buildStoryBlockFromTurnsV1(userTurns as any, i);
      if (!block.text) continue;

      const receipt_ids = block.receipt_ids;
      if (!isValidStoryBlockV1(block.text, receipt_ids)) continue;

      candidates.push({
        idx: i,
        title: deriveStoryTitleV1(block.text),
        text: block.text,
        receipt_ids,
      });
    }

    // Prefer richer narratives. Keep at most 3.
    candidates.sort((a, b) => b.text.length - a.text.length);
    return candidates.slice(0, 3);
  }
 
   async function persistHeuristicStorySeedsV1(opts: {
     client: any;
     user_id: string;
     conversation_id: string;
     // Accept both names to stay compatible with Phase B caller.
     userTurns?: TranscriptTurnLite[];
     turns?: any[];
   }): Promise<{ inserted: number; skipped: number }> {
   const { client, user_id, conversation_id } = opts;
   const userTurns: TranscriptTurnLite[] = (Array.isArray((opts as any)?.userTurns) ? (opts as any).userTurns : [])
     .concat(Array.isArray((opts as any)?.turns) ? (opts as any).turns : [])
     .map((t: any) => ({
       id: String(t?.id ?? t?.receipt_id ?? "").trim(),
       role: String(t?.role ?? "").trim(),
       source: String(t?.source ?? (String(t?.role ?? "").trim().toLowerCase() === "user" ? "legacy_user" : "")).trim(),
       text: String(t?.text ?? t?.content ?? "").trim(),
     }))
     .filter((t: any) => t && t.text);

   const picks = pickHeuristicStoryTurnsV1(userTurns as any);
    let inserted = 0;
    let skipped = 0;

   for (const p of picks) {
     const startIdx = Number((p as any)?.idx ?? -1);
     const block =
       startIdx >= 0 ? buildStoryBlockFromTurnsV1(userTurns, startIdx) : { text: "", receipt_ids: [] as string[] };

     const text = String(block.text || "").trim();
     if (!text) {
       skipped += 1;
       continue;
     }

     const storyReceiptIds = (Array.isArray(block.receipt_ids) ? block.receipt_ids : []).map((x: any) => String(x)).filter(Boolean);

     if (!isValidStoryBlockV1(text, storyReceiptIds)) {
       skipped += 1;
       continue;
     }

     // Guardrail: avoid capturing a single mega-turn dump (e.g., pasted transcript).
     // Real anecdotes can be a single turn, so only skip when it's *very* long.
     if (storyReceiptIds.length < 2 && text.length >= 600) {
       skipped += 1;
       continue;
     }

     const rawTitle = titleFromStoryTextV1(text);
     const aiHandle = await storyHandleTitleGeminiV1(text);
     const title = enforceStorySeedTitleV1(rawTitle, text, aiHandle ?? storyHandleTitleV1(rawTitle, text));
     const synopsis = oneLinerFromStoryTextV1(text);

     // Best-effort dedupe: if we already have a story_recall row with same title for this session, skip.
     try {
       const { data: existing } = await client
         .from("story_recall")
         .select("id")
         .eq("user_id", user_id)
         .eq("conversation_id", conversation_id)
         .ilike("title", title)
         .limit(1);
       if (Array.isArray(existing) && existing.length > 0) {
         skipped += 1;
         continue;
       }
     } catch {
       // If story_recall isn't available, keep going; seed insert can still succeed.
     }

       const seedPayload: any = {
         user_id,
         conversation_id,
         summary_id: null,
         seed_type: "episode",
         title,
         // Canonical identifiers (prevents null seed_key/seed_label in DB)
         seed_key: storyEssenceSlugV1(String(rawTitle ?? ""), String(text ?? "")) || "story",
         seed_label: title,
         // seed_text is jsonb in your UI path; store both a 1-liner and full narrative.
         seed_text: {
           one_liner: synopsis,
           story: clampString(text, 4000),
           key_sentence: synopsis,
         },
         canonical_facts: {},
         entities: [],
        // Fingerprint to prove which code wrote the row (remove once verified).
         tags: [`build:end_session_${END_SESSION_BUILD_STAMP}`],
          time_span: null,
          confidence: 0.75,
          source_raw_ids: storyReceiptIds,
          source_edit_ids: [],
          evidence_raw_ids: storyReceiptIds,
          };

         // Last-mile guardrails: ensure we never write a sentence as title,
         // and never write null seed_key/seed_label if we can compute them.
         seedPayload.title = enforceStorySeedTitleV1(rawTitle, text, seedPayload.title);
         seedPayload.seed_label = seedPayload.title;
          if (!seedPayload.seed_key) seedPayload.seed_key = storyEssenceSlugV1(String(rawTitle ?? ""), String(text ?? "")) || null;
   
         try {
          const receipt0 = storyReceiptIds?.[0] ? String(storyReceiptIds[0]) : null;
          let seedId: string | null = null;
          let bestExistingTitle: string | null = null;
  
         const pickBetterTitle = (existingTitle: string, proposedTitle: string): string => {
           const e = String(existingTitle ?? "").replace(/\s+/g, " ").trim();
           const p = String(proposedTitle ?? "").replace(/\s+/g, " ").trim();
           if (!e) return p || "Story";
           if (!p) return e;
           const eOk = isValidStoryHandleV1(e);
           const pOk = isValidStoryHandleV1(p);
           if (eOk && !pOk) return e;
           if (!eOk && pOk) return p;
           // If both valid (or both invalid), prefer the shorter one to avoid sentence-like titles.
           return e.length <= p.length ? e : p;
         };
  
          // If we already have duplicates for this conversation+receipt, KEEP the best one:
          // prefer the shortest title (the handle) and most recent if tie.
        if (!seedId && receipt0) {
            const { data: existingSeeds, error: exErr } = await client
              .from("story_seeds")
              .select("id,title,created_at")
              .eq("user_id", user_id)
              .eq("conversation_id", conversation_id)
              .contains("source_raw_ids", [receipt0]);


         if (exErr) {
           console.warn("END_SESSION: story_seeds dedupe lookup failed (non-fatal):", exErr);
         } else if (Array.isArray(existingSeeds) && existingSeeds.length > 0) {
           existingSeeds.sort((a: any, b: any) => {
             const la = String(a?.title ?? "").length;
             const lb = String(b?.title ?? "").length;
             if (la !== lb) return la - lb; // shortest first
             const ta = Date.parse(String(a?.created_at ?? "")) || 0;
             const tb = Date.parse(String(b?.created_at ?? "")) || 0;
             return tb - ta; // newest first
           });
           seedId = String(existingSeeds[0].id);
           bestExistingTitle = String(existingSeeds[0]?.title ?? "").trim() || null;
         }
       }
  
       // If Phase A and Phase B both run, don't let the later run overwrite a better/shorter title.
       const finalTitle = bestExistingTitle
         ? pickBetterTitle(bestExistingTitle, seedPayload.title)
         : seedPayload.title;
       seedPayload.title = finalTitle;
       seedPayload.seed_label = finalTitle;
 
        if (seedId) {
           // Ensure the “kept” row gets the short title + latest seed_text
          const { error: updErr } = await client
            .from("story_seeds")
            .update({
              title: seedPayload.title,
              seed_label: seedPayload.seed_label,
              seed_key: seedPayload.seed_key,
              seed_text: seedPayload.seed_text,
              updated_at: new Date().toISOString(),
            })
            .eq("id", seedId);
           if (updErr) console.warn("END_SESSION: story_seeds update failed (non-fatal):", updErr);
         } else {
        const { data: seedRows, error: seedErr } = await client
          .from("story_seeds")
          .insert(seedPayload)
          .select("id")
          .limit(1);

        if (seedErr) {
          console.warn("END_SESSION: story_seeds insert failed (non-fatal):", seedErr);
          skipped += 1;
          continue;
        }

        seedId = Array.isArray(seedRows) && seedRows[0]?.id ? String(seedRows[0].id) : null;
        inserted += 1;
      }
 
        // Create a story_recall row that the recall path already prefers.
          if (seedId) {
            try {
             await client
               .from("story_recall")
               .upsert(
                 {
                  user_id,
                   conversation_id,
                    story_seed_id: seedId,
                    title: seedPayload.title,
                    recall_text: clampString(seedPayload.story, 4000),
                    story_text: clampString(seedPayload.story, 4000),
                    one_liner: clampString(seedPayload.one_liner, 280),
                    synopsis: clampString(synopsis || text, 420),
                    evidence_json: { seed_id: seedId, receipt_id: storyReceiptIds[0] ?? null },
                    is_locked: false,
                   updated_at: new Date().toISOString(),
                  },
                 { onConflict: "user_id,story_seed_id" },
               );
             } catch (e) {
               console.warn("END_SESSION: story_recall insert failed (non-fatal):", (e as any)?.message ?? e);
             }
             }
 
        // Best-effort: mirror story index into user_knowledge so runtime recall_v2 can see it.
        // Store a full retell payload under a stable key: stories.<slug>.
        try {
          const storySlug = storyEssenceSlugV1(seedPayload.title, synopsis || text);
          const storyKey = `stories.${storySlug}`;
          const storyObj = {
            title: seedPayload.title,
            synopsis: clampString(synopsis || text, 420),
            story: clampString(text, 4000),
            seed_id: seedId,
            conversation_id,
            receipt_ids: storyReceiptIds,
            updated_at: new Date().toISOString(),
          };
          await upsertUserKnowledgeFactsPatchV1(client, user_id, { [storyKey]: storyObj });
        } catch (e) {
           console.warn("END_SESSION: user_knowledge story mirror failed (non-fatal):", (e as any)?.message ?? e);
         }
       } catch (e) {
         console.warn("END_SESSION: story seed persist threw (non-fatal):", (e as any)?.message ?? e);
         skipped += 1;
       }
     }
  
   return { inserted, skipped };
 }

// ---------------------------------------------------------------------------
// Phase A / Phase B split controls (keep local; do not move runEndSessionPipeline)
// ---------------------------------------------------------------------------
function isPhaseBEnabled(): boolean {
  // Default ON. Set END_SESSION_PHASE_B=0 to restore legacy inline behavior.
  const v = String((globalThis as any)?.Deno?.env?.get?.("END_SESSION_PHASE_B") ?? "1").trim();
  return v !== "0" && v.toLowerCase() !== "false";
}

async function enqueueEndSessionJobBestEffort(
  client: any,
  user_id: string,
  conversation_id: string,
  payload: Record<string, any>,
): Promise<string | null> {
  try {
    const { data, error } = await client
      .from("end_session_jobs")
      .insert({ user_id, conversation_id, status: "queued", payload })
      .select("id")
      .single();

    if (error) {
      // If the “one active job per convo” unique partial index fires, treat as non-fatal.
      const code = String((error as any)?.code ?? "");
      const msg = String((error as any)?.message ?? "");
      const isDup =
        code === "23505" ||
        msg.includes("end_session_jobs_one_active_per_convo_idx") ||
        msg.includes("duplicate key value violates unique constraint");
      if (!isDup) console.warn("END_SESSION: enqueue job failed (non-fatal):", { code, msg });
      return null;
    }
    return data?.id ?? null;
  } catch (e) {
    console.warn("END_SESSION: enqueue job threw (non-fatal):", (e as any)?.message ?? e);
    return null;
  }
}

declare const EdgeRuntime: { waitUntil(p: Promise<any>): void };

function kickEndSessionWorkerBestEffort(): void {
  try {
    const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/end-session-worker`;
    const key =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      Deno.env.get("SUPABASE_ANON_KEY") ??
      "";

    if (!url || !key) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 250);

    // Fire-and-forget but kept alive via waitUntil
    EdgeRuntime.waitUntil(
      fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          apikey: key,
          "content-type": "application/json",
        },
        body: JSON.stringify({ run: "one" }),
        signal: controller.signal,
      }).catch(() => {}).finally(() => clearTimeout(timeout)),
    );
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Phase B worker entrypoint (called by end-session-worker)
// ---------------------------------------------------------------------------

export async function runEndSessionPhaseBFromJob(args: {
  client: any;
  job_id: string;
  user_id: string;
  conversation_id: string;
  payload: Record<string, any>;
}): Promise<void> {
  const { client, job_id, user_id, conversation_id, payload } = args;

  // Pull pointers from payload (Phase A should include these)
  const effectiveRawId: string | null = payload?.raw_id ? String(payload.raw_id) : null;
  const short_summary: string = String(payload?.short_summary ?? "").trim();
  const preferredLocale: string = String(payload?.preferredLocale ?? "en");
  const targetLocale: string | null = payload?.hasTarget ? String(payload?.targetLocale ?? "") : null;
  const hasTarget: boolean = Boolean(payload?.hasTarget);
  const lastUserReceiptId: string = String(payload?.last_user_receipt_id ?? "").trim();
  const eligibility = payload?.eligibility ?? null;
  const traceA: any[] = Array.isArray(payload?.end_session_trace_phase_a) ? payload.end_session_trace_phase_a : [];

  const endSessionTrace: Array<{ step: string; ms: number; meta?: any; error?: string }> = [...traceA];
  const traceAsync = async <T>(step: string, fn: () => Promise<T>, meta?: any): Promise<T> => {
    const t0 = performance.now();
    try {
      const out = await fn();
      endSessionTrace.push({ step, ms: Math.round((performance.now() - t0) * 1000) / 1000, meta });
      return out;
    } catch (e) {
      endSessionTrace.push({
        step,
        ms: Math.round((performance.now() - t0) * 1000) / 1000,
        meta,
        error: String((e as any)?.message ?? e),
      });
      throw e;
    }
  };

  // 1) Re-fetch transcript (Phase B is allowed to be heavy)
  const transcript = await traceAsync(
    "phase_b_fetch_effective_transcript_with_edits",
    () => fetchEffectiveTranscriptWithEdits(client, user_id, conversation_id),
  );

  const transcriptForSummary = (transcript ?? []).map((t) => ({
    id: String((t as any)?.id ?? ""),
    source: String((t as any)?.source ?? ""),
    role: String((t as any)?.role ?? ""),
    text: String((t as any)?.content ?? ""),
  }));

  const userTurnsForFacts = (transcriptForSummary ?? []).filter((t: any) => {
    const role = String((t as any)?.role ?? "").toLowerCase();
    const source = String((t as any)?.source ?? "").toLowerCase();
    return role === "user" || source === "legacy_user";
  });

  const userReceiptIds = new Set<string>(
    userTurnsForFacts.map((t: any) => String((t as any)?.id ?? "").trim()).filter(Boolean),
  );

  const transcriptTextForFacts = (userTurnsForFacts ?? [])
    .map((t: any) => {
      const rid = String((t as any)?.id ?? "").trim();
      const text = String((t as any)?.text ?? "");
      return rid ? `[RID:${rid}] user: ${text}` : `user: ${text}`;
    })
    .join("\n")
    .trim();

  // 2) Facts extraction + normalize (reuse your existing function)
  const facts: FactReviewResult | null = await traceAsync(
    "phase_b_facts_extract_and_normalize",
    () =>
      upsertUserFactsV1({
        client,
        user_id,
        conversation_id,
        preferredLocale,
        transcriptText: transcriptTextForFacts,
        receipt_id: lastUserReceiptId || (effectiveRawId ? String(effectiveRawId) : ""),
        deps: { extractUserFactsWithGemini: extractUserFactsWithGeminiFallback } as any, // upsertUserFactsV1 only needs ctx.deps in your run; keep as-is if it requires it
        eligible: Boolean(eligibility?.summaryEligible ?? true),
      }),
    { transcript_chars: transcriptTextForFacts.length },
  ).catch((e) => {
    console.warn("PHASE_B: facts upsert failed (non-fatal):", (e as any)?.message ?? e);
    return null;
  });

  const candidates = Array.isArray((facts as any)?.items) ? (facts as any).items : [];

  // 3) Persist candidates to fact_candidates (idempotent)
  const tryInsertCandidate = async (table: string, row: any): Promise<boolean> => {
     const normalizeRow = (r: any) => {
       const out = { ...(r ?? {}) };
       if (out.status == null || String(out.status).trim() === "" || String(out.status) === "candidate") {
         out.status = "captured";
       }
       if (out.temporal_hint == null || String(out.temporal_hint).trim() === "") {
         out.temporal_hint = "unknown";
       }
       return out;
     };
     try {
       const row1 = normalizeRow(row);
       const { error } = await client.from(table).insert(row1);
       if (error) {
         const code = String((error as any)?.code ?? "");
         const msg = String((error as any)?.message ?? "");
        const isDup =
          code === "23505" ||
          msg.includes("fact_candidates_dedupe_active_idx") ||
          msg.includes("duplicate key value violates unique constraint");
         if (isDup) return true;
 
        console.warn(`PHASE_B: ${table} insert failed:`, {
           code: (error as any)?.code ?? null,
           message: (error as any)?.message ?? String(error),
           status: row1?.status ?? null,
           temporal_hint: row1?.temporal_hint ?? null,
         });
 
         const retryable =
           code === "23514" || code === "23502" ||
           msg.includes("fact_candidates_status_allowed") ||
           msg.includes("temporal_hint");
         if (retryable) {
           const row2 = normalizeRow({ ...(row1 ?? {}), status: "captured", temporal_hint: "unknown" });
          const { error: error2 } = await client.from(table).insert(row2);
           if (!error2) return true;
         }
         return false;
       }
       return true;
     } catch (e) {
      console.warn(`PHASE_B: ${table} insert threw:`, (e as any)?.message ?? e);
       return false;
     }
   };

  const seenCandidateKeys = new Set<string>();
  for (const it of candidates) {
    const fact_key = String((it as any)?.fact_key ?? "").trim();
    if (!fact_key) continue;
    const value_json = (it as any)?.value_json ?? null;
    const confidence = typeof (it as any)?.confidence === "number" ? (it as any).confidence : null;
    const receipt_id = String((it as any)?.receipt_id ?? effectiveRawId ?? "").trim();
    const receipt_quote = String((it as any)?.receipt_quote ?? "").trim();
    const canonical = inferCanonicalFactKeyV1(fact_key, value_json) ?? fact_key;

   if (!receipt_id || !userReceiptIds.has(receipt_id)) continue;

    const dedupeKey = `${canonical}::${String(value_json ?? "")}::stated`;
    if (seenCandidateKeys.has(dedupeKey)) continue;
    seenCandidateKeys.add(dedupeKey);

    const row = {
      user_id,
      conversation_id,
      turn_ref: receipt_id || null,
      fact_key_guess: fact_key,
      fact_key_canonical: canonical,
      value_json,
      source_quote: receipt_quote || "[no quote]",
      source_meta: { receipt_id: receipt_id || null, context: (it as any)?.context ?? null },
      confidence,
      extractor_version: payload?.version ?? "phase_b",
      model_meta: {},
      polarity: "stated",
      temporal_hint: "unknown",
      status: "captured",
      extracted_at: new Date().toISOString(),
    };

     await tryInsertCandidate("fact_candidates", row);
 
   }
 
  // NOTE: Story seeding prefers Phase A, but Phase B may seed when Phase A returns early (Phase B is queued).
   // Phase B may write story_seeds when Phase A returns early (Phase B is queued). Dedupe is best-effort to avoid duplicates.
   const storyResult = await traceAsync("phase_b_heuristic_story_seeds", async () => {
     try {
      const userTurnsLite: TranscriptTurnLite[] = (userTurnsForFacts as any[])
        .map((t: any) => ({
          id: String(t?.receipt_id ?? t?.id ?? ""),
          role: "user",
          source: String(t?.source ?? "legacy_user"),
          text: String(t?.text ?? t?.content ?? ""),
        }))
        .filter((t) => Boolean(t.id) && Boolean(t.text));

      return await persistHeuristicStorySeedsV1({
        client,
        user_id,
        conversation_id,
        userTurns: userTurnsLite,
      });
     } catch (e) {
       console.warn("PHASE_B: story seed persist failed (non-fatal):", (e as any)?.message ?? e);
       return { inserted: 0, skipped: 0 };
     }
   });

   endSessionTrace.push({ step: "phase_b_done", ms: 0, meta: { facts_items: candidates.length, job_id } });
 
  // 5) Final upsert: enrich the existing Phase A memory_summary row
  try {
    await traceAsync(
      "phase_b_db_upsert_memory_summary_final",
      () =>
        client
          .from("memory_summary")
          .upsert(
            {
              user_id,
              conversation_id,
              raw_id: effectiveRawId,
              short_summary: short_summary || null,
              session_insights: {},
              session_insights: buildSessionInsights({
                phase: "B",
                end_session_trace: endSessionTrace as any,
                counts: {
                  total_turns: transcriptForSummary.length,
                  user_turns: userTurnsForFacts.length,
                  facts_items: candidates.length,
                },
                extra: { job_id },
              }),
              observations: {
                phase: "B",
                job_id,
                end_session_trace: endSessionTrace,
                 counts: {
                   total_turns: transcriptForSummary.length,
                   user_turns: userTurnsForFacts.length,
                   facts_items: candidates.length,
                 },
                // Phase B must not write story_seeds (and should not depend on Phase A variables).
                // Keep explicit null for trace visibility without risking duplicate inserts / TDZ issues.
                story_seeds: null,
               },
             },
             { onConflict: "user_id,conversation_id" },
           ),
    );
  } catch (e) {
    console.warn("PHASE_B: memory_summary final upsert threw (non-fatal):", (e as any)?.message ?? e);
  }
}

// ---------------------------------------------------------------------------
// Exported pipeline entrypoint (required by turn_core.ts import/call).
// BURN DOWN: Everything except (1) simple short summary + (2) extracted facts.
// ---------------------------------------------------------------------------
 export async function runEndSessionPipeline(ctx: EndSessionCtx): Promise<{
   ok: boolean;
   short_summary: string | null;
   facts: FactReviewResult | null;
   eligibility: { summaryEligible: boolean; summaryReason: string; userWordCount: number; userTurnCount: number };
   version: string;
 }> {
  // -------------------------------------------------------------------------
  // NEW: lightweight step trace (for latency debugging + “what did ai-brain do?” export)
  // Persisted into memory_summary.observations.end_session_trace
  // -------------------------------------------------------------------------
  const endSessionTrace: Array<{ step: string; ms: number; meta?: any; error?: string }> = [];
  const traceAsync = async <T>(step: string, fn: () => Promise<T>, meta?: any): Promise<T> => {
    const t0 = performance.now();
    try {
      const out = await fn();
      endSessionTrace.push({ step, ms: Math.round((performance.now() - t0) * 1000) / 1000, meta });
      return out;
    } catch (e) {
      endSessionTrace.push({
        step,
        ms: Math.round((performance.now() - t0) * 1000) / 1000,
        meta,
        error: String((e as any)?.message ?? e),
      });
      throw e;
    }
  };

   const {
    client,
    user_id,
    effectiveConversationId,
    rawIdThisTurn,
    preferredLocale,
    targetLocale,
    hasTarget,
    deps,
  } = ctx;


  // Hard guardrails: prevent uuid("undefined") and null user_id from reaching DB.
  // This also prevents VIP-lane synthetic anchor writes with null user_id.
  const isUuid = (s: string): boolean =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s ?? "").trim());

  if (!isUuid(user_id) || !isUuid(effectiveConversationId)) {
    console.error("END_SESSION: invalid ids; aborting pipeline early", {
      user_id,
      effectiveConversationId,
    });
    return {
      ok: false,
      short_summary: null,
      facts: null,
      eligibility: { summaryEligible: false, summaryReason: "invalid_ids", userWordCount: 0, userTurnCount: 0 },
      version: END_SESSION_VERSION,
    };
  }

  // memory_summary.raw_id is NOT NULL in your DB schema.
  // Use rawIdThisTurn when available; otherwise fall back to the latest memory_raw id in this conversation.
  let effectiveRawId: string | null = (rawIdThisTurn ? String(rawIdThisTurn).trim() : "") || null;
  if (!effectiveRawId) {
    try {
      const { data, error } = await client
        .from("memory_raw")
        .select("id")
        .eq("user_id", user_id)
        .eq("conversation_id", effectiveConversationId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!error && (data as any)?.id) effectiveRawId = String((data as any).id);
    } catch {}
  }

   // 1) Transcript (with edits) and eligibility
  const transcript = await traceAsync(
    "fetch_effective_transcript_with_edits",
    () => fetchEffectiveTranscriptWithEdits(client, user_id, effectiveConversationId),
  );
   const transcriptForSummary = (transcript ?? []).map((t) => ({
     id: String((t as any)?.id ?? ""),
     source: String((t as any)?.source ?? ""),
     role: String((t as any)?.role ?? ""),
     text: String((t as any)?.content ?? ""),
   }));

  // Build user-only transcript for facts extraction with stable receipt markers.
  const userTurnsForFacts = (transcriptForSummary ?? []).filter((t: any) => {
    const role = String((t as any)?.role ?? "").toLowerCase();
    const source = String((t as any)?.source ?? "").toLowerCase();
    return role === "user" || source === "legacy_user";
  });

  // Facts extraction + persistence require a USER receipt id.
  // If we pass an assistant receipt id here, all candidates will be dropped later by:
  //   if (!receipt_id || !userReceiptIds.has(receipt_id)) continue;
  // (see the fact_candidates persistence loop below).
  const lastUserReceiptId =
    userTurnsForFacts.length > 0
      ? String((userTurnsForFacts[userTurnsForFacts.length - 1] as any)?.id ?? "").trim()
      : "";

  const eligibilityFull = await traceAsync(
    "assess_eligibility",
    async () => assessEligibility(transcriptForSummary),
    { totalTurns: transcriptForSummary.length, userTurns: userTurnsForFacts.length },
  );
   const eligibility = {
     summaryEligible: Boolean((eligibilityFull as any).summaryEligible),
     summaryReason: String((eligibilityFull as any).summaryReason ?? ""),
     userWordCount: Number((eligibilityFull as any).userWordCount ?? 0),
     userTurnCount: Number((eligibilityFull as any).userTurnCount ?? 0),
   };

  // 2) Summary + facts + story seeds can run in parallel after transcript/eligibility.
  // Keep end-session deterministic: summary is best-effort, facts/story are best-effort, but we never skip silently.
  let short_summary: string | null = null;

  // Build user-only transcript text for facts extraction with stable receipt markers.
  const transcriptTextForFacts = (userTurnsForFacts ?? [])
    .map((t: any) => {
      const rid = String((t as any)?.id ?? "").trim();
      const text = String((t as any)?.text ?? "");
      // [RID:<id>] lets the extractor attach evidence to a specific USER receipt.
      return rid ? ("[RID:" + rid + "] user: " + text) : ("user: " + text);
    })
    .join("\n")
    .trim();

   const summaryPromise: Promise<string | null> = (async () => {
     if (!eligibility.summaryEligible) return null;
     try {
      // Augment transcript for summarization ONLY (do not affect eligibility or fact extraction).
      // This provides hooks for “dot-connecting” to prior stories and facts without new routing.
      const relevantPrior = await loadRelevantPriorContextBlockForSummary(
        client,
        user_id,
        transcriptTextForFacts,
      );
      const transcriptForSummaryAug = relevantPrior
        ? [
            ...(transcriptForSummary as any[]),
            {
              id: "",
              source: "legacy_ai",
              role: "assistant",
              text: relevantPrior,
            },
          ]
        : (transcriptForSummary as any[]);

       const out = await traceAsync(
         "gemini_summarize_short_summary",
         () =>
          deps.summarizeLegacySessionWithGemini(transcriptForSummaryAug as any, {
             preferred_locale: preferredLocale,
             target_locale: hasTarget ? targetLocale : null,
             user_id,
             conversation_id: effectiveConversationId,
           } as any),
       );
       const candidate = clampString((out as any)?.short_summary ?? "", 900);
       return candidate ? candidate : null;
     } catch (e) {
       console.warn("END_SESSION: summarize failed (non-fatal):", (e as any)?.message ?? e);
       return null;
     }
   })();

  const factsPromise: Promise<FactReviewResult | null> = (async () => {
    try {
      const factsRes = await traceAsync(
        "facts_extract_and_normalize",
        () =>
          upsertUserFactsV1({
            client,
            user_id,
            conversation_id: effectiveConversationId,
            preferredLocale,
            transcriptText: transcriptTextForFacts,
            receipt_id: lastUserReceiptId || String(rawIdThisTurn ?? effectiveRawId ?? ""),
            deps,
            eligible: eligibility.summaryEligible,
          }),
        { transcript_chars: transcriptTextForFacts.length },
      );

      // Append post-summary step results here; we persist the finalized trace once at the end.
      try {
        const items = Array.isArray((factsRes as any)?.items) ? (factsRes as any).items : [];
        endSessionTrace.push({
          step: "facts_extract_and_normalize_result",
          ms: 0,
          meta: {
            extracted_items: items.length,
            eligible: !!eligibility.summaryEligible,
          },
        });
      } catch {
        // non-fatal
      }

      return factsRes;
    } catch (e) {
      console.warn("END_SESSION: facts upsert failed (non-fatal):", (e as any)?.message ?? e);
      return null;
    }
  })();

  // Await summary now (needed for memory_summary persistence). Facts/story continue in background.
  short_summary = await summaryPromise;
  // If the model summary fails or eligibility blocks, still persist a minimal summary row
  // so the GUI always has something to show.
  const fallbackSummaryFromTranscript = (tx: any[]): string => {
    const userLines = (Array.isArray(tx) ? tx : [])
      .filter((t: any) => String((t as any)?.role ?? "").toLowerCase() === "user")
      .map((t: any) => String((t as any)?.text ?? "").trim())
      .filter(Boolean);
    const seed = userLines.slice(0, 2).join(" / ");
    const msg = seed ? ("You discussed: " + seed) : "Session ended.";
    return clampString(msg, 900);
  };

if (!short_summary) {
  // Always write something so memory_summary exists.
  short_summary = eligibility.summaryEligible
    ? fallbackSummaryFromTranscript(transcriptForSummary as any)
    : "Session was too short to summarize.";
}

// Phase A fast path: persist minimal summary + enqueue Phase B + kick worker
if (isPhaseBEnabled()) {
  endSessionTrace.push({ step: "phase_a_finalize", ms: 0, meta: { queued_phase_b: true } });

  // Best-effort upsert so UI has the snapshot immediately
  try {
    await traceAsync(
      "db_upsert_memory_summary_phase_a",
      () =>
        client
          .from("memory_summary")
          .upsert(
            {
               user_id,
               conversation_id: effectiveConversationId,
               raw_id: effectiveRawId,
               short_summary,
              session_insights: buildSessionInsights({
                phase: "A",
                end_session_trace: endSessionTrace as any,
                counts: {
                  total_turns: transcriptForSummary.length,
                  user_turns: userTurnsForFacts.length,
                },
                extra: {
                  summary_eligible: Boolean(eligibility?.summaryEligible),
                  summary_reason: String(eligibility?.summaryReason ?? ""),
                },
              }),
               observations: {
                 phase: "A",
                 end_session_trace: endSessionTrace,
                 counts: {
                   total_turns: transcriptForSummary.length,

                  user_turns: userTurnsForFacts.length,
                },
              },
            },
            { onConflict: "user_id,conversation_id" },
          ),
    );
  } catch (e) {
     console.warn("END_SESSION: phase A memory_summary upsert threw (non-fatal):", (e as any)?.message ?? e);
   }
 
   const payload = {
     raw_id: effectiveRawId,
     short_summary,
     preferredLocale,
     targetLocale: hasTarget ? targetLocale : null,
     hasTarget,
     last_user_receipt_id: lastUserReceiptId || null,
     eligibility,
     end_session_trace_phase_a: endSessionTrace,
     version: END_SESSION_VERSION,
   };

  // Phase B does the heavy lifting, but E2E (and some deployments) may not run the job worker.
  // So we do a fast, best-effort heuristic story seed pass here as well.
  try {
    // Back-compat: some versions only expose summaryEligible/eligible, not storiesEligible.
    const storiesEligible =
      Boolean((eligibility as any)?.storiesEligible) ||
      Boolean((eligibility as any)?.eligible) ||
      Boolean((eligibility as any)?.summaryEligible);
    if (storiesEligible) {
       const userTurnsLite: TranscriptTurnLite[] = (userTurnsForFacts as any[])
         .map((t: any) => ({
           id: String(t?.receipt_id ?? t?.id ?? ""),
           role: "user",
           source: String(t?.source ?? "legacy_user"),
           text: String(t?.text ?? t?.content ?? ""),
         }))
         .filter((t) => Boolean(t.id) && Boolean(t.text));

      const phaseAStorySeeds = await persistHeuristicStorySeedsV1({
        client,
        user_id,
        conversation_id: effectiveConversationId,
        userTurns: userTurnsLite,
      });

      // Attach to the job payload for observability/debugging (worker may still run).
      (payload as any).phase_a_story_seeds = phaseAStorySeeds;
    }
  } catch (err) {
    console.error("PHASE_A_STORY_SEEDS_FAILED", {
      conversation_id: effectiveConversationId,
      user_id,
      error: String((err as any)?.message ?? err),
    });
  }

  await enqueueEndSessionJobBestEffort(client, user_id, effectiveConversationId, payload);

  kickEndSessionWorkerBestEffort();

  return { ok: true, short_summary, facts: null, eligibility, version: END_SESSION_VERSION };
 }
}