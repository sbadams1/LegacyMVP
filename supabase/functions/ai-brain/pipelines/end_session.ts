// supabase/functions/ai-brain/pipelines/end_session.ts
// Extracted from ai-brain/handler.ts to reduce brittleness.
// This pipeline runs ONLY during explicit end-session.


import { upsertSummaryThemesAndClusters } from "./themes/theme_pipeline.ts";

export type EndSessionDeps = {
  fetchLegacySessionTranscript: (...args: any[]) => Promise<any>;
  summarizeLegacySessionWithGemini: (...args: any[]) => Promise<any>;
  inferChapterKeysForLegacySummary: (...args: any[]) => any;
  classifyCoverageFromStoryText: (...args: any[]) => any;
  upsertStorySeedsForConversation: (...args: any[]) => Promise<any>;
  recomputeUserKnowledgeGraphs: (...args: any[]) => Promise<any>;
  invokeRebuildInsightsInternal: (...args: any[]) => Promise<any>;
  // Theme extraction (LLM) used by the longitudinal theme pipeline.
  extractSummaryThemesWithGemini: (args: {
    short_summary: string;
    full_summary?: string | null;
    max_themes?: number;
  }) => Promise<any>;

  // Optional: direct longitudinal snapshot v2 generator (JSON)
  // If present, end_session will prefer this over the heuristic taxonomy snapshot.
  generateLongitudinalSnapshotV2WithGemini?: (args: {
    prompt: string;
    preferred_locale: string;
    response_schema: any;
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
  learningLevel: string;
  legacyState: any;
  nowIso: string;
  deps: EndSessionDeps;
};

/**
 * Defensive sanitation:
 * We no longer generate/persist legacy v1 `session_insights.items` or `key_sentence`.
 * If any upstream payload still contains those keys, strip them before writing.
 */
function stripLegacyV1SessionInsights(input: any): any {
  if (!input || typeof input !== "object") return {};

  // Shallow clone to avoid mutating caller
  const out: any = Array.isArray(input) ? [...input] : { ...input };
  delete out.items;
  delete out.key_sentence;

  // Recurse into nested objects (e.g., { reframed: {...} })
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (v && typeof v === "object") {
      out[k] = stripLegacyV1SessionInsights(v);
    }
  }
  return out;
}

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

function isProceduralPlaceholder(s: string): boolean {
  const t = String(s ?? "").trim().toLowerCase();
  if (!t) return true;
  // Common procedural placeholders from rebuild/cleanup passes
  if (t.includes("checked in briefly")) return true;
  if (t.includes("did not record a detailed story")) return true;
  if (t.includes("no detailed story")) return true;
  if (t.includes("no story in this session")) return true;
  if (t.includes("no summary was captured")) return true;
  if (t.includes("presence check")) return true;
  return false;
}

function normalizeSessionInsights(siRaw: any): any {
  const si: any = siRaw && typeof siRaw === "object" ? { ...siRaw } : {};
  // Ensure canonical keys exist and are stable for UI.
  si.short_summary = typeof si.short_summary === "string" ? si.short_summary.trim() : "";
  si.full_summary = typeof si.full_summary === "string" ? si.full_summary.trim() : (si.full_summary == null ? "" : String(si.full_summary).trim());

  // Common legacy key variants we still see from older runs
  if (!si.short_summary && typeof (si as any).reframed_short_summary === "string") {
    si.short_summary = String((si as any).reframed_short_summary).trim();
  }
  if (!si.full_summary && typeof (si as any).reframed_full_summary === "string") {
    si.full_summary = String((si as any).reframed_full_summary).trim();
  }

  si.reflections = normalizeStringList((si as any).reflections ?? (si as any).reflection);
  si.insights = normalizeStringList((si as any).insights ?? (si as any).insight);
  si.patterns = normalizeStringList((si as any).patterns ?? (si as any).pattern_noticing ?? (si as any).pattern);
  si.rare_insights = normalizeStringList((si as any).rare_insights ?? (si as any).rare);

  

// If reframed short_summary is a procedural placeholder, do not let it compete with canonical short_summary.
try {
  const rShort = String((si as any)?.reframed?.short_summary ?? "").trim();
  if (rShort && isProceduralPlaceholder(rShort)) {
    const cShort = String(si.short_summary ?? "").trim();
    if (cShort && !isProceduralPlaceholder(cShort)) {
      if ((si as any).reframed && typeof (si as any).reframed === "object") {
        (si as any).reframed.short_summary = null;
      }
    }
  }
} catch (_) {
  // ignore
}

  return si;
}

// --- Longitudinal “keep coming back” artifacts ---
// These are deliberately NOT advice. They are receipt-grounded reflections that help the user feel seen.
// Stored as best-effort in memory_summary.observations.longitudinal_snapshot (so Phase-2 lock never blocks them).
type LongitudinalSnapshot = {
  generated_at: string;
  month_start_utc: string;
  week_start_utc: string;
  emerging_themes_month: Array<{ label: string; strength?: number; last_seen_at?: string }>; // top 3
  recurring_tensions: Array<{ label: string; receipts: string[] }>; // 2–3 (heuristic)
  changed_since_last_week: {
    up: Array<{ label: string; delta: number }>; // top 3
    down: Array<{ label: string; delta: number }>; // top 3
  };
  receipts_by_label: Record<string, string[]>; // label -> 1–2 receipts
};


// Build an observational, read-aloud-safe paragraph for the UI.
// This is deterministic (no LLM dependency) and uses the existing heuristic snapshot fields.
// Stored in observations.longitudinal_snapshot.snapshot_text.
function buildObservationalSnapshotText(input: {
  snap: any;
  preferredLocale: string;
}): string | null {
  try {
    const { snap } = input;
    const receiptsByLabel = (snap && typeof snap === "object") ? (snap as any).receipts_by_label : null;
    const recurring = (snap && typeof snap === "object") ? (snap as any).recurring_tensions : null;

    // Gather labels
    const labels: string[] = [];
    if (Array.isArray(recurring)) {
      for (const it of recurring) {
        const lab = String((it as any)?.label ?? "").trim();
        if (lab) labels.push(lab);
      }
    }
    if (receiptsByLabel && typeof receiptsByLabel === "object") {
      for (const k of Object.keys(receiptsByLabel)) {
        const kk = String(k ?? "").trim();
        if (kk) labels.push(kk);
      }
    }

    const all = labels.join(" • ").toLowerCase();

    // Very lightweight domain hints for the "different areas" sentence.
    const areas: string[] = [];
    const add = (s: string) => { if (!areas.includes(s)) areas.push(s); };

    if (/(media|news|doom|scroll|outrage|agenda|biased|narrative|video)/i.test(all)) add("how you respond to media");
    if (/(relationship|connection|guarded|boundary|boundaries|trust|family|girlfriend|people)/i.test(all)) add("how you think about relationships");
    if (/(app|legacy|code|build|ship|project|projects|perfection|overthink|tone|product)/i.test(all)) add("how you approach projects");
    if (/(diet|food|nutrition|vegetable|sleep|health|exercise|bike|cycling|gym)/i.test(all)) add("everyday choices");

    // Ensure we have at least two areas so the sentence reads naturally.
    const areaText = (areas.length >= 2)
      ? areas.slice(0, 4).join(", ").replace(/, ([^,]+)$/, " and $1")
      : "different parts of your life";

    const p1 =
      `Across recent sessions, you repeatedly notice the same kind of moment: an initial reaction, followed by hesitation and reconsideration. ` +
      `This pattern shows up in ${areaText}. The details change, but the pause-and-rethink rhythm stays the same.`;

    const p2 =
      `Taken together, these sessions suggest you're paying close attention to where effort, control, and caution are still useful — and where they may be more draining than necessary. ` +
      `Rather than pointing to a single issue, the pattern reflects an ongoing adjustment in how tightly you hold things, especially as your priorities and circumstances continue to shift.`;

    const out = `${p1}\n\n${p2}`.trim();
    return out.length >= 80 ? out : null;
  } catch {
    return null;
  }
}


type LongitudinalSnapshotV2 = {
  version: "v2";
  from_prior_sessions: boolean;
  window_days: number;
  source_count: number;
  emerging_pattern: string;
  tension_you_are_carrying: string;
  underlying_value: string;
  evidence: Record<string, string[]>;
};

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

function buildLongitudinalSnapshotV2Prompt(input: {
  preferredLocale: string;
  window_days: number;
  summaries: Array<{ created_at: string; short_summary: string }>;
}): string {
  const { preferredLocale, window_days, summaries } = input;
  const compact = summaries
    .map((s, i) => `${i + 1}) ${s.created_at}: ${String(s.short_summary ?? "").trim()}`)
    .join("\n");

  return [
    "You are writing a Longitudinal Snapshot v2 for a private journaling legacy app.",
    "The user will read this in second person (you). It must sound natural if read aloud to the user.",
    "Rejection test: would this sound wrong if read aloud to the user? If yes, set rejection_reason.",
    "Your job: extract ONE dominant stance that repeats across recent sessions.",
    "Do NOT output a taxonomy, a list of many themes, or multiple competing tensions.",
    "Avoid headings like Key tensions, Emerging, Tensions, More, etc.",
    "Write three short paragraphs:",
    "1) emerging_pattern: a single grounded pattern stated as a stance, rooted in lived experience.",
    "2) tension_you_are_carrying: one tension (single sentence if possible) inside that stance.",
    "3) underlying_value: the value or principle that makes the stance make sense.",
    "Each paragraph must reference something concrete from the summaries, but do not quote long text.",
    "Evidence: include 2-4 short evidence snippets (5-20 words each) pulled from the summaries.",
    "If you cannot find a dominant stance that repeats, set rejection_reason and keep the three paragraphs empty.",
    "Return ONLY valid JSON that matches the provided schema.",
    "",
    `Window: last ${window_days} days. Locale: ${preferredLocale}.`,
    "Recent session summaries:",
    compact,
  ].join("\n");
}

async function buildLongitudinalSnapshotV2BestEffort(args: {
  client: any;
  user_id: string;
  nowIso: string;
  preferredLocale: string;
  exclude_raw_id?: string | null;
  deps: EndSessionDeps;
  from_prior_sessions: boolean;
}): Promise<LongitudinalSnapshotV2 | null> {
  const { client, user_id, nowIso, preferredLocale, exclude_raw_id, deps, from_prior_sessions } = args;
  try {
    const gen = (deps as any).generateLongitudinalSnapshotV2WithGemini;
    if (typeof gen !== "function") return null;
    const now = new Date(nowIso);
    if (isNaN(now.getTime())) return null;
    const window_days = Number(Deno.env.get("LONGITUDINAL_SNAPSHOT_V2_WINDOW_DAYS") ?? "14");
    const windowStart = new Date(now.getTime() - window_days * 24 * 60 * 60 * 1000);

    let q = client
      .from("memory_summary")
      .select("created_at, raw_id, short_summary, observations")
      .eq("user_id", user_id)
      .gte("created_at", windowStart.toISOString())
      .order("created_at", { ascending: false })
      .limit(12);
    if (exclude_raw_id) q = q.neq("raw_id", exclude_raw_id);
    const { data: rows, error: err } = await q;
    if (err) throw err;
    const summaries = (Array.isArray(rows) ? rows : [])
      .filter((r: any) => String(r?.short_summary ?? "").trim().length > 0)
      .filter((r: any) => {
        const el = (r?.observations as any)?.eligibility;
        const ok = Boolean(el?.eligible ?? el?.insightsEligible ?? false);
        return ok;
      })
      .slice(0, 8)
      .map((r: any) => ({ created_at: String(r.created_at), short_summary: String(r.short_summary) }));
    if (summaries.length < 2) return null;

    const prompt = buildLongitudinalSnapshotV2Prompt({ preferredLocale, window_days, summaries });
    const out = await gen({ prompt, preferred_locale: preferredLocale, response_schema: LONGITUDINAL_SNAPSHOT_V2_SCHEMA });
    const emerging = String(out?.emerging_pattern ?? "").trim();
    const tension = String(out?.tension_you_are_carrying ?? "").trim();
    const value = String(out?.underlying_value ?? "").trim();
    const rejection = String(out?.rejection_reason ?? "").trim();
    if (rejection) return null;
    const v2: LongitudinalSnapshotV2 = {
      version: "v2",
      from_prior_sessions,
      window_days,
      source_count: summaries.length,
      emerging_pattern: emerging,
      tension_you_are_carrying: tension,
      underlying_value: value,
      evidence: (out?.evidence && typeof out.evidence === "object") ? out.evidence : {},
    };
    const gate = isHighResonanceV2(v2);
    if (!gate.ok) return null;
    return v2;
  } catch (e) {
    console.warn("END_SESSION: longitudinal snapshot v2 failed (non-fatal):", (e as any)?.message ?? e);
    return null;
  }
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

async function buildLongitudinalSnapshotBestEffort(args: {
  client: any;
  user_id: string;
  nowIso: string;
}): Promise<LongitudinalSnapshot | null> {
  const { client, user_id, nowIso } = args;
  try {
    const now = new Date(nowIso);
    if (isNaN(now.getTime())) return null;

    const monthStart = isoUtcMonthStart(now);
    const weekStart = isoUtcDayStart(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
    const prevWeekStart = isoUtcDayStart(new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000));

    // 1) Emerging themes this month from theme_clusters
    const { data: clusters, error: clErr } = await client
      .from("theme_clusters")
      .select("cluster_label, strength, last_seen_at")
      .eq("user_id", user_id)
      .gte("last_seen_at", monthStart.toISOString())
      .order("strength", { ascending: false })
      .limit(25);

    if (clErr) throw clErr;
    const emerging = (Array.isArray(clusters) ? clusters : [])
      .map((c: any) => ({
        label: String(c?.cluster_label ?? "").trim(),
        strength: typeof c?.strength === "number" ? c.strength : Number(c?.strength ?? 0),
        last_seen_at: c?.last_seen_at ? String(c.last_seen_at) : undefined,
      }))
      .filter((x) => x.label)
      .slice(0, 3);

    // 2) Weekly delta + receipts (pull cluster_members for last 14 days)
    const { data: members, error: memErr } = await client
      .from("cluster_members")
      .select("theme_label, receipts, created_at")
      .eq("user_id", user_id)
      .gte("created_at", prevWeekStart.toISOString())
      .order("created_at", { ascending: false })
      .limit(500);

    if (memErr) throw memErr;

    const rows = Array.isArray(members) ? members : [];

    const countsThis: Record<string, number> = {};
    const countsPrev: Record<string, number> = {};
    const receiptsByLabel: Record<string, string[]> = {};
    const tensionCandidates: Array<{ label: string; receipts: string[] }> = [];

    for (const r of rows) {
      const label = String((r as any)?.theme_label ?? "").trim();
      if (!label) continue;
      const created = new Date(String((r as any)?.created_at ?? ""));
      const isThisWeek = !isNaN(created.getTime()) && created >= weekStart;
      const bucket = isThisWeek ? countsThis : countsPrev;
      bucket[label] = (bucket[label] ?? 0) + 1;

      if (!receiptsByLabel[label]) receiptsByLabel[label] = [];
      const snips = pickReceiptSnippets((r as any)?.receipts, 2);
      for (const s of snips) {
        if (receiptsByLabel[label].length >= 2) break;
        if (!receiptsByLabel[label].includes(s)) receiptsByLabel[label].push(s);
      }
    }

    // delta computation
    const allLabels = Array.from(new Set([...Object.keys(countsThis), ...Object.keys(countsPrev)]));
    const deltas = allLabels
      .map((label) => ({
        label,
        delta: (countsThis[label] ?? 0) - (countsPrev[label] ?? 0),
      }))
      .filter((x) => x.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    const up = deltas
      .filter((x) => x.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 3);
    const down = deltas
      .filter((x) => x.delta < 0)
      .sort((a, b) => a.delta - b.delta) // more negative first
      .slice(0, 3)
      .map((x) => ({ ...x, delta: Math.abs(x.delta) }));

    // 3) Recurring “tensions” (heuristic): pick labels where receipts contain explicit contrast words.
    for (const label of Object.keys(receiptsByLabel)) {
      const rs = receiptsByLabel[label] ?? [];
      if (rs.some(isTensionLikeReceipt)) tensionCandidates.push({ label, receipts: rs });
    }
    // Prefer clusters seen multiple times recently
    tensionCandidates.sort((a, b) => (countsThis[b.label] ?? 0) - (countsThis[a.label] ?? 0));
    const recurringTensions = tensionCandidates.slice(0, 3);

    const snap: LongitudinalSnapshot = {
      generated_at: nowIso,
      month_start_utc: monthStart.toISOString(),
      week_start_utc: weekStart.toISOString(),
      emerging_themes_month: emerging,
      recurring_tensions: recurringTensions,
      changed_since_last_week: { up, down },
      receipts_by_label: receiptsByLabel,
    };

    return snap;
  } catch (e) {
    console.warn("END_SESSION: buildLongitudinalSnapshot failed (non-fatal):", (e as any)?.message ?? e);
    return null;
  }
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


export async function runEndSessionPipeline(ctx: EndSessionCtx): Promise<void> {
  const {
    client,
    user_id,
    effectiveConversationId,
    rawIdThisTurn,
    conversationMode,
    preferredLocale,
    targetLocale,
    hasTarget,
    learningLevel,
    legacyState,
    nowIso,
    deps,
  } = ctx;

  const forceRewrite = envFlag("LEGACY_END_SESSION_FORCE_REWRITE", false);

  // In the original monolithic handler.ts, the legacy-state helper variable
  // `ls` existed in the parent scope (typically: `const ls = legacyState ?? getDefaultLegacy()`)
  // before the end-session branch. After extracting this pipeline, we must
  // re-introduce a safe local `ls` so the summarizer receives chapter context.
  // We keep this permissive to avoid any behavior change and to prevent runtime
  // ReferenceErrors if legacyState is null/undefined.
  const ls: any = legacyState ?? {};
  if (ls.chapter_id === undefined && ls.chapterId !== undefined) ls.chapter_id = ls.chapterId;
  if (ls.chapter_title === undefined && ls.chapterTitle !== undefined) ls.chapter_title = ls.chapterTitle;
  if (ls.chapter_id === undefined) ls.chapter_id = null;
  if (ls.chapter_title === undefined) ls.chapter_title = null;

              console.log("END_SESSION SUMMARY ATTEMPT", {
                user_id,
                conversation_id: effectiveConversationId,
                rawIdThisTurn,
              });

              // 1) Find an anchor raw_id for this session (required: memory_summary.raw_id is NOT NULL)
              const { data: anchorRow, error: anchorErr } = await client
                .from("memory_raw")
                .select("id, created_at")
                .eq("user_id", user_id)
                .eq("conversation_id", effectiveConversationId)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

              if (anchorErr) {
                console.error("Error finding session anchor raw_id:", anchorErr);
              }

              const anchorRawId = (anchorRow as any)?.id as string | undefined;

              console.log("END_SESSION ANCHOR RESULT", {
                user_id,
                conversation_id: effectiveConversationId,
                anchorRawId,
              });

              if (!anchorRawId) {
                console.warn(
                  "No anchorRawId found for end_session; cannot write memory_summary."
                );
              } else {
                // 2) Build transcript
                const transcript = await deps.fetchLegacySessionTranscript(
                  client,
                  user_id,
                  effectiveConversationId,
                );

                console.log("END_SESSION: transcript fetched", {
                  conversation_id: effectiveConversationId,
                  transcript_length: transcript?.length ?? 0,
                });

                // 3) Summarize with Gemini
                const eligibility = assessEligibility(transcript);
                console.log("END_SESSION: eligibility", {
                  conversation_id: effectiveConversationId,
                  eligible: eligibility.eligible,
                  reason: eligibility.reason,
                  userWordCount: eligibility.userWordCount,
                  userTurnCount: eligibility.userTurnCount,
                });

                let summary: any = null;
                if (!eligibility.summaryEligible) {
                  const placeholder = safePlaceholderSummary(eligibility.summaryReason || eligibility.reason);
                  summary = {
                    short_summary: placeholder,
                    observations: {},
                    session_insights: {
                      short_summary: placeholder,
                      summary_quality: "skipped",
                      skip_reason: eligibility.reason,
                      user_word_count: eligibility.userWordCount,
                      user_turn_count: eligibility.userTurnCount,
                      total_turn_count: eligibility.totalTurnCount,
                    },
                  };
                } else {
                  summary = await deps.summarizeLegacySessionWithGemini(
                    transcript,
                    {
                      session_key: effectiveConversationId,
                      chapter_id: ls.chapter_id,
                      chapter_title: ls.chapter_title,
                      preferred_locale: preferredLocale,
                      target_locale: hasTarget ? targetLocale : null,
                      learning_level: learningLevel,
                      summary_style: "legacy_v2_strict"
                    },
                  );

                // If the session is summarize-able but not eligible for deeper insights, we keep the summary
                // but force reflections/patterns/rare insights to be empty to avoid low-signal artifacts.
                if (summary && !eligibility.insightsEligible) {
                  const si = (summary as any).session_insights ?? {};
                  (summary as any).session_insights = {
                    ...si,
                    reflections: Array.isArray(si.reflections) ? [] : [],
                    patterns: Array.isArray(si.patterns) ? [] : [],
                    rare_insights: Array.isArray(si.rare_insights) ? [] : [],
                    magical_insights: Array.isArray(si.magical_insights) ? [] : [],
                    summary_quality: si.summary_quality ?? "ok",
                    skip_reason: si.skip_reason ?? eligibility.reason,
                    user_word_count: eligibility.userWordCount,
                    user_turn_count: eligibility.userTurnCount,
                    total_turn_count: eligibility.totalTurnCount,
                  };
                }

                if (!summary) {
                  console.warn("END_SESSION: summarizeLegacySessionWithGemini returned null", { conversation_id: effectiveConversationId },
                  );

  // FALLBACK: if we already have a usable short_summary inside session_insights,
  // treat it as the summary so UI and DB stay consistent.
  try {
    const { data: existing, error: existingErr } = await client
      .from("memory_summary")
      .select("id, short_summary, observations, session_insights")
      .eq("conversation_id", effectiveConversationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingErr) {
      console.error("END_SESSION fallback: error reading memory_summary:", existingErr);
      return;
    }

    const reframedShort =
      (existing as any)?.session_insights?.reframed?.short_summary ??
      (existing as any)?.session_insights?.reframed_short_summary ??
      null;

    if (typeof reframedShort === "string" && reframedShort.trim().length > 0) {
      // Promote reframed short summary into canonical column if needed
      const canonical = String((existing as any)?.short_summary ?? "").trim();
      if (!canonical || canonical.toLowerCase().includes("no summary")) {
        const existingFinalized = Boolean((existing as any)?.session_insights?.finalized);
        if (existingFinalized && !forceRewrite) {
          // Phase 2 lock: do not rewrite summary mirrors once finalized.
        } else {
        const { error: promoteErr } = await client
          .from("memory_summary")
          .update({
            short_summary: reframedShort.trim(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", (existing as any).id);

        if (promoteErr) {
          console.error("END_SESSION fallback: error promoting short_summary:", promoteErr);
        }
        }

      }

      // Construct a summary object so the pipeline can proceed normally
      summary = {
        short_summary: reframedShort.trim(),
        observations: (existing as any)?.observations ?? {},
        session_insights: (existing as any)?.session_insights ?? {},
                } as any;
                  } else {
                // Truly nothing to work with; leave summary null and exit
                  return;
                  }
                } catch (e) {
                  console.error("END_SESSION fallback: unexpected error:", e);
                  return;
                }
              }

                let { short_summary, full_summary, observations, session_insights } = summary as any;
                let cleaned_session_insights = normalizeSessionInsights(stripLegacyV1SessionInsights(session_insights));
                // Canonicalize summaries into session_insights (single source of truth)
                if (
                  (!cleaned_session_insights?.short_summary ||
                    String(cleaned_session_insights.short_summary).trim().length === 0) &&
                  cleaned_session_insights?.reframed?.short_summary
                ) {
                  cleaned_session_insights.short_summary = cleaned_session_insights.reframed.short_summary;
                }
                if (
                  !cleaned_session_insights?.short_summary ||
                  String(cleaned_session_insights.short_summary).trim().length === 0
                ) {
                  cleaned_session_insights.short_summary = short_summary;
                }
                if (
                  (!cleaned_session_insights?.full_summary ||
                    String(cleaned_session_insights.full_summary).trim().length === 0) &&
                  cleaned_session_insights?.reframed?.full_summary
                ) {
                  cleaned_session_insights.full_summary = cleaned_session_insights.reframed.full_summary;
                }
                if (
                  !cleaned_session_insights?.full_summary ||
                  String(cleaned_session_insights.full_summary).trim().length === 0
                ) {
                  cleaned_session_insights.full_summary = full_summary;
                }

                // Validate: reject transcript-like summaries
                let candidateShort = String(cleaned_session_insights?.short_summary ?? "").trim();
                let candidateFull = String(cleaned_session_insights?.full_summary ?? "").trim();

                let didRetry = false;
                if (looksLikeTranscript(candidateShort)) {
                  if (eligibility?.eligible) {
                    didRetry = true;
                    const retry = await deps.summarizeLegacySessionWithGemini(
                      transcript,
                      {
                        session_key: effectiveConversationId,
                        chapter_id: ls.chapter_id,
                        chapter_title: ls.chapter_title,
                        preferred_locale: preferredLocale,
                        target_locale: hasTarget ? targetLocale : null,
                        learning_level: learningLevel,
                        summary_style: "legacy_v2_strict_retry_no_dialogue"
                      },
                    );
                    if (retry) {
                      const rsi = stripLegacyV1SessionInsights((retry as any)?.session_insights);
                      const rShort = String(
                        (rsi?.short_summary ?? rsi?.reframed?.short_summary ?? (retry as any)?.short_summary ?? ""),
                      ).trim();
                      const rFull = String(
                        (rsi?.full_summary ?? rsi?.reframed?.full_summary ?? (retry as any)?.full_summary ?? ""),
                      ).trim();
                      if (rShort && !looksLikeTranscript(rShort)) {
                        candidateShort = rShort;
                      }
                      if (rFull && !looksLikeTranscript(rFull)) {
                        candidateFull = rFull;
                      }
                    }
                  }
                }

                if (!candidateShort || looksLikeTranscript(candidateShort)) {
                  const placeholder = safePlaceholderSummary((eligibility as any)?.summaryReason ?? (eligibility as any)?.reason ?? "unknown");
                  candidateShort = placeholder;
                  cleaned_session_insights.summary_quality = "fallback";
                  cleaned_session_insights.fallback_reason = eligibility?.reason ?? "unknown";
                } else {
                  cleaned_session_insights.summary_quality = didRetry ? "retry_ok" : (eligibility?.eligible ? "ok" : "skipped");
                }

                // Full summary is optional; if it looks like transcript, drop it
                if (candidateFull && looksLikeTranscript(candidateFull)) {
                  candidateFull = "";
                }
                cleaned_session_insights.short_summary = candidateShort;
                cleaned_session_insights.full_summary = candidateFull || null;

// --- Phase 2 contract lock (session synthesis is write-once unless forced) ---
cleaned_session_insights.version = String(cleaned_session_insights.version ?? "phase2_v3");
cleaned_session_insights.phase = "phase2";
cleaned_session_insights.finalized = true;
cleaned_session_insights.finalized_at = new Date().toISOString();
cleaned_session_insights.voice_pov = String(cleaned_session_insights.voice_pov ?? "second_person");
cleaned_session_insights.eligibility = {
  summaryEligible: Boolean((eligibility as any)?.summaryEligible ?? (eligibility as any)?.eligible ?? false),
  insightsEligible: Boolean((eligibility as any)?.insightsEligible ?? false),
  reason: String((eligibility as any)?.reason ?? ""),
  summaryReason: String((eligibility as any)?.summaryReason ?? ""),
  userWordCount: Number((eligibility as any)?.userWordCount ?? 0),
  userTurnCount: Number((eligibility as any)?.userTurnCount ?? 0),
  totalTurnCount: Number((eligibility as any)?.totalTurnCount ?? 0),
};
// If insights are not eligible, forcibly empty insight-like arrays to prevent "magic" noise.
if (!cleaned_session_insights.eligibility.insightsEligible) {
  cleaned_session_insights.reflections = [];
  cleaned_session_insights.insights = [];
  cleaned_session_insights.patterns = [];
  cleaned_session_insights.rare_insights = [];
  cleaned_session_insights.longitudinal_insight = null;
}

// Ensure reframed.short_summary never overrides canonical short_summary when it is procedural.
try {
  const rShort = String((cleaned_session_insights as any)?.reframed?.short_summary ?? "").trim();
  if (rShort && isProceduralPlaceholder(rShort) && candidateShort && !isProceduralPlaceholder(candidateShort)) {
    if ((cleaned_session_insights as any).reframed && typeof (cleaned_session_insights as any).reframed === "object") {
      (cleaned_session_insights as any).reframed.short_summary = null;
    }
  }
} catch (_) {}
// --- /Phase 2 contract lock ---

                // Mirror validated values to the plain columns for UI history lists
                short_summary = candidateShort;
                full_summary = candidateFull || null;
 
                console.log("END_SESSION: summary obtained", { conversation_id: effectiveConversationId });


                  // ------------------------------------------------------------------
                  // Quiet chapter classification (content-based)
                  //
                  // IMPORTANT BUGFIX:
                  //   deps.classifyCoverageFromStoryText() returns { chapterKeys, themes }
                  //   (camelCase), but older code read chapter_keys, which always
                  //   produced an empty list and caused chapter_key to stick to
                  //   the default (often "early_childhood").
                  // ------------------------------------------------------------------
                  let obsOut: any = observations ?? {};
                  // Keep low-level session metadata in observations for downstream artifacts (coverage map, debugging).
                  obsOut = {
                    ...(obsOut ?? {}),
                    eligibility: {
                      eligible: Boolean((eligibility as any)?.eligible ?? false),
                      summaryEligible: Boolean((eligibility as any)?.summaryEligible ?? false),
                      reason: (eligibility as any)?.reason ?? null,
                      summaryReason: (eligibility as any)?.summaryReason ?? null,
                      userWordCount: (eligibility as any)?.userWordCount ?? null,
                      userTurnCount: (eligibility as any)?.userTurnCount ?? null,
                      totalTurnCount: (eligibility as any)?.totalTurnCount ?? null,
                    },
                  };


                  try {
                    const classified = await deps.classifyCoverageFromStoryText(String(full_summary ?? "").trim());

                    let keys: CoverageChapterKey[] =
                      Array.isArray(classified?.chapterKeys) ? classified!.chapterKeys : [];

                    let themes: string[] =
                      Array.isArray(classified?.themes) ? classified!.themes : [];

                    // Deterministic fallback (no extra Gemini call) if classification fails.
                    if (!keys.length) {
                      keys = deps.inferChapterKeysForLegacySummary(String(full_summary ?? ""), themes);
                    }

                    if (keys.length) {
                      const existingThemes = Array.isArray(obsOut?.themes) ? obsOut.themes : [];
                      const mergedThemes = Array.from(
                        new Set(
                          [...existingThemes, ...themes]
                            .filter((t) => typeof t === "string")
                            .map((t) => t.trim())
                            .filter(Boolean),
                        ),
                      );

                      obsOut = {
                        ...obsOut,
                        chapter_keys: keys,
                        themes: mergedThemes,
                        coverage_classified_from: "full_summary",
                        coverage_classified_at: new Date().toISOString(),
                      };

                      // Primary chapter_key = first key
                      const primaryChapterKey = keys[0];

                      // Update all memory_raw rows for this session so Coverage Map reflects reality.
                      // Best-effort only.
                      const { error: mrUpdErr } = await client
                        .from("memory_raw")
                        .update({
                          chapter_key: primaryChapterKey,
                        })
                        .eq("user_id", user_id)
                        .eq("conversation_id", effectiveConversationId);

                      if (mrUpdErr) {
                        console.error("END_SESSION: memory_raw chapter_key update failed:", mrUpdErr,
                        );
                      } else {
                        console.log("END_SESSION: memory_raw chapter_key updated", {
                          conversation_id: effectiveConversationId,
                          chapter_key: primaryChapterKey,
                        });
                      }
                    }
                  } catch (e) {
                    console.error("END_SESSION: coverage classification failed:", e);
                  }

                  console.log("END_SESSION: writing memory_summary", {
                    conversation_id: effectiveConversationId,
                    raw_id: anchorRawId,
                  });

                  // Chapter keys for this summary (based on coverage classification stored in observations)
                  const summaryChapterKeys: string[] = Array.isArray((obsOut as any)?.chapter_keys)
                    ? (obsOut as any).chapter_keys
                    : [];
                  const summaryChapterKey1 = summaryChapterKeys[0] ?? null;
                  const summaryChapterKey2 = summaryChapterKeys[1] ?? null;
                  const summaryChapterKey3 = summaryChapterKeys[2] ?? null;

                  // 4) Upsert by raw_id (since raw_id is NOT NULL and is the real anchor)
                  let summaryIdForSeeds: string | null = null;

                                    const { data: existingSummary, error: summaryFetchError } =
                    await client
                      .from("memory_summary")
                      // NOTE: `full_summary` is deprecated. Do not read/write it as canonical.
                      .select("id, created_at, short_summary, session_insights")
                      .eq("user_id", user_id)
                      .eq("raw_id", anchorRawId)
                      .order("created_at", { ascending: false })
                      .limit(1)
                      .maybeSingle();
                  
                  // Ensure these are defined for downstream consumers (theme pipeline, etc.)
                  // even when we skip updating/inserting memory_summary.
                  let nextShort: string = String(cleaned_session_insights?.short_summary ?? "").trim();
                  let nextSessionInsights: any = normalizeSessionInsights(cleaned_session_insights);

                  if (summaryFetchError) {
                    console.error("Error reading existing memory_summary row:", summaryFetchError,
                    );
                  } else {
                    const candidateShort = String(cleaned_session_insights?.short_summary ?? "").trim();
                    const existingShort = String((existingSummary as any)?.short_summary ?? "").trim();
                    const existingSI = (existingSummary as any)?.session_insights ?? null;
                  
                    // Avoid overwriting a good existing summary with garbage / placeholders.
                    const existingFinalized = Boolean((existingSI as any)?.finalized);
                    const acceptCandidate =
                      candidateShort.length > 0 &&
                      !(existingFinalized && !forceRewrite) &&
                      !(isGarbageSummary(candidateShort) && existingShort && !isGarbageSummary(existingShort));
                  
                    nextShort = acceptCandidate ? candidateShort : existingShort;
                    nextSessionInsights = normalizeSessionInsights(acceptCandidate ? cleaned_session_insights : existingSI);
                  
                    if ((existingSummary as any)?.id) {
                      summaryIdForSeeds = (existingSummary as any).id;
                  
                      const updatePatch: any = {
                        observations: obsOut,
                        chapter_key: summaryChapterKey1,
                        updated_at: new Date().toISOString(),
                      };
// Phase 2 lock: once finalized, do not rewrite summaries/session_insights unless forceRewrite is enabled.
if (!(existingFinalized && !forceRewrite)) {
  // Keep `short_summary` as a mirror only (required NOT NULL).
  updatePatch.short_summary = nextShort;
  // Hard-null deprecated column to stop transcript leakage.
  updatePatch.session_insights = nextSessionInsights;
}

const { error: updateError } = await client
                        .from("memory_summary")
                        .update(updatePatch)
                        .eq("id", (existingSummary as any).id);
                  
                      if (updateError) {
                        console.error("Error updating memory_summary:", updateError);
                      }
                    } else {
                      const { data: insertedSummary, error: insertSummaryError } = await client
                        .from("memory_summary")
                        .insert({
                          user_id,
                          raw_id: anchorRawId,
                          conversation_id: effectiveConversationId,
                          // Required mirror column
                          short_summary: nextShort || safePlaceholderSummary((eligibility as any)?.summaryReason ?? (eligibility as any)?.reason ?? "unknown"),
                          // Deprecated column: never write
                          observations: obsOut,
                          chapter_key: summaryChapterKey1,
                          session_insights: nextSessionInsights,
                          created_at: new Date().toISOString(),
                          updated_at: new Date().toISOString(),
                        })
                        .select("id")
                        .maybeSingle();
                  
                      if (insertSummaryError) {
                        console.error("Error inserting into memory_summary:", insertSummaryError,
                        );
                      } else {
                        summaryIdForSeeds = insertedSummary?.id ?? null;
                      }
                    }
                  }
                  // De-dupe safety: ensure at most 1 memory_summary row per (user_id, raw_id).
                  // This protects against retry/double-trigger without requiring a DB unique index.
                  try {
                    const { data: dupRows, error: dupErr } = await client
                      .from("memory_summary")
                      .select("id, created_at")
                      .eq("user_id", user_id)
                      .eq("raw_id", anchorRawId)
                      .order("created_at", { ascending: false });

                    if (!dupErr && Array.isArray(dupRows) && dupRows.length > 1) {
                      const keepId = dupRows[0]?.id;
                      const deleteIds = dupRows.slice(1).map((r: any) => r.id).filter(Boolean);
                      if (keepId && deleteIds.length > 0) {
                        await client.from("memory_summary").delete().in("id", deleteIds);
                        // Keep the newest as the seed anchor
                        summaryIdForSeeds = keepId;
                      }
                    }
                  } catch (e) {
                    console.error("END_SESSION: de-dupe memory_summary failed:", e);
                  }

                  // 4b) Longitudinal theme pipeline (best-effort).
                  // This MUST NOT affect end-session success.
                  try {
                    const enableThemes = (Deno.env.get("ENABLE_THEME_PIPELINE") ?? "true").toLowerCase() !== "false";
                    if (enableThemes && summaryIdForSeeds && typeof (deps as any).extractSummaryThemesWithGemini === "function") {
                      const shortForThemes = String(nextShort ?? short_summary ?? "").trim();
                      const fullForThemes = String(
                        (nextSessionInsights as any)?.full_summary ??
                          (cleaned_session_insights as any)?.full_summary ??
                          full_summary ??
                          "",
                      ).trim();

                      if (shortForThemes) {
                        await upsertSummaryThemesAndClusters({
                          client,
                          user_id,
                          summary_id: summaryIdForSeeds,
                          short_summary: shortForThemes,
                          full_summary: fullForThemes || null,
                          extractor_version: "v1",
                          max_themes: 5,
                          similarity_threshold: 0.55,
                          extract: (deps as any).extractSummaryThemesWithGemini,
                        });
                        console.log("END_SESSION: theme pipeline OK", {
                          conversation_id: effectiveConversationId,
                          summary_id: summaryIdForSeeds,
                        });
                      }
                    } else if (!enableThemes) {
                      console.log("END_SESSION: theme pipeline skipped (ENABLE_THEME_PIPELINE=false)");
                    }
                  } catch (e) {
                    console.warn("END_SESSION: theme pipeline failed (non-fatal):", e?.message ?? e);
                  }

                  // 4c) Build “keep coming back” longitudinal snapshot (best-effort).
                  // This should work even when a session is not insights-eligible.
                  try {
                    if (summaryIdForSeeds) {
                      const snap0 = await buildLongitudinalSnapshotBestEffort({ client, user_id, nowIso });

                      // Prefer v2 if a generator is available and it passes rejection/quality gates.
                      let snapV2: LongitudinalSnapshotV2 | null = null;
                      try {
                        snapV2 = await buildLongitudinalSnapshotV2BestEffort({
                          client,
                          user_id,
                          nowIso,
                          anchorRawId,
                          deps,
                          preferredLocale,
                        });
                      } catch (e) {
                        // non-fatal
                        console.warn("END_SESSION: longitudinal snapshot v2 failed (non-fatal):", (e as any)?.message ?? e);
                      }

                      // Respect eligibility: if this session is not eligible, avoid showing it as driving “change” or “emerging”.
                      // We still show a snapshot, but it is explicitly “from prior sessions”.
                      const isInsightsEligible = Boolean(
                        (eligibility as any)?.eligible ?? (eligibility as any)?.insightsEligible ?? false,
                      );

                      const snap = (!snap0)
                        ? null
                        : (!isInsightsEligible)
                          ? ({
                              ...(snap0 as any),
                              from_prior_sessions: true,
                              emerging_themes_month: [],
                              changed_since_last_week: { up: [], down: [] },
                            } as any)
                          : snap0;

                      // Attach v2 if present.
                      if (snap && snapV2) {
                        (snap as any).v2 = snapV2;
                        (snap as any).ui_prefer_v2 = true;
                      }
                      // Always write a UI-ready observational paragraph (no advice).
                      // This does NOT depend on current-session eligibility, since it is "from prior sessions".
                      if (snap) {
                        const snapshotText = buildObservationalSnapshotText({ snap, preferredLocale });
                        if (snapshotText) {
                          (snap as any).snapshot_text = snapshotText;
                          (snap as any).snapshot_text_version = "heuristic_observational";
                        }
                      }


                      if (!snap) {
                        console.log("END_SESSION: longitudinal snapshot skipped (no data yet)", {
                          conversation_id: effectiveConversationId,
                          summary_id: summaryIdForSeeds,
                        });
                      }
                      if (snap) {
                        const mergedObs = { ...(obsOut ?? {}), longitudinal_snapshot: snap };
                        const { error: snapErr } = await client
                          .from("memory_summary")
                          .update({ observations: mergedObs, updated_at: new Date().toISOString() })
                          .eq("id", summaryIdForSeeds);
                        if (snapErr) {
                          console.warn("END_SESSION: longitudinal snapshot write failed (non-fatal):", snapErr);
                        } else {
                          console.log("END_SESSION: longitudinal snapshot OK", {
                            conversation_id: effectiveConversationId,
                            summary_id: summaryIdForSeeds,
                            has_v2: Boolean(snapV2),
                            emerging: (snap as any).emerging_themes_month?.map((x: any) => x.label) ?? [],
                            changed_up: (snap as any).changed_since_last_week?.up?.map((x: any) => x.label) ?? [],
                          });
                        }
                      }
                    }
                  } catch (e) {
                    console.warn("END_SESSION: longitudinal snapshot failed (non-fatal):", (e as any)?.message ?? e);
                  }
// 5) Heavy stuff (best-effort, never blocks end-session)

                  // 5a) Rebuild insights (optional) — run even if graph recompute fails.
                  try {
                    const insightsForce = envFlag("INSIGHTS_FORCE", false);
                    // Rebuild-insights is optional. It should never break end-session.
                    // Default: enabled unless explicitly disabled.
                    const enableRebuild = insightsForce || envFlag("END_SESSION_RUN_REBUILD_INSIGHTS", true);
                    const allow_llm = Boolean(Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_API_KEY") || Deno.env.get("GENAI_API_KEY"));

                    if (enableRebuild) {
                      // --- Impossible-to-miss audit trail for memory_insights writes ---
                      let preInsightAt: string | null = null;
                      try {
                        const { data: preRow } = await client
                          .from("memory_insights")
                          .select("created_at")
                          .eq("user_id", user_id)
                          .order("created_at", { ascending: false })
                          .limit(1)
                          .maybeSingle();
                        preInsightAt = preRow?.created_at ? String(preRow.created_at) : null;
                      } catch (_) {
                        // table may not exist / RLS; ignore here
                      }

                      console.log("INSIGHTS_DECISION_START", {
                        conversation_id: effectiveConversationId,
                        preInsightAt,
                      });

                      const rebuildText = await deps.invokeRebuildInsightsInternal({
                        user_id,
                        conversation_id: effectiveConversationId,
                        origin: "end_session",
                        lite: true,
                        force: insightsForce,
                        meaningful_longitudinal: true,
                        allow_llm,
                        eligibility_hint: {
                          eligible: Boolean((eligibility as any)?.eligible),
                          reason: String((eligibility as any)?.reason ?? ""),
                          userWordCount: Number((eligibility as any)?.userWordCount ?? 0),
                          userTurnCount: Number((eligibility as any)?.userTurnCount ?? 0),
                          scoreTotal: Number((eligibility as any)?.scoreTotal ?? 0),
                        },
                      });

                      let postInsightAt: string | null = null;
                      try {
                        const { data: postRow } = await client
                          .from("memory_insights")
                          .select("created_at")
                          .eq("user_id", user_id)
                          .order("created_at", { ascending: false })
                          .limit(1)
                          .maybeSingle();
                        postInsightAt = postRow?.created_at ? String(postRow.created_at) : null;
                      } catch (_) {}

                      const wroteNew = !!postInsightAt && postInsightAt != preInsightAt;
                      if (wroteNew) {
                        console.log("INSIGHTS_DECISION_WRITE", {
                          conversation_id: effectiveConversationId,
                          preInsightAt,
                          postInsightAt,
                        });
                      } else {
                        console.log("INSIGHTS_DECISION_SKIP", {
                          conversation_id: effectiveConversationId,
                          preInsightAt,
                          postInsightAt,
                          note: "No new memory_insights row observed after invoke.",
                        });
                      }

                      console.log("rebuild-insights invoke OK:", rebuildText);
                    } else {
                      console.log("rebuild-insights skipped (END_SESSION_RUN_REBUILD_INSIGHTS=false and INSIGHTS_FORCE=false)");
                    }
                  } catch (rebuildErr) {
                    console.log("INSIGHTS_DECISION_ERROR", {
                      conversation_id: effectiveConversationId,
                      message: String((rebuildErr as any)?.message ?? rebuildErr),
                    });
                    console.log("rebuild-insights invoke non-fatal (suppressed):", (rebuildErr as any)?.message ?? rebuildErr);
                  }

                  // 5b) Knowledge graphs + story seeds — best-effort only.
                  try {
                    await deps.recomputeUserKnowledgeGraphs(client, user_id);
                    await deps.upsertStorySeedsForConversation(
                      client,
                      user_id,
                      effectiveConversationId,
                      summaryIdForSeeds,
                    );
                  } catch (err) {
                    console.error("Error recomputing coverage / insights:", err);
                  }
                }
              }
            }