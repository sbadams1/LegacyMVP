import { buildLegacySystemPrompt, getLegacyPersonaInstructions } from "../../prompts/legacy.ts";
import { buildAvatarSystemPrompt, buildPronunciationScoringPrompt, buildLanguageLearningSystemPrompt } from "../../prompts/language.ts";
import { buildBeginnerModeAddon, buildBeginnerRewritePrompt } from "../../prompts/turn_core_language_prompts.ts";
import { buildLegacySessionSummaryPrompt, buildStorySeedsPrompt, buildExtractStoriesPrompt, buildSessionInsightsPrompt, buildCoverageClassificationPrompt } from "../../prompts/turn_core_prompts.ts";
import { TAGGING_CONTRACT, formatRecentLanguageLearningConversation } from "../../prompts/language_learning_contracts.ts";

// supabase/functions/ai-brain/pipelines/turn.ts
//
// Gemini 2.0 Flash Experimental "brain" for LegacyMVP.
// Supports:
// - Legacy mode: chapter-based interviews
// - Language learning mode: unit/lesson-based tutoring
//
// Now includes:
// - state_json for minimal structured state (legacy & language modes)
// - Strong anti-JSON / anti-Markdown rules for language-learning
// - sanitizeGeminiOutput() to strip code fences / JSON wrappers

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.48.0";
import {
  chooseExpansionForConcept,
  getConceptWithExpansion,
  PronunciationDrill,
  buildPronunciationDrill,
} from "../../../_shared/vocabulary.ts"; 
import { runEndSessionPipeline } from "../end_session.ts";
import { countWordsApprox } from "../../../_shared/text_utils.ts";

// ============================================================================
// ENV VARS & MODEL
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");

// NEW Supabase API keys may be non-JWT (e.g., "sb_secret_..."). We accept either:
// - legacy JWT-form service_role key ("eyJ..."), or
// - new "sb_secret_..." secret key from Dashboard > Settings > API Keys.
//
// You said you stored the service secret in Edge Secrets as SB_SECRET_KEY.
const SERVICE_ROLE_KEY =
  Deno.env.get("SB_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Shared secret for server-to-server Edge Function calls (set this in Supabase Edge Secrets)
const INTERNAL_FUNCTION_KEY = Deno.env.get("INTERNAL_FUNCTION_KEY");

function looksLikeLegacyJwt(token: string | null | undefined): boolean {
  return !!token && token.startsWith("eyJ") && token.split(".").length >= 3;
}

function looksLikeNewSbSecret(token: string | null | undefined): boolean {
  return !!token && token.startsWith("sb_secret_");
}

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "❌ Missing SUPABASE_URL or SB_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY.",
  );
} else if (
  !looksLikeLegacyJwt(SERVICE_ROLE_KEY) && !looksLikeNewSbSecret(SERVICE_ROLE_KEY)
) {
  console.error(
    "❌ Supabase service key does not look like a legacy JWT (eyJ...) or a new sb_secret_... key. " +
      `Key starts with: ${String(SERVICE_ROLE_KEY).slice(0, 10)}...`,
  );
}

// Use a service client for all server-side reads/writes & function-to-function calls.
//
// IMPORTANT: Do NOT force an Authorization: Bearer <service_key> header here.
// The new sb_secret_... keys are not JWTs, and sending them as Bearer tokens can trigger
// "Invalid JWT" errors when calling Edge Functions or other endpoints that expect JWT.
//
// Supabase-js will still include the apikey header, which is what the platform uses for key auth.
const supabase = SUPABASE_URL && SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: {
          apikey: SERVICE_ROLE_KEY,
        },
      },
    })
  : null;

const GEMINI_API_KEY =
  Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GEMINI_API_KEY_EDGE");

const GEMINI_MODEL =
  Deno.env.get("GEMINI_MODEL") ?? "gemini-2.0-flash-exp";

if (!GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY is NOT set in Supabase environment.");
}

// ============================================================================
// Types
// ============================================================================
type ConversationMode = "legacy" | "language_learning" | "avatar";
type LearningLevel = "beginner" | "intermediate" | "advanced";
type SupabaseClient = ReturnType<typeof createClient>;

interface AiBrainPayload {
  user_id: string;
  conversation_id?: string;
  message_text: string;

  end_session?: boolean;

  mode?: ConversationMode;
  preferred_locale?: string;
  target_locale?: string | null;
  learning_level?: LearningLevel;

  // Optional per-request persona override for legacy mode.
  // Allowed values match ConversationPersona: "adaptive" | "playful" | "grounded".
  conversation_persona?: ConversationPersona;

  // optional structured state
  state_json?: string | null;
}

// Optional: only needed if you later fetch from the profiles table directly
interface ProfileLanguages {
  preferred_language?: string | null;
  supported_languages?: string[] | null;
}

// --- Session-level legacy summarizer (Option A) -----------------------------

interface LegacyTranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

// Summarizer Contract
type SummarizerContext = {
  session_key?: string | null;
  chapter_id?: string | null;
  chapter_title?: string | null;
  preferred_locale?: string | null;
  target_locale?: string | null;
  learning_level?: string | null;
};

function tryExtractJsonObject(rawText: string): any | null {
  if (!rawText) return null;

  let text = String(rawText).trim();

  // 1) Remove common Gemini wrappers / code fences:
  //    ```json { ... } ```
  //    ``` { ... } ```
  //    (Sometimes there is leading prose; we still try to grab the first {...} block.)
  text = text.replace(/^﻿/, ""); // BOM
  text = text.replace(/```(?:json)?/gi, "```"); // normalize ```json -> ```
  if (text.includes("```")) {
    // If code fences exist, prefer the *inside* of the first fenced block.
    const firstFence = text.indexOf("```");
    const secondFence = text.indexOf("```", firstFence + 3);
    if (secondFence !== -1) {
      const inside = text.slice(firstFence + 3, secondFence).trim();
      if (inside) text = inside;
    }
  }

  // 2) Try direct parse.
  try {
    return JSON.parse(text);
  } catch {
    // 3) Fallback: extract the first JSON object substring.
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      const candidate = text.slice(first, last + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function summarizeLegacySessionWithGemini(
  transcript: LegacyTranscriptTurn[],
  ctx?: SummarizerContext,
): Promise<{
  short_summary: string;
  full_summary: string;
  observations: MemorySummaryObservations | null;
  session_insights: SessionInsightsJson | null;
} | null> {
  if (!transcript?.length) return null;

  // If Gemini not configured, fallback to something deterministic.
  if (!GEMINI_API_KEY) {
    const joined = transcript
      .map((t) => `${t.role === "user" ? "USER" : "AI"}: ${t.text}`)
      .join("\n");
    const trimmed = joined.trim();
    const shortSummary =
      trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed || "Legacy session";
    const fullSummary =
      trimmed.length > 400 ? `${trimmed.slice(0, 397)}...` : trimmed || shortSummary;

    return {
      short_summary: shortSummary,
      full_summary: fullSummary,
      observations: {
        chapter_keys: [],
        themes: [],
        word_count_estimate: Math.max(0, Math.floor(trimmed.split(/\s+/).length)),
      },
      session_insights: null,
    };
  }

  // Trim transcript to keep prompt size under control.
  const MAX_CHARS = 9000;
  const trimmedTurns: LegacyTranscriptTurn[] = [];
  let total = 0;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const t = transcript[i];
    const len = (t.text || "").length;
    if (total + len > MAX_CHARS && trimmedTurns.length > 0) break;
    trimmedTurns.push(t);
    total += len;
  }
  trimmedTurns.reverse();

  const transcriptText = trimmedTurns
    .map((t) => `${t.role === "user" ? "USER" : "AI"}: ${t.text}`)
    .join("\n");

  const allowedChapterKeys = [
    "early_childhood",
    "adolescence",
    "early_adulthood",
    "midlife",
    "later_life",
    "family_relationships",
    "work_career",
    "education",
    "health_wellbeing",
    "hobbies_interests",
    "beliefs_values",
    "major_events",
  ];

  const sessionKey = ctx?.session_key ?? null;
  const chapterId = ctx?.chapter_id ?? null;
  const chapterTitle = ctx?.chapter_title ?? null;

    const prompt = buildLegacySessionSummaryPrompt({
    transcriptText,
    sessionKey,
    chapterId,
    chapterTitle,
    allowedChapterKeys,
  });

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  };

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    if (!resp.ok) {
      console.error(
        "summarizeLegacySessionWithGemini: non-OK response",
        resp.status,
        await resp.text(),
      );
      return null;
    }

    const json = await resp.json();
    const text =
      json?.candidates?.[0]?.content?.parts?.[0]?.text ??
      json?.candidates?.[0]?.content?.parts?.[0]?.rawText ??
      "";

    const parsed = tryExtractJsonObject(text);
    if (!parsed) {
      console.error("summarizeLegacySessionWithGemini: failed to parse JSON");
      return null;
    }

    const short_summary = typeof parsed.short_summary === "string" ? parsed.short_summary.trim() : "";
    const full_summary = typeof parsed.full_summary === "string" ? parsed.full_summary.trim() : "";

    // observations is optional but strongly preferred
    const observations: MemorySummaryObservations | null =
      parsed.observations && typeof parsed.observations === "object" ? parsed.observations : null;

    // session_insights is optional but strongly preferred
    const session_insights: SessionInsightsJson | null =
      parsed.session_insights && typeof parsed.session_insights === "object"
        ? parsed.session_insights
        : null;

    if (!short_summary || !full_summary) {
      console.error("summarizeLegacySessionWithGemini: missing summaries");
      return null;
    }

    return { short_summary, full_summary, observations, session_insights };
  } catch (err) {
    console.error("summarizeLegacySessionWithGemini: unexpected error", err);
    return null;
  }
}

  /**
   * Fetch the existing transcript for a legacy session from memory_raw,
   * but apply donor edits as an overlay (without overwriting the original).
   *
   * - Original content remains authoritative in memory_raw.
   * - Edits (memory_raw_edits) are used ONLY when:
   *     - is_current = true
   *     - and use_for includes "summarization"
   */
  async function fetchLegacySessionTranscript(
    client: SupabaseClient,
    userId: string,
    conversationId: string,
  ): Promise<LegacyTranscriptTurn[]> {
    try {
      // 1) Pull raw turns (include id so we can map edits)
      const { data, error } = await client
        .from("memory_raw")
        .select("id, role, content, created_at")
        .eq("user_id", userId)
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .limit(200);

      if (error) {
        console.error("fetchLegacySessionTranscript: memory_raw select error:", error);
        return [];
      }

      const rawRows = (data ?? []) as any[];
      if (!rawRows.length) return [];

      const rawIds = rawRows
        .map((r) => String(r?.id ?? "").trim())
        .filter(Boolean);

      // 2) Pull active edits for these raw ids (if any)
      const editMap = new Map<string, any>();

      if (rawIds.length) {
        // Some deployments may not have all columns (e.g. is_current) or may hit PostgREST
        // "Bad Request" limits with large IN() lists. Chunk + retry defensively.
        const CHUNK = 80; // smaller to avoid PostgREST 400 on long IN() lists

        const fetchChunk = async (ids: string[]) => {
          const tryQueries: Array<
            () => Promise<{ data: any[] | null; error: any | null }>
          > = [
            async () =>
              await client
                .from("memory_raw_edits")
                .select("raw_id, edited_content, use_for, is_current")
                .eq("user_id", userId)
                .eq("status", "active")
                .contains("use_for", ["summarization"])
                .in("raw_id", ids)
                .eq("is_current", true),
            async () =>
              await client
                .from("memory_raw_edits")
                .select("raw_id, edited_content, use_for")
                .eq("user_id", userId)
                .eq("status", "active")
                .in("raw_id", ids),
            async () =>
              await client
                .from("memory_raw_edits")
                .select("*")
                .eq("user_id", userId)
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
            console.error("fetchLegacySessionTranscript: memory_raw_edits select error:", {
              message: e2?.message ?? String(e2),
              details: e2?.details,
              hint: e2?.hint,
              code: e2?.code,
            });
            break; // best-effort overlay only
          }

          for (const e of (edits ?? []) as any[]) {
            const rid = String(e?.raw_id ?? "").trim();
            if (rid) editMap.set(rid, e);
          }
        }
      }
      // 3) Build transcript for Gemini summarization (effective_text)
      const transcript: LegacyTranscriptTurn[] = [];

      for (const row of rawRows) {
        const rawId = String(row?.id ?? "").trim();
        const roleRaw = (row?.role as string | null) ?? "user";
        const baseText = String(row?.content ?? "").trim();
        if (!baseText) continue;

        const role: "user" | "assistant" =
          roleRaw === "assistant" ? "assistant" : "user";

        const edit = rawId ? editMap.get(rawId) : null;

        // Only use edit if it declares it should be used for summarization
        const useFor: string[] = Array.isArray(edit?.use_for) ? edit.use_for : [];
        const canUseEditForSummary = useFor.includes("summarization");

        const effective = canUseEditForSummary
          ? String(edit?.edited_content ?? "").trim()
          : baseText;

        if (!effective) continue;

        transcript.push({ role, text: effective });
      }

      return transcript;
    } catch (err) {
      console.error("fetchLegacySessionTranscript unexpected error:", err);
      return [];
    }
  }

/**
 * Upsert curated stories for a given legacy conversation into memory_curated.
 * Best-effort: logs errors but never throws.
 *
 * NOTE: This assumes memory_curated has at least:
 *   user_id, story_key, title, curated_text, tags, traits, metadata (jsonb)
 */
async function upsertCuratedStoriesForConversation(
  client: SupabaseClient,
  userId: string,
  conversationId: string,
  transcript: LegacyTranscriptTurn[],
): Promise<void> {
  if (!transcript.length) return;

  const transcriptText = transcript
    .map((t) => `${t.role === "user" ? "USER" : "AI"}: ${t.text}`)
    .join("\n");

  // Try to extract structured stories with Gemini.
  let seeds = await extractStoriesFromTranscript(transcriptText);

  // Fallback: if Gemini returns no stories, still capture a simple
  // session-level story so memory_curated always gets something.
  if (!seeds.length) {
    const fallbackKey = `session_${conversationId}`;
    const fallbackTitle = "Session recap";

    seeds = [
      {
        story_key: fallbackKey,
        title: fallbackTitle,
        body: transcriptText.slice(0, 4000),
        tags: ["fallback", "session_recap"],
        traits: [],
      },
    ];
  }

  for (const seed of seeds) {
    // existing loop body unchanged...

    try {
      const { data: existing, error: existingError } = await client
        .from("memory_curated")
        .select("id, story_key, metadata")
        .eq("user_id", userId)
        .eq("story_key", seed.story_key)
        .limit(1)
        .maybeSingle();

      if (existingError) {
        console.error(
          "upsertCuratedStoriesForConversation select error:",
          existingError,
        );
        continue;
      }

      if (existing) {
        const metadata = (existing.metadata as any) ?? {};
        const existingSessions: string[] = Array.isArray(
          metadata.conversation_ids,
        )
          ? metadata.conversation_ids
          : [];
        const mergedSessions = Array.from(
          new Set([...existingSessions, conversationId]),
        );

        const { error: updateError } = await client
          .from("memory_curated")
          .update({
            title: seed.title,
            curated_text: seed.body,
            tags: seed.tags ?? null,
            traits: seed.traits ?? null,
            metadata: {
              ...metadata,
              conversation_ids: mergedSessions,
            },
          })
          .eq("id", existing.id);

        if (updateError) {
          console.error(
            "upsertCuratedStoriesForConversation update error:",
            updateError,
          );
        }
      } else {
        const { error: insertError } = await client
          .from("memory_curated")
          .insert({
            user_id: userId,
            story_key: seed.story_key,
            title: seed.title,
            curated_text: seed.body,
            tags: seed.tags ?? null,
            traits: seed.traits ?? null,
            metadata: {
              conversation_ids: [conversationId],
            },
          });

        if (insertError) {
          console.error(
            "upsertCuratedStoriesForConversation insert error:",
            insertError,
          );
        }
      }
    } catch (err) {
      console.error(
        "upsertCuratedStoriesForConversation unexpected error:",
        err,
      );
    }
  }
}

// ============================================================================
// Story Seeds (story_seeds)
// ============================================================================

type StorySeedRowInsert = {
  user_id: string;
  summary_id?: string | null;
  conversation_id?: string | null;
  title: string;
  seed_text: string;
  canonical_facts: Record<string, any>;
  entities: any[];
  tags: string[];
  time_span?: any | null;
  confidence: number;
  source_raw_ids: string[];
  source_edit_ids: string[];
};

async function extractStorySeedsWithGemini(
  transcriptText: string,
): Promise<
  Array<{
    title: string;
    seed_text: string;
    canonical_facts: Record<string, any>;
    entities: any[];
    tags: string[];
    time_span?: any | null;
    confidence?: number;
  }>
> {
  const trimmed = String(transcriptText ?? "").trim();
  if (!trimmed) return [];

  // Keep prompt size bounded.
  const MAX_CHARS = 11000;
  const clipped = trimmed.length > MAX_CHARS ? trimmed.slice(-MAX_CHARS) : trimmed;

    const prompt = buildStorySeedsPrompt({ transcriptText: clipped });

  const raw = await callGemini(prompt);

  const parsed = tryExtractJsonObject(raw);
  const seedsRaw = Array.isArray((parsed as any)?.seeds) ? (parsed as any).seeds : (Array.isArray(parsed) ? parsed : []);
  if (!Array.isArray(seedsRaw)) return [];

  const out: any[] = [];
  for (const s of seedsRaw) {
    const title = typeof s?.title === "string" ? s.title.trim() : "";
    const seed_text = typeof s?.seed_text === "string" ? s.seed_text.trim() : "";
    if (!title || !seed_text) continue;

    const canonical_facts =
      s?.canonical_facts && typeof s.canonical_facts === "object" ? s.canonical_facts : {};
    const entities = Array.isArray(s?.entities) ? s.entities : [];
    const tags = Array.isArray(s?.tags) ? s.tags.map((t: any) => String(t)).filter(Boolean) : [];
    const time_span = s?.time_span ?? null;

    let confidence = typeof s?.confidence === "number" ? s.confidence : 0.7;
    if (!Number.isFinite(confidence)) confidence = 0.7;
    confidence = Math.max(0, Math.min(1, confidence));

    out.push({ title, seed_text, canonical_facts, entities, tags, time_span, confidence });
  }

  return out;
}

async function upsertStorySeedsForConversation(
  client: SupabaseClient,
  userId: string,
  conversationId: string,
  summaryId?: string | null,
): Promise<void> {
  try {
    // Pull an edit-overlay transcript (so your donor edits affect seeds).
    const transcript = await fetchLegacySessionTranscript(client, userId, conversationId);
    if (!transcript.length) return;

    const transcriptText = transcript
      .map((t) => `${t.role === "user" ? "USER" : "AI"}: ${t.text}`)
      .join("\n");

    // Source raw ids for provenance
    const { data: rawRows, error: rawErr } = await client
      .from("memory_raw")
      .select("id")
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(250);

    if (rawErr) console.error("upsertStorySeedsForConversation raw id select error:", rawErr);

    const rawIds: string[] = Array.isArray(rawRows)
      ? rawRows.map((r: any) => String(r?.id ?? "")).filter(Boolean)
      : [];

    const seeds = await extractStorySeedsWithGemini(transcriptText);
    if (!seeds.length) return;

    // Avoid duplicates: replace the seeds for this session.
    const del = await client
      .from("story_seeds")
      .delete()
      .eq("user_id", userId)
      .eq("conversation_id", conversationId);
    if (del.error) {
      console.error("upsertStorySeedsForConversation delete error:", del.error);
    }

    const rows: StorySeedRowInsert[] = seeds.map((s) => ({
      user_id: userId,
      summary_id: summaryId ?? null,
      conversation_id: conversationId,
      title: s.title,
      seed_text: s.seed_text,
      canonical_facts: s.canonical_facts ?? {},
      entities: Array.isArray(s.entities) ? s.entities : [],
      tags: Array.isArray(s.tags) ? s.tags : [],
      time_span: s.time_span ?? null,
      confidence: typeof s.confidence === "number" ? s.confidence : 0.7,
      source_raw_ids: rawIds,
      source_edit_ids: [],
    }));

    const ins = await client.from("story_seeds").insert(rows);
    if (ins.error) {
      console.error("upsertStorySeedsForConversation insert error:", ins.error);
    } else {
      console.log(`✅ story_seeds inserted: ${rows.length}`);
    }
  } catch (err) {
    console.error("upsertStorySeedsForConversation unexpected error:", err);
  }
}


// ------- LEGACY STATE & CATALOG --------------------------------------------
interface LegacyInterviewState {
  chapter_id: string;
  chapter_title: string;
  progress_percent: number; // 0–100
  focus_topic: string | null;
}

interface LegacyChapterConfig {
  chapter_id: string;
  chapter_title: string;
  goal: string;
  default_focus_topic: string | null;
  topics: string[];
}

interface LegacyPromptContext {
  // Persona flavor for the conversation ("adaptive", "playful", "grounded").
  persona: ConversationPersona;

  // Optional: a display name if you later pull it from profiles.
  userDisplayName?: string | null;

  // Language routing
  preferredLocale: string;
  targetLocale: string | null;

  // Optional: brief natural-language summary of coverage so far.
  coverageSummary?: string | null;

  // Current minimal state for the legacy interview.
  legacyState: LegacyInterviewState;

  // The chapter config the model should treat as "current".
  currentChapter: LegacyChapterConfig;
}

// Expanded catalog of life chapters.
// NOTE: We keep "childhood" and "early_career" for backward compatibility
// with any existing state_json, and add additional stages.
const LEGACY_CHAPTERS: Record<string, LegacyChapterConfig> = {
  childhood: {
    chapter_id: "childhood",
    chapter_title: "Childhood & Family Background",
    goal:
      "Capture memories about family, home environment, early influences, and early school years.",
    default_focus_topic: "family_background",
    topics: [
      "family_background",
      "childhood_home",
      "siblings_and_parents",
      "school_years",
      "friends_and_play",
      "earliest_memory",
    ],
  },

  adolescence: {
    chapter_id: "adolescence",
    chapter_title: "Adolescence & Teenage Years",
    goal:
      "Capture stories from the teen years: identity, school, friendships, early independence, and formative experiences.",
    default_focus_topic: "high_school_years",
    topics: [
      "high_school_years",
      "close_friendships",
      "early_romantic_relationships",
      "sports_and_activities",
      "big_mistakes_and_lessons",
    ],
  },

  early_career: {
    chapter_id: "early_career",
    chapter_title: "Early Career & First Jobs",
    goal:
      "Capture stories about first serious jobs, career direction, mentors, early wins, failures, and early adult independence.",
    default_focus_topic: "first_full_time_job",
    topics: [
      "first_full_time_job",
      "why_chosen_field",
      "early_mentors",
      "early_failures",
      "early_successes",
      "moving_out_on_your_own",
    ],
  },

  midlife: {
    chapter_id: "midlife",
    chapter_title: "Midlife, Responsibility & Growth",
    goal:
      "Capture stories from the middle stretch of life: work responsibilities, parenting, big projects, major stresses, and achievements.",
    default_focus_topic: "mid_career_responsibilities",
    topics: [
      "mid_career_responsibilities",
      "raising_children_or_guiding_others",
      "financial_highs_and_lows",
      "stress_and_burnout",
      "proudest_midlife_achievements",
    ],
  },

  later_life: {
    chapter_id: "later_life",
    chapter_title: "Later Life & Reflection",
    goal:
      "Capture reflections from later years: retirement, slowing down, health, legacy, and hopes for the future.",
    default_focus_topic: "retirement_transition",
    topics: [
      "retirement_transition",
      "changes_in_daily_routine",
      "health_challenges",
      "maintaining_purpose",
      "lessons_for_future_generations",
    ],
  },

  family_relationships: {
    chapter_id: "family_relationships",
    chapter_title: "Family, Relationships & Loved Ones",
    goal:
      "Capture stories about close relationships: partners, children, siblings, parents, and chosen family.",
    default_focus_topic: "most_important_relationships",
    topics: [
      "meeting_a_partner",
      "marriage_or_long_term_partnership",
      "children_and_parenting",
      "relationship_challenges",
      "most_important_relationships",
      "what_love_means_to_you",
    ],
  },

  beliefs_values: {
    chapter_id: "beliefs_values",
    chapter_title: "Beliefs, Values & Meaning",
    goal:
      "Capture how the donor thinks about meaning, morality, spirituality or worldview, and how values guided their choices.",
    default_focus_topic: "guiding_values",
    topics: [
      "guiding_values",
      "beliefs_about_right_and_wrong",
      "spiritual_or_philosophical_views",
      "how_values_changed_over_time",
      "what_you_hope_to_pass_on",
    ],
  },

  hobbies_interests: {
    chapter_id: "hobbies_interests",
    chapter_title: "Hobbies, Interests & Passions",
    goal:
      "Capture stories about activities that brought joy, curiosity, or flow across the years.",
    default_focus_topic: "favorite_hobby",
    topics: [
      "favorite_hobby",
      "creative_pursuits",
      "sports_and_outdoors",
      "learning_new_skills",
      "how_you_relax_and_have_fun",
    ],
  },

  major_events: {
    chapter_id: "major_events",
    chapter_title: "Major Life Events & Turning Points",
    goal:
      "Capture the key turning points: moves, losses, crises, triumphs, and decisions that changed the course of life.",
    default_focus_topic: "biggest_turning_point",
    topics: [
      "biggest_turning_point",
      "relocating_to_a_new_place",
      "career_pivots",
      "serious_losses_or_grief",
      "moments_of_breakthrough_or_reinvention",
    ],
  },
};

interface LanguageTargetPhrase {
  /** Main phrase in the target language script (target language, etc.) */
  l2_script: string;

  /** Stable concept key from concept_master (e.g. "RUN_PHYSICAL_MOVE"). */
  concept_key?: string;

  /** Short L1 gloss for the learner (e.g. "run (physically)"). */
  l1_gloss?: string;

  /** Optional IPA transcription for internal use. */
  ipa?: string;

  /** Optional L2 example sentence using this phrase. */
  example_l2?: string;

  /** Optional L1 translation of that example sentence. */
  example_l1?: string;

  /** Optional structured drill recipe derived from vocabulary_expansions.drill_steps. */
  drill?: PronunciationDrill | null;
}

interface LanguageLessonState {
  unit_id: string; // e.g. U1_GREETINGS
  lesson_id: string; // e.g. L1_HELLO_BASICS
  stage: string; // intro | guided_practice | free_practice | review
  target_phrases: LanguageTargetPhrase[];
  // How many times the learner has seen/practiced the main phrase for this lesson.
  times_seen_main_phrase: number;
  // Whether the learner is considered to have basically mastered the main phrase.
  has_mastered_main_phrase: boolean;
}

// Qualitative observations about a single distilled memory summary.
// All scores are 0–1, where higher means "more of this quality".
interface MemorySummaryObservations {
  // Which coverage chapters this summary contributes to.
  chapter_keys?: CoverageChapterKey[];

  // Optional richer chapter entries if/when we add them later.
  coverage_chapters?: {
    key: CoverageChapterKey;
    weight?: number | null;
    confidence?: number | null;
  }[];

  // Optional time span in years.
  start_year?: number;
  end_year?: number;

  // Rough size of the original material.
  word_count_estimate?: number;

  // Tags/themes this memory touches.
  themes?: string[];
  insight_tags?: string[];

  // Qualitative richness (0–1). These will be filled by the summariser.
  narrative_depth_score?: number;     // How much story & concrete detail?
  emotional_depth_score?: number;     // How much emotion is present?
  reflection_score?: number;          // How much “what it meant / what I learned”?
  distinctiveness_score?: number;     // How non-generic / personally specific?

  // Optional pre-computed “this memory is rich” weight (0–1).
  memory_weight?: number;

  // Optional: flags for “don’t over-stereotype this”.
  stereotype_risk_flags?: string[];
}

interface MemorySummaryRow {
  id: string;
  user_id: string;
  raw_id: string;
  created_at: string; // ISO
  short_summary: string | null;
  full_summary: string | null;
  observations: MemorySummaryObservations | null;
}

interface SessionInsightItem {
  id: string;
  kind: "trait" | "theme" | "value" | "behavior";
  text: string;
  strength?: number;
}

interface SessionInsightsJson {
  session_id: string;
  conversation_id: string;
  key_sentence: string;
  items: SessionInsightItem[];
}

async function extractStoriesFromTranscript(
  transcriptText: string,
): Promise<StorySeed[]> {
  if (!transcriptText.trim() || !GEMINI_API_KEY) return [];

    const prompt = buildExtractStoriesPrompt({ transcriptText });

  const body = {
    contents: [
      { role: "user", parts: [{ text: prompt }] },
    ],
  };

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    if (!resp.ok) {
      console.error("extractStoriesFromTranscript Gemini error", resp.status, await resp.text());
      return [];
    }

    const json = await resp.json();
    const text =
      json?.candidates?.[0]?.content?.parts?.[0]?.text ??
      json?.candidates?.[0]?.content?.parts?.[0]?.rawText ??
      "";

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = String(text).match(/\{[\s\S]*\}/);
      if (!match) return [];
      parsed = JSON.parse(match[0]);
    }

    const rawStories = Array.isArray(parsed?.stories) ? parsed.stories : [];
    return rawStories.map((s: any): StorySeed => ({
      story_key: String(s.story_key ?? "").trim(),
      title: String(s.title ?? "").trim(),
      body: String(s.body ?? "").trim(),
      tags: Array.isArray(s.tags) ? s.tags.map((t: any) => String(t)) : [],
      traits: Array.isArray(s.traits) ? s.traits.map((t: any) => String(t)) : [],
    })).filter((s) => s.story_key && s.title && s.body);
  } catch (err) {
    console.error("extractStoriesFromTranscript failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pronunciation diagnostics (from STT → Gemini → app)
// ---------------------------------------------------------------------------

interface PronunciationWordDiagnostic {
  /** The surface word or chunk in the learner's utterance (L2 script if available). */
  word: string;

  /** Optional IPA for this word or chunk (for the AI, not for direct display). */
  ipa?: string | null;

  /** Start time of this word in the utterance, in milliseconds. */
  start_ms?: number | null;

  /** End time of this word in the utterance, in milliseconds. */
  end_ms?: number | null;

  /**
   * Coarse correctness bucket for this word.
   * - "good": clearly understandable and close to target.
   * - "ok": understandable but with noticeable deviation.
   * - "weak": hard to understand or clearly incorrect.
   */
  correctness: "good" | "ok" | "weak";

  /** Short issue labels for this word, e.g. ["tone", "final_consonant"]. */
  issues: string[];

  /** Concrete tips focused on this word, in L1-language description. */
  tips: string[];
}

interface PronunciationDiagnostic {
  /** Optional ID so the client can correlate this with stored attempts. */
  attempt_id?: string;

  /** Locale used by STT for this utterance, e.g. "xx-XX". */
  locale: string;

  /** Target phrase in L2 script that the learner was trying to say. */
  target_phrase_l2: string;

  /** Optional IPA for the target phrase (for the AI's internal use). */
  target_phrase_ipa?: string | null;

  /** Raw transcript text of what the learner actually said (L2). */
  transcript_text: string;

  /** Per-word / per-chunk diagnostics. */
  words: PronunciationWordDiagnostic[];

  /**
   * One or two sentences (in L1) summarising the pronunciation in friendly terms.
   * This is what we will usually show to the learner.
   */
  overall_comment: string;

  /**
   * High-level issue tags across the whole phrase, e.g.
   * ["tones", "final_consonant", "vowel_length"].
   */
  summary_issues: string[];

  /**
   * 1–3 short focus phrases describing what to practice next, e.g.
   * ["keep the last tone low and steady", "hold the long vowel a bit longer"].
   */
  recommended_focus: string[];
}

// NEW: container that tracks progress per language (th, es, etc.)
interface MultiLanguageLessonContainer {
  // version so we can evolve the shape in the future if needed
  version?: number;
  // which language key was active most recently ("th", "es", etc.)
  current_language?: string | null;
  // Map of language key → per-language lesson state
  languages: Record<string, LanguageLessonState>;
}

interface LanguageLessonConfig {
  lesson_id: string;
  lesson_name: string;
  default_stage: string;
  default_target_phrases: LanguageTargetPhrase[];
}

interface LanguageUnitConfig {
  unit_id: string;
  unit_name: string;
  lessons: Record<string, LanguageLessonConfig>;
}

// High-level persona flavors for legacy mode.
export type ConversationPersona = "adaptive" | "playful" | "somber";

// ===== Coverage & Lifetime types =====

export type CoverageChapterKey =
  | "early_childhood"
  | "adolescence"
  | "early_adulthood"
  | "midlife"
  | "later_life"
  | "family_relationships"
  | "work_career"
  | "education"
  | "health_wellbeing"
  | "hobbies_interests"
  | "beliefs_values"
  | "major_events";

export interface CoverageChapter {
  key: CoverageChapterKey;
  label: string;

  // 0.0–1.0; we still store a normalized score here.
  coverage_score: number;

  // Simple counts for debugging + UI.
  memory_count: number;
  word_count_estimate: number;

  // Sum of qualitative “weight” of memories mapped here.
  // A rich, detailed memory will usually contribute somewhere around ~1.0.
  total_weight: number;

  time_span?: {
    start_year?: number;
    end_year?: number;
  };
  last_covered_at?: string;         // ISO
  example_memory_ids: string[];
  summary_snippet?: string;
  open_questions: string[];
  suggested_prompts: string[];
}

export interface CoverageMap {
  version: number;
  user_id: string;
  last_updated: string;
  global: {
    total_memories: number;
    total_words_estimate: number;
    earliest_year?: number;
    latest_year?: number;
    dominant_themes: string[];
  };
  chapters: {
    [key in CoverageChapterKey]: CoverageChapter;
  };
}

function clamp01(value: unknown, fallback = 0): number {
  const n =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function computeMemoryWeightFromObservations(
  obs: MemorySummaryObservations,
  roughWordCount: number,
): number {
  // If the summariser has explicitly set memory_weight, respect it.
  if (typeof obs.memory_weight === "number") {
    const w = obs.memory_weight;
    if (!Number.isFinite(w)) return 0;
    return Math.max(0, Math.min(1, w));
  }

  const depth =
    typeof obs.narrative_depth_score === "number"
      ? obs.narrative_depth_score
      : 0.3;
  const emotional =
    typeof obs.emotional_depth_score === "number"
      ? obs.emotional_depth_score
      : 0.3;
  const reflection =
    typeof obs.reflection_score === "number"
      ? obs.reflection_score
      : 0.3;
  const distinct =
    typeof obs.distinctiveness_score === "number"
      ? obs.distinctiveness_score
      : 0.3;

  const quality = (depth + emotional + reflection + distinct) / 4;

  // Word-count factor: clips so that long rambling doesn’t explode the score.
  const wcFactor =
    roughWordCount > 0
      ? Math.min(1, Math.log10(roughWordCount + 10) / 3)
      : 0;

  const combined = 0.7 * quality + 0.3 * wcFactor;

  if (!Number.isFinite(combined) || combined <= 0) return 0;
  if (combined > 1) return 1;
  return combined;
}

// ---------------------------------------------------------------------------
// Coverage classification helpers
// ---------------------------------------------------------------------------

function normalizeCoverageChapterKey(
  raw: unknown,
): CoverageChapterKey | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();

  switch (key) {
    case "early_childhood":
    case "childhood":
    case "0-10":
    case "0–10":
      return "early_childhood";

    case "adolescence":
    case "teen":
    case "teens":
    case "11-18":
    case "11–18":
      return "adolescence";

    case "early_adulthood":
    case "young_adult":
    case "20s":
    case "19-30":
    case "19–30":
      return "early_adulthood";

    case "midlife":
    case "31-55":
    case "31–55":
      return "midlife";

    case "later_life":
    case "retirement":
    case "56+":
      return "later_life";

    case "family_relationships":
    case "family":
    case "relationships":
    case "romantic":
    case "partner":
      return "family_relationships";

    case "work_career":
    case "career":
    case "work":
    case "job":
      return "work_career";

    case "education":
    case "school":
    case "university":
    case "college":
      return "education";

    case "health_wellbeing":
    case "health":
    case "wellbeing":
    case "mental_health":
      return "health_wellbeing";

    case "hobbies_interests":
    case "hobbies":
    case "interests":
    case "free_time":
      return "hobbies_interests";

    case "beliefs_values":
    case "beliefs":
    case "values":
    case "spirituality":
      return "beliefs_values";

    case "major_events":
    case "events":
    case "milestones":
    case "turning_point":
      return "major_events";

    default:
      return null;
  }
}

async function extractSessionInsightsFromSummary(
  fullSummary: string,
  conversationId: string,
  sessionId: string,
): Promise<SessionInsightsJson | null> {
  const trimmed = fullSummary.trim();
  if (!trimmed || !GEMINI_API_KEY) return null;

  const prompt = buildSessionInsightsPrompt({ fullSummary: trimmed });

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
  };

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    if (!resp.ok) {
      console.error("extractSessionInsightsFromSummary: Gemini error", resp.status, await resp.text());
      return null;
    }

    const json = await resp.json();
    const text =
      json?.candidates?.[0]?.content?.parts?.[0]?.text ??
      json?.candidates?.[0]?.content?.parts?.[0]?.rawText ??
      "";

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = String(text).match(/\{[\s\S]*\}/);
      if (!match) return null;
      parsed = JSON.parse(match[0]);
    }

    const keySentence = (parsed?.key_sentence as string | undefined)?.trim();
    const items = Array.isArray(parsed?.items) ? parsed.items : [];

    if (!keySentence || !items.length) return null;

    const insights: SessionInsightsJson = {
      session_id: sessionId,
      conversation_id: conversationId,
      key_sentence: keySentence,
      items: items.map((it: any): SessionInsightItem => ({
        id: String(it.id ?? "unknown"),
        kind:
          it.kind === "theme" ||
          it.kind === "value" ||
          it.kind === "behavior"
            ? it.kind
            : "trait",
        text: String(it.text ?? "").trim(),
        strength:
          typeof it.strength === "number" ? it.strength : undefined,
      })),
    };

    return insights;
  } catch (err) {
    console.error("extractSessionInsightsFromSummary failed:", err);
    return null;
  }
}

async function upsertCuratedStoriesForSession(
  client: SupabaseClient,
  userId: string,
  sessionId: string,        // memory_summary.id
  conversationId: string,   // conversation_id / session_key
  transcriptText: string,
) {
  const seeds = await extractStoriesFromTranscript(transcriptText);
  if (!seeds.length) return;

  for (const seed of seeds) {
    // Check if this story_key already exists for this user
    const { data: existing, error: selectError } = await client
      .from("memory_curated")
      .select("id, source_session_ids")
      .eq("user_id", userId)
      .eq("story_key", seed.story_key)
      .maybeSingle();

    if (selectError) {
      console.error("upsertCuratedStoriesForSession select error:", selectError);
      continue;
    }

    if (existing) {
      // Merge session into source_session_ids and update body/title/tags/traits
      const existingSessions: string[] =
        (existing.source_session_ids as string[] | null) ?? [];
      const mergedSessions = Array.from(
        new Set([...existingSessions, sessionId]),
      );

      const { error: updateError } = await client
        .from("memory_curated")
        .update({
          title: seed.title,
          curated_text: seed.body,
          tags: seed.tags ?? null,
          traits: seed.traits ?? null,
          source_session_ids: mergedSessions,
        })
        .eq("id", existing.id);

      if (updateError) {
        console.error("upsertCuratedStoriesForSession update error:", updateError);
      }
    } else {
      // Insert a new curated story
      const { error: insertError } = await client
        .from("memory_curated")
        .insert({
          user_id: userId,
          memory_summary_id: sessionId,
          story_key: seed.story_key,
          title: seed.title,
          curated_text: seed.body,
          tags: seed.tags ?? null,
          traits: seed.traits ?? null,
          source_session_ids: [sessionId],
          metadata: {
            conversation_id: conversationId,
          },
        });

      if (insertError) {
        console.error("upsertCuratedStoriesForSession insert error:", insertError);
      }
    }
  }
}

async function classifyCoverageFromStoryText(
  storyText: string,
): Promise<{ chapterKeys: CoverageChapterKey[]; themes: string[] } | null> {
  const trimmed = storyText.trim();
  if (!trimmed) return null;

    const prompt = buildCoverageClassificationPrompt({
    storyText: trimmed,
    allowedChapterKeys: [
      "early_childhood",
      "adolescence",
      "early_adulthood",
      "midlife",
      "later_life",
      "family_relationships",
      "work_career",
      "education",
      "health_wellbeing",
      "hobbies_interests",
      "beliefs_values",
      "major_events",
    ],
  });

  const raw = await callGemini(prompt);

  try {
    const jsonText = extractJsonCandidate(raw) ?? raw;
    const parsed = JSON.parse(jsonText);
    // Support both explicit ranked fields and legacy chapter_keys array.
    const rawPrimary: unknown = (parsed as any).primary_chapter_key;
    const rawSecondary: unknown = (parsed as any).secondary_chapter_key;
    const rawTertiary: unknown = (parsed as any).tertiary_chapter_key;
    const rawKeys: unknown = (parsed as any).chapter_keys;

    const ordered: CoverageChapterKey[] = [];

    for (const candidate of [rawPrimary, rawSecondary, rawTertiary]) {
      const norm = normalizeCoverageChapterKey(candidate);
      if (norm && !ordered.includes(norm)) ordered.push(norm);
    }

    if (ordered.length === 0 && Array.isArray(rawKeys)) {
      for (const k of rawKeys) {
        const norm = normalizeCoverageChapterKey(k);
        if (norm && !ordered.includes(norm)) ordered.push(norm);
      }
    }

    const chapterKeys: CoverageChapterKey[] = ordered.slice(0, 3);

    if (chapterKeys.length === 0) {
      // Fallback: single generic bucket
      chapterKeys.push("major_events");
    }

    const themes: string[] = Array.isArray(parsed.themes)
      ? parsed.themes
          .filter((t: unknown) => typeof t === "string")
          .map((t: string) => t.trim())
          .filter((t: string) => t.length > 0)
      : [];

    return { chapterKeys, themes };
  } catch (err) {
    console.error("Coverage classification parse error:", err);
    return null;
  }
}

export interface LifetimeProfile {
  version: number;
  user_id: string;
  last_updated: string;
  core_identity: {
    legal_name?: string;
    display_name?: string;
    birth_date?: string;
    birth_year_estimate?: number;
    birth_place?: string;
    current_location?: string;
    generation_label?: string;
  };
  life_themes: {
    summary_sentence: string;
    recurring_challenges: string[];
    recurring_strengths: string[];
    legacy_hopes: string[];
  };
  interests_hobbies: {
    main_hobbies: string[];
    creative_outlets?: string[];
    recurring_topics?: string[];
  };
}

// Language-agnostic curriculum outline.
// Gemini uses these unit / lesson names plus the guardrails in
// buildLanguageLearningSystemPrompt() to choose concrete L2 phrases.
const LANGUAGE_UNITS: Record<string, LanguageUnitConfig> = {
  // ---------------------------------------------------------------------------
  // U1 – Greetings & Social Basics (roughly A1)
  // ---------------------------------------------------------------------------
  U1_GREETINGS: {
    unit_id: "U1_GREETINGS",
    unit_name: "Greetings & Social Basics",
    lessons: {
      // Saying hello, basic politeness, first contact.
      L1_HELLO_BASICS: {
        lesson_id: "L1_HELLO_BASICS",
        lesson_name: "Basic greetings",
        default_stage: "intro",
        default_target_phrases: [],
      },

      // Introducing yourself by name / asking others’ names.
      L2_INTRO_NAME: {
        lesson_id: "L2_INTRO_NAME",
        lesson_name: "Saying your name",
        default_stage: "guided_practice",
        default_target_phrases: [],
      },

      // Where you are from / where you live (country, city, origin).
      L3_WHERE_FROM: {
        lesson_id: "L3_WHERE_FROM",
        lesson_name: "Where you are from",
        default_stage: "guided_practice",
        default_target_phrases: [],
      },

      // Simple feelings / “how are you” patterns, very short answers.
      L4_FEELINGS_SIMPLE: {
        lesson_id: "L4_FEELINGS_SIMPLE",
        lesson_name: "How you are feeling",
        default_stage: "guided_practice",
        default_target_phrases: [],
      },

      // Simple goodbyes / closing a conversation politely.
      L5_GOODBYES: {
        lesson_id: "L5_GOODBYES",
        lesson_name: "Simple goodbyes",
        default_stage: "review",
        default_target_phrases: [],
      },
    },
  },

  // ---------------------------------------------------------------------------
  // U2 – Everyday Life & Routines (A1 → A2)
  // ---------------------------------------------------------------------------
  U2_EVERYDAY_LIFE: {
    unit_id: "U2_EVERYDAY_LIFE",
    unit_name: "Everyday Life & Routines",
    lessons: {
      // Days, dates, clock time; talking about “today / tomorrow / yesterday”.
      L1_TIME_DATE: {
        lesson_id: "L1_TIME_DATE",
        lesson_name: "Time and date basics",
        default_stage: "intro",
        default_target_phrases: [],
      },

      // “I wake up at…”, “I go to work at…”, simple daily routine sentences.
      L2_DAILY_ROUTINE: {
        lesson_id: "L2_DAILY_ROUTINE",
        lesson_name: "Simple daily routines",
        default_stage: "guided_practice",
        default_target_phrases: [],
      },

      // Talking about family members and people in your home.
      L3_HOME_FAMILY: {
        lesson_id: "L3_HOME_FAMILY",
        lesson_name: "Home and family",
        default_stage: "guided_practice",
        default_target_phrases: [],
      },

      // Weather small talk (“it’s hot / cold / raining”) + very short comments.
      L4_WEATHER_SMALL_TALK: {
        lesson_id: "L4_WEATHER_SMALL_TALK",
        lesson_name: "Weather & small talk",
        default_stage: "guided_practice",
        default_target_phrases: [],
      },

      // Quick recap of U2 with short dialogues about a typical day.
      L5_REVIEW_EVERYDAY: {
        lesson_id: "L5_REVIEW_EVERYDAY",
        lesson_name: "Everyday life review",
        default_stage: "review",
        default_target_phrases: [],
      },
    },
  },

  // ---------------------------------------------------------------------------
  // U3 – People & Places (A2)
  // ---------------------------------------------------------------------------
  U3_PEOPLE_PLACES: {
    unit_id: "U3_PEOPLE_PLACES",
    unit_name: "People & Places",
    lessons: {
      // Physical + simple personality descriptions (“tall / short / friendly…”).
      L1_DESCRIBE_PEOPLE_BASIC: {
        lesson_id: "L1_DESCRIBE_PEOPLE_BASIC",
        lesson_name: "Describing people (basic)",
        default_stage: "intro",
        default_target_phrases: [],
      },

      // Jobs, study, “I work as…”, “I am a student…”.
      L2_JOBS_STUDY: {
        lesson_id: "L2_JOBS_STUDY",
        lesson_name: "Jobs and study",
        default_stage: "guided_practice",
        default_target_phrases: [],
      },

      // Places in town: shops, bank, station, park, etc.
      L3_PLACES_IN_TOWN: {
        lesson_id: "L3_PLACES_IN_TOWN",
        lesson_name: "Places in town",
        default_stage: "guided_practice",
        default_target_phrases: [],
      },

      // Very simple “go straight / turn left / near the…” directions.
      L4_GIVING_DIRECTIONS_SIMPLE: {
        lesson_id: "L4_GIVING_DIRECTIONS_SIMPLE",
        lesson_name: "Simple directions",
        default_stage: "guided_practice",
        default_target_phrases: [],
      },

      // Review describing people + describing locations / giving directions.
      L5_REVIEW_PEOPLE_PLACES: {
        lesson_id: "L5_REVIEW_PEOPLE_PLACES",
        lesson_name: "Review: people & places",
        default_stage: "review",
        default_target_phrases: [],
      },
    },
  },

  // ---------------------------------------------------------------------------
  // U4 – Practical Tasks & Survival Situations (A2)
  // ---------------------------------------------------------------------------
  U4_PRACTICAL_TASKS: {
    unit_id: "U4_PRACTICAL_TASKS",
    unit_name: "Practical Tasks & Survival Situations",
    lessons: {
      // Buying things, asking prices, quantities, “I would like…”.
      L1_SHOPPING_BASICS: {
        lesson_id: "L1_SHOPPING_BASICS",
        lesson_name: "Shopping basics",
        default_stage: "intro",
        default_target_phrases: [],
      },

      // Ordering food/drinks, simple restaurant interactions.
      L2_EATING_OUT: {
        lesson_id: "L2_EATING_OUT",
        lesson_name: "Eating out",
        default_stage: "guided_practice",
        default_target_phrases: [],
      },

      // Transport: tickets, buses, trains, taxis, “How do I get to…?”
      L3_TRANSPORTATION: {
        lesson_id: "L3_TRANSPORTATION",
        lesson_name: "Getting around",
        default_stage: "guided_practice",
        default_target_phrases: [],
      },

      // Very simple health situations: “I feel…”, “I have a headache…”.
      L4_HEALTH_SIMPLE: {
        lesson_id: "L4_HEALTH_SIMPLE",
        lesson_name: "Simple health problems",
        default_stage: "guided_practice",
        default_target_phrases: [],
      },

      // Survival review: mixed-roleplay with shops, restaurants, travel, health.
      L5_REVIEW_PRACTICAL: {
        lesson_id: "L5_REVIEW_PRACTICAL",
        lesson_name: "Practical review",
        default_stage: "review",
        default_target_phrases: [],
      },
    },
  },
};

// ============================================================================
// Helpers
// ============================================================================
function languageDisplayName(locale: string, uiLocale: string = "und"): string {
  const code = (locale || "").toString().trim().replaceAll("_", "-").split("-")[0]?.toLowerCase();
  if (!code) return "the target language";
  try {
    // @ts-ignore
    const dn = new Intl.DisplayNames([uiLocale || "und"], { type: "language" });
    return dn.of(code) || code;
  } catch {
    return code;
  }
}


function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Internal server-to-server invoke for rebuild-insights (non-JWT).
// Requires rebuild-insights to be deployed with verify_jwt=false and to validate
// x-internal-key against INTERNAL_FUNCTION_KEY.
// ---------------------------------------------------------------------------
async function invokeRebuildInsightsInternal(payload: any): Promise<string> {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const internalKey = Deno.env.get("INTERNAL_FUNCTION_KEY") || "";
  if (!url) throw new Error("Missing SUPABASE_URL");
  if (!internalKey) throw new Error("Missing INTERNAL_FUNCTION_KEY");

  const endpoint = `${url}/functions/v1/rebuild-insights`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-key": internalKey,
    },
    body: JSON.stringify(payload ?? {}),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`rebuild-insights ${resp.status}: ${text}`);
  }
  return text;
}

function normalizeLocale(raw: unknown, fallback = "und"): string {
  if (typeof raw !== "string") return fallback;
  const val = raw.trim();
  if (!val) return fallback;
  const cleaned = val.replaceAll("_", "-").trim();
  const lower = cleaned.toLowerCase();
  if (lower === "default") return fallback;

  // Use Intl.Locale when available to canonicalize BCP-47 tags, but stay agnostic:
  // no hard-coded language mappings.
  try {
    // @ts-ignore - Intl.Locale exists in Deno runtime.
    return new Intl.Locale(cleaned).toString();
  } catch {
    return cleaned;
  }
}


// NEW: collapse "xx-XX" → "th", "xx-XX" → "es" for progress keys.
function getProgressLanguageKey(locale: string | null | undefined): string {
  if (!locale) return "default";
  const parts = String(locale).split("-");
  if (!parts[0]) return "default";
  return parts[0].toLowerCase();
}

// Strip code fences / JSON / quotes so Flutter never sees them
function sanitizeGeminiOutput(text: string): string {
  if (!text) return text;

  let result = text;

  // Remove ```...``` blocks (any language)
  result = result.replace(/```[\s\S]*?```/g, "");
  result = result.replace(/```/g, "");

  // Remove bare { } [ ] lines and simple "key": prefixes
  result = result.replace(/^\s*[{\[]\s*$/gm, "");
  result = result.replace(/^\s*[}\]],?\s*$/gm, "");
  result = result.replace(/"[^"]*"\s*:\s*\[/g, "");
  result = result.replace(/"[^"]*"\s*:\s*/g, "");

  // Strip surrounding quotes on lines and trailing commas
  result = result.replace(/^"\s*(.*)\s*",?\s*$/gm, "$1");
  result = result.replace(/,\s*$/gm, "");

  // Remove empty lines
  result = result
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join("\n");

  return result.trim();
}

function extractPronunciationScoreFromReply(
  reply: string,
): { score: number | null; line: string | null } {
  if (!reply) return { score: null, line: null };

  const lines = reply.split(/\r?\n/);
  let candidate: string | null = null;

  // Prefer a line that mentions both "pronunciation" and "score"
  for (const line of lines) {
    if (/pronunciation/i.test(line) && /score/i.test(line)) {
      candidate = line.trim();
      break;
    }
  }

  // Fallback: any line mentioning "score"
  if (!candidate) {
    for (const line of lines) {
      if (/score/i.test(line)) {
        candidate = line.trim();
        break;
      }
    }
  }

  if (!candidate) return { score: null, line: null };

  const regexes = [
    /Pronunciation score[^0-9]*(\d{1,3})\s*\/\s*100/i,
    /score[^0-9]*(\d{1,3})\s*\/\s*100/i,
    /(\d{1,3})\s*\/\s*100/i,
    /score[^0-9]*(\d{1,3})\s*(?:out of|\/)\s*100/i,
  ];

  for (const re of regexes) {
    const match = candidate.match(re);
    if (match) {
      const raw = parseInt(match[1], 10);
      if (!Number.isNaN(raw)) {
        const clamped = Math.max(0, Math.min(100, raw));
        return { score: clamped, line: candidate };
      }
    }
  }

  // We saw a "score" line but couldn't parse a number cleanly
  return { score: null, line: candidate };
}

function isProgressQuery(raw: unknown): boolean {
  if (!raw || typeof raw !== "string") return false;
  const text = raw.trim().toLowerCase();
  if (!text) return false;

  // Explicit slash command
  if (text.startsWith("/progress")) return true;

  const normalized = text.replace(/[?.!]/g, "");

  // A few natural-language variants
  if (normalized.includes("show my progress")) return true;
  if (normalized.includes("what is my progress")) return true;
  if (normalized.includes("where am i in this course")) return true;
  if (normalized.includes("where am i in this lesson")) return true;
  if (normalized.includes("which lesson am i on")) return true;
  if (normalized.includes("what unit am i on")) return true;
  if (normalized === "progress") return true;

  return false;
}

/**
 * Build a human-readable progress summary for the current language-learning
 * state, using ONLY [L1] lines (since this is meta-info in the learner's
 * main language).
 */
function buildLanguageProgressSummary(
  preferredLocale: string,
  targetLocale: string,
  learningLevel: LearningLevel,
  state: LanguageLessonState,
): string {
  const fallbackUnit = LANGUAGE_UNITS["U1_GREETINGS"];
  const unit =
    LANGUAGE_UNITS[state.unit_id] ?? fallbackUnit;

  const fallbackLesson = fallbackUnit.lessons["L1_HELLO_BASICS"];
  const lesson =
    unit.lessons[state.lesson_id] ?? fallbackLesson;

  const stageLabels: Record<string, string> = {
    intro: "introduction",
    guided_practice: "guided practice",
    free_practice: "free practice",
    review: "review",
  };

  const stageLabel =
    stageLabels[state.stage] ?? state.stage ?? "unknown";

  const levelLabel = (() => {
    switch (learningLevel) {
      case "beginner":
        return "beginner";
      case "intermediate":
        return "intermediate";
      case "advanced":
        return "advanced";
      default:
        return String(learningLevel || "unspecified");
    }
  })();

  const masteredText = state.has_mastered_main_phrase ? "yes" : "not yet";

  const lines: string[] = [
    "[L1] Here is your current progress in this language course.",
    `[L1] Your main language (L1) is set to ${preferredLocale}, and your target language (L2) is ${targetLocale}.`,
    `[L1] You are currently in unit ${unit.unit_id} – "${unit.unit_name}".`,
    `[L1] Current lesson: "${lesson.lesson_name}" (${lesson.lesson_id}).`,
    `[L1] Current stage in this lesson: ${stageLabel}.`,
    `[L1] Overall learning level: ${levelLabel}.`,
    `[L1] Times you have practiced the main phrase in this lesson: ${state.times_seen_main_phrase}.`,
    `[L1] Mastery of the main phrase in this lesson: ${masteredText}.`,
    "[L1] You can say something like \"move ahead\" if this feels too easy, or keep practicing here for more depth.",
  ];

  return lines.join("\n");
}

function isMoveAheadQuery(raw: unknown): boolean {
  if (!raw || typeof raw !== "string") return false;
  const text = raw.trim().toLowerCase();
  if (!text) return false;

  // Explicit slash command
  if (text.startsWith("/advance")) return true;
  if (text.startsWith("/skip")) return true;

  const normalized = text.replace(/[?.!]/g, "");

  // Natural-language variants
  if (normalized.includes("move me ahead")) return true;
  if (normalized.includes("move ahead")) return true;
  if (normalized.includes("skip ahead")) return true;
  if (normalized.includes("skip this")) return true;
  if (normalized.includes("this is too easy")) return true;
  if (normalized.includes("go faster")) return true;
  if (normalized.includes("harder content")) return true;

  return false;
}

function isGoBackQuery(raw: unknown): boolean {
  if (!raw || typeof raw !== "string") return false;
  const text = raw.trim().toLowerCase();
  if (!text) return false;

  // Explicit slash command for a button to send
  if (text.startsWith("/back")) return true;
  if (text.startsWith("/easier")) return true;

  const normalized = text.replace(/[?.!]/g, "");

  // Natural-language variants
  if (normalized.includes("go back")) return true;
  if (normalized.includes("too hard")) return true;
  if (normalized.includes("this is hard")) return true;
  if (normalized.includes("slow down")) return true;
  if (normalized.includes("easier")) return true;

  return false;
}

/**
 * Fast-forward the lesson state by marking the current lesson as "mastered"
 * and then calling advanceLanguageLessonState() once. This nudges the
 * curriculum forward without jumping wildly.
 */
function fastForwardLanguageState(
  state: LanguageLessonState,
): LanguageLessonState {
  const forced: LanguageLessonState = {
    ...state,
    times_seen_main_phrase: Math.max(
      state.times_seen_main_phrase ?? 0,
      3,
    ),
    has_mastered_main_phrase: true,
  };

  return advanceLanguageLessonState(forced);
}

/**
 * Build a friendly [L1]-only response telling the learner we've moved
 * them forward and where they are now in the curriculum.
 */
function buildMoveAheadReply(
  preferredLocale: string,
  targetLocale: string,
  learningLevel: LearningLevel,
  newState: LanguageLessonState,
): string {
  const fallbackUnit = LANGUAGE_UNITS["U1_GREETINGS"];
  const unit =
    LANGUAGE_UNITS[newState.unit_id] ?? fallbackUnit;

  const fallbackLesson = fallbackUnit.lessons["L1_HELLO_BASICS"];
  const lesson =
    unit.lessons[newState.lesson_id] ?? fallbackLesson;

  const stageLabels: Record<string, string> = {
    intro: "introduction",
    guided_practice: "guided practice",
    free_practice: "free practice",
    review: "review",
  };

  const stageLabel =
    stageLabels[newState.stage] ?? newState.stage ?? "unknown";

  const levelLabel = (() => {
    switch (learningLevel) {
      case "beginner":
        return "beginner";
      case "intermediate":
        return "intermediate";
      case "advanced":
        return "advanced";
      default:
        return String(learningLevel || "unspecified");
    }
  })();

  return [
    "[L1] Got it — I’ll move you ahead to slightly more challenging material.",
    `[L1] Your main language (L1) is ${preferredLocale}, and your target language (L2) is ${targetLocale}.`,
    `[L1] You are now in unit ${unit.unit_id} – "${unit.unit_name}".`,
    `[L1] Current lesson: "${lesson.lesson_name}" (${lesson.lesson_id}).`,
    `[L1] Current stage in this lesson: ${stageLabel}.`,
    `[L1] Overall learning level: ${levelLabel}.`,
    "[L1] I will start using this new spot as your baseline. Try answering in the target language, and I’ll keep adjusting difficulty based on your replies.",
  ].join("\n");
}

function buildGoBackReply(
  preferredLocale: string,
  targetLocale: string,
  learningLevel: LearningLevel,
  newState: LanguageLessonState,
): string {
  const fallbackUnit = LANGUAGE_UNITS["U1_GREETINGS"];
  const unit =
    LANGUAGE_UNITS[newState.unit_id] ?? fallbackUnit;

  const fallbackLesson = fallbackUnit.lessons["L1_HELLO_BASICS"];
  const lesson =
    unit.lessons[newState.lesson_id] ?? fallbackLesson;

  const stageLabels: Record<string, string> = {
    intro: "introduction",
    guided_practice: "guided practice",
    free_practice: "free practice",
    review: "review",
  };

  const stageLabel =
    stageLabels[newState.stage] ?? newState.stage ?? "unknown";

  const levelLabel = (() => {
    switch (learningLevel) {
      case "beginner":
        return "beginner";
      case "intermediate":
        return "intermediate";
      case "advanced":
        return "advanced";
      default:
        return String(learningLevel || "unspecified");
    }
  })();

  return [
    "[L1] Got it — I’ll step back to slightly easier practice for this topic.",
    `[L1] Your main language (L1) is ${preferredLocale}, and your target language (L2) is ${targetLocale}.`,
    `[L1] You are now in unit ${unit.unit_id} – "${unit.unit_name}".`,
    `[L1] Current lesson: "${lesson.lesson_name}" (${lesson.lesson_id}).`,
    `[L1] Current stage in this lesson: ${stageLabel}.`,
    `[L1] Overall learning level: ${levelLabel}.`,
    "[L1] I’ll stay around this level until you feel ready to move ahead again. You can say \"move ahead\" or use the advance button when you’re comfortable.",
  ].join("\n");
}

// Ensure [L1] lines don't contain target language script or obvious target language romanization
// when L2 is target language. This keeps target language content on [L2] only, and avoids ugly
// pronunciation attempts by the L1 TTS voice.
function enforceLanguageOnTaggedLines(
  text: string,
  _preferredLocale: string,
  _targetLocale: string | null,
): string {
  // Language-agnostic no-op.
  // We avoid script-specific heuristics here; the model should follow the system prompt
  // and the app should render whatever script is returned.
  return text ?? "";
}

// Strip romanization/phonetics from [L1] lines so the L1 TTS voice does not butcher it.
// We do NOT touch [ROM] lines; pronunciation should live there (only if learner asked).

// ---------------------------------------------------------------------------
// Language-learning artifact extraction (bubble vs Learning screen blocks)
// ---------------------------------------------------------------------------
type LearningBlock = {
  tag: string;
  title?: string | null;
  content: string;
  raw_text: string;
};

const LEARNING_TAGS = new Set(["LESSON","VOCAB","DRILL","QUIZ","NOTES","ROM","META"]);
const BUBBLE_TAGS = new Set(["L1","L2"]);

// Parses tagged output into sections. Handles both formats:
// 1) Tag + content on same line: "[L2] สวัสดีครับ"
// 2) Tag on its own line, followed by content lines.
function parseTaggedSections(text: string): Array<{ tag: string; lines: string[] }> {
  const lines = String(text ?? "").split(/\r?\n/);
  const sections: Array<{ tag: string; lines: string[] }> = [];
  let currentTag: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentTag) return;
    // Drop empty-only sections (prevents bare tag spam)
    const nonEmpty = currentLines.map(l => l.trim()).filter(Boolean);
    if (nonEmpty.length === 0) {
      currentTag = null;
      currentLines = [];
      return;
    }
    sections.push({ tag: currentTag, lines: currentLines.slice() });
    currentTag = null;
    currentLines = [];
  };

  const tagLineRe = /^\s*\[([A-Z0-9_]+)\]\s*(.*)\s*$/i;

  for (const raw of lines) {
    const line = String(raw ?? "");
    const m = tagLineRe.exec(line);
    if (m) {
      const tag = String(m[1] ?? "").toUpperCase();
      const rest = String(m[2] ?? "");
      if (BUBBLE_TAGS.has(tag) || LEARNING_TAGS.has(tag)) {
        flush();
        currentTag = tag;
        if (rest.trim()) {
          currentLines.push(rest);
        }
        continue;
      }
    }
    // If we haven't seen a tag yet, ignore untagged lines (safer)
    if (!currentTag) continue;
    currentLines.push(line);
  }

  flush();
  return sections;
}

// Convert sections into (a) bubble lines and (b) learning blocks.
function extractLearningArtifacts(text: string): {
  bubbleText: string;
  blocks: LearningBlock[];
} {
  const sections = parseTaggedSections(text);

  const bubbleLines: string[] = [];
  const blocks: LearningBlock[] = [];

  for (const s of sections) {
    const tag = s.tag;
    const joined = s.lines.join("\n").trim();
    if (!joined) continue;

    if (tag === "L1" || tag === "L2") {
      // Keep tags for TTS routing; UI can strip tags for display
      // One line per section for bubble readability
      const flat = joined.replace(/\s+/g, " ").trim();
      bubbleLines.push(`[${tag}] ${flat}`);
    } else if (LEARNING_TAGS.has(tag)) {
      blocks.push({
        tag,
        title: null,
        content: joined.trim(),
        raw_text: `[${tag}]\n${joined}`.trim(),
      });
    }
  }

  // Final safety: remove bare tags if any slipped in
  const cleanedBubble = bubbleLines
    .map(stripPronunciationGuides)
    .map(l => l.trim())
    .filter(l => l && !/^\[(?:L1|L2)\]\s*$/i.test(l))
    .join("\n")
    .trim();

  return { bubbleText: cleanedBubble, blocks };
}

// Create a minimal fallback learning block if the model forgot to include any.
function buildFallbackLearningBlockFromBubble(bubbleText: string): LearningBlock | null {
  const l2Lines = String(bubbleText ?? "")
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /^\[L2\]\s+/i.test(l))
    .map(l => l.replace(/^\[L2\]\s+/i, "").trim())
    .filter(Boolean);

  if (l2Lines.length === 0) return null;

  const uniq = Array.from(new Set(l2Lines)).slice(0, 5);
  const content = uniq.map((x, i) => `${i + 1}) ${x}`).join("\n");

  return {
    tag: "VOCAB",
    title: "Auto-captured phrases",
    content,
    raw_text: `[VOCAB]\n${content}`,
  };
}

// Persist learning artifacts to dedicated tables (donor-wide history).
async function persistLearningArtifacts(
  client: SupabaseClient,
  args: {
    user_id: string;
    conversation_id: string;
    preferred_locale: string;
    target_locale: string | null;
    learning_level: string | null;
    blocks: LearningBlock[];
  },
): Promise<void> {
  const { user_id, conversation_id, preferred_locale, target_locale, learning_level, blocks } = args;
  if (!blocks || blocks.length === 0) {
    console.log("LEARNING_PERSIST_SKIP", {
      conversation_id,
      user_id,
      reason: "no_blocks",
    });
    return;
  }

  console.log("LEARNING_PERSIST_BEGIN", {
    conversation_id,
    user_id,
    blocksLen: blocks.length,
  });

  try {

  // 1) Create a learning session
  const { data: sess, error: sessErr } = await client
    .from("learning_sessions")
    .insert({
      user_id,
      conversation_id,
      preferred_locale,
      target_locale,
      learning_level,
    })
    .select("id")
    .single();

  if (sessErr || !sess?.id) {
    console.error("❌ learning_sessions insert failed:", sessErr);
    return;
  }

  console.log("LEARNING_SESS_INSERT_OK", { session_id: sess.id });

  const session_id = sess.id as string;

  // 2) Insert blocks
  const rows = blocks
    .map((b) => {
      const tag = String(b.tag ?? "").toUpperCase();
      const content = String(b.content ?? "").trim();
      if (!content) return null;
      return {
        user_id,
        session_id,
        tag,
        title: b.title ?? null,
        content,
        raw_json: { tag, title: b.title ?? null, content, raw_text: b.raw_text ?? "" },
      };
    })
    .filter(Boolean);

  if (rows.length === 0) return;

  const { error: blkErr } = await client.from("learning_blocks").insert(rows as any[]);
  if (blkErr) {
    console.error("❌ learning_blocks insert failed:", blkErr);
    return;
  }

  console.log("LEARNING_BLOCKS_INSERT_OK", { session_id, count: rows.length });
  } catch (e) {
    console.error("LEARNING_PERSIST_EXCEPTION", e);
  }
}

function stripPronunciationGuides(s: string): string {
  // Remove parentheses that contain Latin letters: (phûu yǐng), (dtông gaan - want need)
  s = s.replace(/\([^)]*[A-Za-z][^)]*\)/g, "").trim();

  // Remove IPA-like slashes if you ever emit them: /foo/
  s = s.replace(/\/[^\/]{1,80}\//g, "").trim();

  // Collapse leftover double spaces
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

function stripRomanizationFromL1Lines(text: string): string {
  if (!text) return text;

  const tokenRe =
    /\b(khrap|krap|krub|ka|kha|mai|nai|bpai|pai|phom|pom|chan|khun|sawatdee|sawasdee|sawatdi|sà-wàt-dii|sa-wat-dee)\b/i;

  // Parenthetical chunks that look like romanization (ASCII-only, short).
  const parenChunkRe =
    /\(([^)]{1,80})\)/g;

  const lines = String(text).split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    if (!line.startsWith("[L1]")) {
      out.push(line);
      continue;
    }

    let s = line;

    // Remove any parenthetical chunk that contains common romanization tokens OR is mostly ASCII letters/spaces/hyphens/apostrophes.
    s = s.replace(parenChunkRe, (full, inner) => {
      const innerStr = String(inner).trim();
      if (!innerStr) return "";

      // If it contains a known romanization token, drop it.
      if (tokenRe.test(innerStr)) return "";

      // If it's ASCII-ish and short, and contains at least one vowel, treat as romanization.
      const asciiOnly = /^[A-Za-z\u00C0-\u017F\s'\-\.?]+$/.test(innerStr);
      const hasVowel = /[aeiouyAEIOUY]/.test(innerStr);
      if (asciiOnly && hasVowel && innerStr.length <= 60) return "";

      return full; // keep other parentheses (e.g., legitimate English aside)
    });

    // Clean up extra whitespace after removals.
    s = s.replace(/\s{2,}/g, " ").trimEnd();

    out.push(s);
  }

  return out.join("\n");
}


// ------- Legacy state utilities --------------------------------------------
function parseLegacyState(stateJson?: string | null): LegacyInterviewState | null {
  if (!stateJson) return null;
  try {
    const obj = JSON.parse(stateJson);
    if (!obj || typeof obj !== "object") return null;
    const state = obj as LegacyInterviewState;
    if (!state.chapter_id) return null;
    return {
      chapter_id: state.chapter_id,
      chapter_title: state.chapter_title ?? "",
      progress_percent:
        typeof state.progress_percent === "number"
          ? state.progress_percent
          : 0,
      focus_topic: state.focus_topic ?? null,
    };
  } catch {
    return null;
  }
}

function getDefaultLegacyState(): LegacyInterviewState {
  // Start in childhood by default; if you prefer another starting chapter
  // (e.g. "adolescence"), change the key here.
  const chapter = LEGACY_CHAPTERS["childhood"];
  return {
    chapter_id: chapter.chapter_id,
    chapter_title: chapter.chapter_title,
    progress_percent: 0,
    focus_topic: chapter.default_focus_topic,
  };
}

// ------- Language state utilities ------------------------------------------

export function chooseConceptKeysForLesson(
  unitId: string,
  lessonId: string,
): string[] {
  // -----------------------------
  // UNIT 1 — GREETINGS
  // -----------------------------
  if (unitId === "U1_GREETINGS") {
    switch (lessonId) {
      case "L1_HELLO_BASICS":
        // Core greetings the learner should master early.
        return [
          "GREET_HELLO_BASIC",
          "GREET_THANK_YOU",
          "GREET_PLEASE",
          "GREET_SORRY",
        ];
      case "L2_INTRO_NAME":
        return [
          "INTRO_MY_NAME",
          "INTRO_WHATS_YOUR_NAME",
        ];
      case "L3_WHERE_FROM":
        return [
          "ORIGIN_WHERE_FROM",
          "ORIGIN_I_AM_FROM",
        ];
      case "L4_FEELINGS_SIMPLE":
        return [
          "FEEL_GOOD",
          "FEEL_NOT_GOOD",
        ];
      case "L5_GOODBYES":
        return [
          "GREET_GOODBYE_BASIC",
        ];
      default:
        return [];
    }
  }

  // -----------------------------
  // UNIT 2 — EVERYDAY LIFE
  // -----------------------------
  if (unitId === "U2_EVERYDAY_LIFE") {
    switch (lessonId) {
      case "L1_TIME_AND_DATE":
        return [
          "TIME_TODAY",
          "TIME_TOMORROW",
          "TIME_YESTERDAY",
          "TIME_NOW",
        ];
      case "L2_DAILY_ROUTINE":
        return [
          "VERB_GO",
          "VERB_COME",
          "VERB_EAT",
          "VERB_DRINK",
          "RUN_PHYSICAL_MOVE",
        ];
      case "L3_HOME_AND_FAMILY":
        return [
          "PLACE_HOME",
          "FAMILY_FAMILY",
          "FAMILY_MOTHER",
          "FAMILY_FATHER",
          "FAMILY_FRIEND",
        ];
      case "L4_WEATHER_BASIC":
        return [
          "WEATHER_HOT",
          // room for more later (cold, rain, etc.)
        ];
      case "L5_REVIEW":
        // Simple cross-review of the most common everyday items.
        return [
          "GREET_HELLO_BASIC",
          "TIME_TODAY",
          "PLACE_HOME",
          "VERB_GO",
          "VERB_EAT",
        ];
      default:
        return [];
    }
  }

  // -----------------------------
  // UNIT 3 — PEOPLE & PLACES
  // -----------------------------
  if (unitId === "U3_PEOPLE_PLACES") {
    switch (lessonId) {
      case "L1_PEOPLE_DESCRIPTIONS":
        return [
          "FAMILY_FRIEND",
          "FAMILY_MOTHER",
          "FAMILY_FATHER",
        ];
      case "L2_JOBS_PROFESSIONS":
        return [
          "PLACE_WORK",
          // "VERB_WORK", // optional future concept; add when concept exists
        ];
      case "L3_PLACES_AROUND_TOWN":
        return [
          "PLACE_MARKET",
          "PLACE_HOME",
          "PLACE_SCHOOL",
        ];
      case "L4_DIRECTIONS_BASIC":
        return [
          "DIRECTION_TURN_LEFT",
          // later: DIRECTION_TURN_RIGHT, DIRECTION_GO_STRAIGHT, etc.
        ];
      case "L5_REVIEW":
        return [
          "PLACE_HOME",
          "PLACE_MARKET",
          "PLACE_SCHOOL",
          "DIRECTION_TURN_LEFT",
        ];
      default:
        return [];
    }
  }

  // Default: no specific mapping yet.
  return [];
}

// Backwards-compat: keep the old single-key helper in case it’s used elsewhere.
function chooseConceptKeyForLesson(
  unitId: string,
  lessonId: string,
): string | null {
  const keys = chooseConceptKeysForLesson(unitId, lessonId);
  return keys.length > 0 ? keys[0] : null;
}

function parseLanguageLessonState(
  stateJson?: string | null,
): LanguageLessonState | null {
  if (!stateJson) return null;

  try {
    const obj = JSON.parse(stateJson);
    if (!obj || typeof obj !== "object") return null;

    const state = obj as any;

    if (!state.unit_id || !state.lesson_id) return null;

    const phrases = Array.isArray(state.target_phrases)
      ? state.target_phrases
          .filter((p: any) => p && typeof p.l2_script === "string")
      : [];

    const timesSeen =
      typeof state.times_seen_main_phrase === "number" &&
      Number.isFinite(state.times_seen_main_phrase)
        ? state.times_seen_main_phrase
        : 0;

    const hasMastered = state.has_mastered_main_phrase === true;

    return {
      unit_id: state.unit_id as string,
      lesson_id: state.lesson_id as string,
      stage: (state.stage as string) || "intro",
      target_phrases: phrases,
      times_seen_main_phrase: timesSeen,
      has_mastered_main_phrase: hasMastered,
    };
  } catch {
    return null;
  }
}

// NEW: wrapper that supports either:
//  - old single-language state_json, or
//  - new multi-language container with .languages
function parseMultiLanguageLessonState(
  stateJson: string | null | undefined,
  langKey: string,
): { container: MultiLanguageLessonContainer; active: LanguageLessonState } {
  // Default state + container
  const defaultState = getDefaultLanguageLessonState();
  let container: MultiLanguageLessonContainer = {
    version: 1,
    current_language: langKey,
    languages: {},
  };

  if (!stateJson) {
    container.languages[langKey] = defaultState;
    return { container, active: defaultState };
  }

  try {
    const raw = JSON.parse(stateJson);

    // Case 1: Already a multi-language container
    if (raw && typeof raw === "object" && "languages" in raw) {
      const existing = raw as any;
      const languages = (existing.languages ?? {}) as Record<string, any>;

      // Try to parse the specific language entry if it exists.
      const rawStateForLang = languages[langKey];
      let active: LanguageLessonState;

      if (rawStateForLang) {
        const parsed = parseLanguageLessonState(
          JSON.stringify(rawStateForLang),
        );
        active = parsed ?? defaultState;
      } else {
        active = defaultState;
      }

      const normalizedLanguages: Record<string, LanguageLessonState> = {};
      for (const [key, value] of Object.entries(languages)) {
        const parsed = parseLanguageLessonState(JSON.stringify(value));
        if (parsed) {
          normalizedLanguages[key] = parsed;
        }
      }

      // Ensure current language is present.
      normalizedLanguages[langKey] = active;

      container = {
        version: typeof existing.version === "number" ? existing.version : 1,
        current_language: langKey,
        languages: normalizedLanguages,
      };

      return { container, active };
    }

    // Case 2: Old-style single-language state
    const single = parseLanguageLessonState(stateJson);
    if (single) {
      container.languages[langKey] = single;
      return { container, active: single };
    }
  } catch {
    // fall through to default
  }

  // Fallback: nothing parseable, return default
  container.languages[langKey] = defaultState;
  return { container, active: defaultState };
}

// ---------------------------------------------------------------------------
// Backwards-compat helper: chooseUnitAndLesson
// ---------------------------------------------------------------------------
//
// Some older code paths still call chooseUnitAndLesson(...) to decide which
// unit/lesson the tutor should use. In the new architecture we mostly rely
// on LANGUAGE_UNITS + getDefaultLanguageLessonState + advanceLanguageLessonState,
// but we keep this helper so those callers won’t throw at runtime.
//
// Behavior:
// - If a valid LanguageLessonState is present, just echo its unit/lesson.
// - Otherwise, fall back to U1_GREETINGS / L1_HELLO_BASICS.
//
function chooseUnitAndLesson(
  state: LanguageLessonState | null | undefined,
  _level?: LearningLevel,
): { unitId: string; lessonId: string } {
  // If we already have a state with unit/lesson, honor that.
  if (state && state.unit_id && state.lesson_id) {
    return {
      unitId: state.unit_id,
      lessonId: state.lesson_id,
    };
  }

  // Fallback: first greetings lesson.
  return {
    unitId: "U1_GREETINGS",
    lessonId: "L1_HELLO_BASICS",
  };
}

function getDefaultLanguageLessonState(): LanguageLessonState {
  const unit = LANGUAGE_UNITS["U1_GREETINGS"];
  const lesson = unit.lessons["L1_HELLO_BASICS"];

  return {
    unit_id: unit.unit_id,
    lesson_id: lesson.lesson_id,
    stage: lesson.default_stage,
    target_phrases: lesson.default_target_phrases,
    times_seen_main_phrase: 0,
    has_mastered_main_phrase: false,
  };
}

// Advance the lesson stage so we don't stay stuck on "intro" forever.
// Very simple progression for now:
//   intro -> guided_practice -> free_practice -> review -> review (stay)
function advanceLanguageLessonState(
  state: LanguageLessonState,
): LanguageLessonState {
  const stageOrder = ["intro", "guided_practice", "free_practice", "review"] as const;

  // Ordered curriculum path across all units/lessons.
  // This MUST stay in sync with LANGUAGE_UNITS.
  const curriculumPath: Array<{ unitId: string; lessonId: string }> = [
    // U1 – Greetings & Small Talk
    { unitId: "U1_GREETINGS", unitId: "U1_GREETINGS", lessonId: "L1_HELLO_BASICS" },
    { unitId: "U1_GREETINGS", lessonId: "L2_INTRO_NAME" },
    { unitId: "U1_GREETINGS", lessonId: "L3_WHERE_FROM" },
    { unitId: "U1_GREETINGS", lessonId: "L4_FEELINGS_SIMPLE" },
    { unitId: "U1_GREETINGS", lessonId: "L5_GOODBYES" },

    // U2 – Everyday Life
    { unitId: "U2_EVERYDAY_LIFE", lessonId: "L1_TIME_DATE" },
    { unitId: "U2_EVERYDAY_LIFE", lessonId: "L2_DAILY_ROUTINE" },
    { unitId: "U2_EVERYDAY_LIFE", lessonId: "L3_HOME_FAMILY" },
    { unitId: "U2_EVERYDAY_LIFE", lessonId: "L4_WEATHER_SMALL_TALK" },
    { unitId: "U2_EVERYDAY_LIFE", lessonId: "L5_REVIEW_EVERYDAY" },

    // U3 – People & Places
    { unitId: "U3_PEOPLE_PLACES", lessonId: "L1_DESCRIBE_PEOPLE_BASIC" },
    { unitId: "U3_PEOPLE_PLACES", lessonId: "L2_JOBS_STUDY" },
    { unitId: "U3_PEOPLE_PLACES", lessonId: "L3_PLACES_IN_TOWN" },
    { unitId: "U3_PEOPLE_PLACES", lessonId: "L4_GIVING_DIRECTIONS_SIMPLE" },
    { unitId: "U3_PEOPLE_PLACES", lessonId: "L5_REVIEW_PEOPLE_PLACES" },

    // U4 – Practical Tasks
    { unitId: "U4_PRACTICAL_TASKS", lessonId: "L1_SHOPPING_BASICS" },
    { unitId: "U4_PRACTICAL_TASKS", lessonId: "L2_EATING_OUT" },
    { unitId: "U4_PRACTICAL_TASKS", lessonId: "L3_TRANSPORTATION" },
    { unitId: "U4_PRACTICAL_TASKS", lessonId: "L4_HEALTH_SIMPLE" },
    { unitId: "U4_PRACTICAL_TASKS", lessonId: "L5_REVIEW_PRACTICAL" },
  ];

  const findPathIndex = (unitId: string, lessonId: string): number =>
    curriculumPath.findIndex(
      (p) => p.unitId === unitId && p.lessonId === lessonId,
    );

  const idx = stageOrder.indexOf(state.stage as any);

  // Default: advance stage within the current lesson.
  let nextStage = state.stage;
  if (idx === -1) {
    nextStage = "guided_practice";
  } else if (idx < stageOrder.length - 1) {
    nextStage = stageOrder[idx + 1];
  } else {
    nextStage = "review";
  }

  // Increment "times seen" up to a cap.
  const currentTimes = Number.isFinite(state.times_seen_main_phrase)
    ? state.times_seen_main_phrase
    : 0;
  const nextTimes = Math.min(currentTimes + 1, 10);

  // Compute mastery flag.
  let nextMastered = state.has_mastered_main_phrase;
  if (!nextMastered) {
    if (nextTimes >= 3 || nextStage === "free_practice" || nextStage === "review") {
      nextMastered = true;
    }
  }

  let nextUnitId = state.unit_id;
  let nextLessonId = state.lesson_id;
  let lessonChanged = false;

  // If we've reached review and are considered "mastered", consider moving on.
  if (nextMastered && nextStage === "review") {
    const pathIndex = findPathIndex(state.unit_id, state.lesson_id);

    if (pathIndex >= 0 && pathIndex < curriculumPath.length - 1) {
      const next = curriculumPath[pathIndex + 1];
      nextUnitId = next.unitId;
      nextLessonId = next.lessonId;
      nextStage = "intro";
      lessonChanged = true;
    }
    // If we're at the end of the path, just stay in the final review lesson.
  }

  let nextTargetPhrases = state.target_phrases;

  if (lessonChanged) {
    const unit =
      LANGUAGE_UNITS[nextUnitId] ?? LANGUAGE_UNITS["U1_GREETINGS"];
    const lesson =
      unit.lessons[nextLessonId] ??
      unit.lessons["L1_HELLO_BASICS"];

    nextTargetPhrases = lesson.default_target_phrases;

    // When we change lessons, reset counters.
    return {
      unit_id: unit.unit_id,
      lesson_id: lesson.lesson_id,
      stage: lesson.default_stage ?? nextStage,
      target_phrases: nextTargetPhrases,
      times_seen_main_phrase: 0,
      has_mastered_main_phrase: false,
    };
  }

  // Otherwise, stay in the same lesson and just advance stage / counters.
  return {
    ...state,
    stage: nextStage,
    times_seen_main_phrase: nextTimes,
    has_mastered_main_phrase: nextMastered,
  };
}

// Step the lesson state backwards to slightly easier practice.
// Very simple regression:
//   review -> free_practice -> guided_practice -> intro
//   intro stays intro (we do not jump to earlier units here).
function regressLanguageLessonState(
  state: LanguageLessonState,
): LanguageLessonState {
  const stageOrder = ["intro", "guided_practice", "free_practice", "review"] as const;
  const idx = stageOrder.indexOf(state.stage as any);

  let prevStage = state.stage;
  if (idx === -1 || idx === 0) {
    prevStage = "intro";
  } else {
    prevStage = stageOrder[idx - 1];
  }

  // Nudge "times seen" down a bit so mastery relaxes.
  const downgradedTimes = Math.max(
    (state.times_seen_main_phrase ?? 0) - 1,
    0,
  );

  const downgradedMastered =
    downgradedTimes >= 3 && prevStage !== "intro"
      ? state.has_mastered_main_phrase
      : false;

  return {
    ...state,
    stage: prevStage,
    times_seen_main_phrase: downgradedTimes,
    has_mastered_main_phrase: downgradedMastered,
  };
}

// ============================================================================
// Persistent language progress (Supabase)
// ============================================================================

interface LanguageProgressRow {
  user_id: string;
  target_language: string;
  unit_id: string;
  lesson_id: string;
  stage: string;
  learning_level: string;
  times_seen_main_phrase: number | null;
  has_mastered_main_phrase: boolean | null;
}

/**
 * Convert a progress row from Supabase into a LanguageLessonState,
 * using LANGUAGE_UNITS to supply default target_phrases and stages.
 */
function languageLessonStateFromProgressRow(
  row: LanguageProgressRow,
): LanguageLessonState {
  const unitId = row.unit_id || "U1_GREETINGS";
  const lessonId = row.lesson_id || "L1_HELLO_BASICS";

  const fallbackUnit = LANGUAGE_UNITS["U1_GREETINGS"];
  const unit = LANGUAGE_UNITS[unitId] ?? fallbackUnit;

  const fallbackLesson = fallbackUnit.lessons["L1_HELLO_BASICS"];
  const lesson = unit.lessons[lessonId] ?? fallbackLesson;

  const stage = (row.stage as LanguageLessonState["stage"]) ||
    lesson.default_stage ||
    "intro";

  const times = Number.isFinite(row.times_seen_main_phrase)
    ? (row.times_seen_main_phrase as number)
    : 0;

  const mastered = row.has_mastered_main_phrase === true;

  return {
    unit_id: unit.unit_id,
    lesson_id: lesson.lesson_id,
    stage,
    target_phrases: lesson.default_target_phrases,
    times_seen_main_phrase: times,
    has_mastered_main_phrase: mastered,
  };
}

/**
 * Load persistent progress for (user_id, target_language) from Supabase.
 * Returns null if no progress exists or on error.
 */
async function loadLanguageProgress(
  userId: string,
  targetLocale: string,
): Promise<LanguageLessonState | null> {
  if (!supabase) return null;

  const targetLanguage = normalizeLocale(targetLocale, "und");

  try {
    const { data, error } = await supabase
      .from("language_progress")
      .select(
        "user_id, target_language, unit_id, lesson_id, stage, learning_level, times_seen_main_phrase, has_mastered_main_phrase",
      )
      .eq("user_id", userId)
      .eq("target_language", targetLanguage)
      .maybeSingle<LanguageProgressRow>();

    if (error) {
      // Log but don't break the request
      console.error("loadLanguageProgress error:", error);
      return null;
    }

    if (!data) return null;

    return languageLessonStateFromProgressRow(data);
  } catch (err) {
    console.error("loadLanguageProgress exception:", err);
    return null;
  }
}

/**
 * Persist progress for (user_id, target_language) back to Supabase.
 * This is best-effort; failures are logged but don't fail the request.
 */
async function saveLanguageProgress(
  userId: string,
  targetLocale: string,
  state: LanguageLessonState,
  learningLevel: LearningLevel,
): Promise<void> {
  if (!supabase) return;

  const targetLanguage = normalizeLocale(targetLocale, "und");

  try {
    const payload = {
      user_id: userId,
      target_language: targetLanguage,
      unit_id: state.unit_id,
      lesson_id: state.lesson_id,
      stage: state.stage,
      learning_level: learningLevel,
      times_seen_main_phrase: state.times_seen_main_phrase,
      has_mastered_main_phrase: state.has_mastered_main_phrase,
      last_active_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("language_progress")
      .upsert(payload, {
        onConflict: "user_id,target_language",
      });

    if (error) {
      console.error("saveLanguageProgress error:", error);
    }
  } catch (err) {
    console.error("saveLanguageProgress exception:", err);
  }
}

async function logPronunciationAttempt(
  userId: string,
  targetLocale: string,
  state: LanguageLessonState,
  learnerTranscript: string,
  score: number | null,
  scoreLine: string | null,
): Promise<void> {
  if (!supabase) return;

  const targetLanguage = normalizeLocale(targetLocale, "und");

  if (!state.target_phrases || state.target_phrases.length === 0) {
    return;
  }

  const main = state.target_phrases[0];

  try {
    const payload = {
      user_id: userId,
      target_language: targetLanguage,
      unit_id: state.unit_id,
      lesson_id: state.lesson_id,
      concept_key: main.concept_key ?? null,
      target_phrase: main.l2_script,
      learner_transcript: learnerTranscript,
      score,
      raw_model_score_line: scoreLine,
    };

    const { error } = await supabase
      .from("pronunciation_attempts")
      .insert(payload);

    if (error) {
      console.error("logPronunciationAttempt error:", error);
    }
  } catch (err) {
    console.error("logPronunciationAttempt exception:", err);
  }
}

/**
 * Build an optional context block for LEGACY mode based on past sessions
 * and distilled insights, so the AI can say things like
 * "Last time you mentioned..." instead of starting cold every time.
 */
// Around ~ line 27xx in your 4303-line file
async function buildLegacyContextBlock(
  userId: string,
): Promise<string> {
  if (!supabase) return "";
  const client = supabase as SupabaseClient;

  try {
    // 1) Recent session-level summaries (layer 2)
    const { data: summaries, error: msError } = await client
      .from("memory_summary")
      .select("id, short_summary, full_summary, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(3);

    if (msError) {
      console.error("buildLegacyContextBlock: memory_summary error", msError);
    }

    // 2) Recent distilled insights (layer 3)
    const { data: insights, error: miError } = await client
      .from("memory_insights")
      .select("short_title, insight_text, insight_type, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(3);

    if (miError) {
      console.error("buildLegacyContextBlock: memory_insights error", miError);
    }

    // 3) Recent raw memories (layer 1 – specific vivid stories like Murder Crabs)
    const { data: rawMemories, error: mrError } = await client
      .from("memory_raw")
      .select("chapter_key, content, created_at, tags")
      .eq("user_id", userId)
      .contains("tags", ["legacy"])
      .order("created_at", { ascending: false })
      .limit(20); // extend beyond just a couple of turns

    if (mrError) {
      console.error("buildLegacyContextBlock: memory_raw error", mrError);
    }

    const lines: string[] = [];

    // Layer 2 – session summaries
    if (summaries && summaries.length > 0) {
      lines.push(
        "RECENT SESSION CONTEXT (do NOT repeat these verbatim; use them only to sound like a friend who remembers past conversations):",
      );

      for (const s of summaries) {
        const created = (s as any).created_at
          ? new Date((s as any).created_at as string)
              .toISOString()
              .slice(0, 10)
          : "unknown date";
        const label =
          ((s as any).short_summary as string | null) ??
          ((s as any).full_summary as string | null) ??
          "";
        const trimmed =
          label.length > 160 ? label.slice(0, 157) + "..." : label;
        lines.push(`- [${created}] ${trimmed}`);
      }
    }

    // 🔥 Layer 1 – specific raw stories
    if (rawMemories && rawMemories.length > 0) {
      if (lines.length > 0) {
        lines.push("");
      }

      lines.push(
        "RECENT SPECIFIC STORIES (you may casually refer back to these when relevant, e.g. \"last time you told me about...\"):",
      );

      for (const m of rawMemories) {
        const created = (m as any).created_at
          ? new Date((m as any).created_at as string)
              .toISOString()
              .slice(0, 10)
          : "unknown date";

        const chapterKey =
          ((m as any).chapter_key as string | null) ?? "general";

        const content = ((m as any).content as string | null) ?? "";
        const cleaned = content.trim();
        if (!cleaned) continue;

        const trimmed =
          cleaned.length > 220 ? cleaned.slice(0, 217) + "..." : cleaned;

        lines.push(`- [${created}][${chapterKey}] ${trimmed}`);
      }
    }

    // Layer 3 – high-level insights
    if (insights && insights.length > 0) {
      if (lines.length > 0) {
        lines.push("");
      }

      lines.push(
        "HIGH-LEVEL INSIGHTS ABOUT THIS PERSON (use gently, do NOT psychoanalyze):",
      );

      for (const ins of insights) {
        const title = (ins as any).short_title as string | null ?? "(no title)";
        const text = (ins as any).insight_text as string | null ?? "";
        const type = (ins as any).insight_type as string | null ?? "general";
        const trimmed =
          text.length > 220 ? text.slice(0, 217) + "..." : text;
        lines.push(`- (${type}) ${title}: ${trimmed}`);
      }

      lines.push(
        "",
        'Use these insights only to choose warmer follow-up questions and very occasional callbacks like "you\'ve mentioned before that..." or "last time we talked about...", when it genuinely fits.',
        "Important: do NOT assume hardship, trauma, poverty, discrimination, or activism based solely on birthplace, era, race, gender, or other demographics.",
        "If an insight sounds like a stereotype, treat it as a gentle question to explore, not as a fact.",
      );
    }

    if (lines.length === 0) {
      return "";
    }

    return `
PERSISTENT CONTEXT FROM EARLIER SESSIONS
${lines.join("\n")}
`.trim();
  } catch (err) {
    console.error("buildLegacyContextBlock: unexpected error", err);
    return "";
  }
}

// ============================================================================
// Language-learning system prompt
// ============================================================================

function buildEmptyCoverageMap(userId: string): CoverageMap {
  const baseChapters: Record<CoverageChapterKey, CoverageChapter> = {
    early_childhood: {
      key: "early_childhood",
      label: "Early Childhood (0–10)",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    adolescence: {
      key: "adolescence",
      label: "Adolescence (11–18)",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    early_adulthood: {
      key: "early_adulthood",
      label: "Early Adulthood (19–30)",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    midlife: {
      key: "midlife",
      label: "Midlife (31–55)",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    later_life: {
      key: "later_life",
      label: "Later Life (56+)",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    family_relationships: {
      key: "family_relationships",
      label: "Family & Relationships",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    work_career: {
      key: "work_career",
      label: "Work & Career",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    education: {
      key: "education",
      label: "Education",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    health_wellbeing: {
      key: "health_wellbeing",
      label: "Health & Wellbeing",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    hobbies_interests: {
      key: "hobbies_interests",
      label: "Hobbies & Interests",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    beliefs_values: {
      key: "beliefs_values",
      label: "Beliefs & Values",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
    major_events: {
      key: "major_events",
      label: "Major Life Events",
      coverage_score: 0,
      memory_count: 0,
      word_count_estimate: 0,
      total_weight: 0,
      example_memory_ids: [],
      open_questions: [],
      suggested_prompts: [],
    },
  };

  return {
    version: 1,
    user_id: userId,
    last_updated: new Date().toISOString(),
    global: {
      total_memories: 0,
      total_words_estimate: 0,
      total_memory_weight: 0,
      earliest_year: undefined,
      latest_year: undefined,
      dominant_themes: [],
    },
    chapters: baseChapters,
  };
}

function finalizeCoverageScores(map: CoverageMap): CoverageMap {
  const TARGET_WEIGHT_PER_CHAPTER = 50;   // “enough” rich memories per chapter
  const TARGET_WORDS_PER_CHAPTER = 50000; // rough word-volume target

  for (const chapter of Object.values(map.chapters)) {
    const weight = chapter.total_weight ?? 0;
    const words = chapter.word_count_estimate ?? 0;

    const weightFactor = Math.min(
      weight / TARGET_WEIGHT_PER_CHAPTER,
      1,
    );
    const wordFactor = Math.min(
      words / TARGET_WORDS_PER_CHAPTER,
      1,
    );

    // Weight is the primary driver, word-count is a secondary floor.
    const combined =
      weightFactor > 0
        ? 0.7 * weightFactor + 0.3 * wordFactor
        : 0.3 * wordFactor;

    chapter.coverage_score = Number(
      Math.min(1, Math.max(0, combined)).toFixed(2),
    );
  }

  return map;
}

// ============================================================================
// Gemini call
// ============================================================================
async function callGemini(finalPrompt: string): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing.");
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: finalPrompt }],
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("❌ Gemini API error:", res.status, errText);
    throw new Error(`Gemini API error: ${res.status} - ${errText}`);
  }

  const json = await res.json();

  try {
    const parts = json?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const text = parts
        .map((p: any) => (typeof p.text === "string" ? p.text : ""))
        .join("\n")
        .trim();

      if (text) return text;
    }
  } catch (e) {
    console.error("❌ Error parsing Gemini response:", e, json);
  }

  return "Sorry, I could not generate a reply.";
}

function extractJsonCandidate(text: string): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;

  // 1) Strip Markdown ```json fences if present
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    const inner = fence[1].trim();
    if (inner) return inner;
  }

  // 2) Try to find a top-level JSON object
  const obj = t.match(/\{[\s\S]*\}/);
  if (obj && obj[0]) return obj[0].trim();

  // 3) Try to find a top-level JSON array
  const arr = t.match(/\[[\s\S]*\]/);
  if (arr && arr[0]) return arr[0].trim();

  return null;
}


async function scorePronunciationWithGemini(
  targetScript: string,
  targetIpa: string | null,
  learnerTranscript: string,
  l1Locale: string,
  l2Locale: string,
): Promise<PronunciationScoreResult | null> {
  // Very short / empty transcripts are not worth scoring.
  if (!learnerTranscript.trim()) return null;

  const prompt = buildPronunciationScoringPrompt(
    targetScript,
    targetIpa,
    learnerTranscript,
    l1Locale,
    l2Locale,
  );

  const raw = await callGemini(prompt);

  try {
    const jsonText = extractJsonCandidate(raw) ?? raw;
    const parsed = JSON.parse(jsonText);

    if (
      typeof parsed.overall_score !== "number" ||
      typeof parsed.score_line !== "string"
    ) {
      console.warn("Pronunciation scoring: missing core fields", parsed);
      return null;
    }

    const result: PronunciationScoreResult = {
      overallScore: Math.max(
        0,
        Math.min(100, parsed.overall_score as number),
      ),
      scoreLine: parsed.score_line as string,
      perWord: Array.isArray(parsed.per_word) ? parsed.per_word : undefined,
      weakWords: Array.isArray(parsed.weak_words)
        ? parsed.weak_words
        : undefined,
    };

    return result;
  } catch (err) {
    console.error("Pronunciation scoring JSON parse error:", err, raw);
    return null;
  }
}

async function upsertCoverageMapRow(
  supabase: SupabaseClient,
  userId: string,
  map: CoverageMap
) {
  const { error } = await supabase
    .from("coverage_map_json")
    .upsert(
      {
        user_id: userId,
        data: map,
      },
      { onConflict: "user_id" }
    );

  if (error) {
    console.error("Error upserting coverage_map_json:", error);
  }
}

function inferChapterKeysForLegacySummary(
  text: string,
  themes: string[] = []
): CoverageChapterKey[] {
  const lowered = text.toLowerCase();
  const set = new Set<CoverageChapterKey>();

  const add = (k: CoverageChapterKey) => set.add(k);

  const hasTheme = (needle: string) =>
    themes.some((t) => t.toLowerCase().includes(needle));

  // Life-stage / time-of-life hints
  if (
    /\b(childhood|kid|elementary school|growing up)\b/.test(lowered) ||
    hasTheme("childhood")
  ) {
    add("early_childhood");
  }

  if (
    /\b(teen|high school|prom|adolescence)\b/.test(lowered) ||
    hasTheme("adolescence")
  ) {
    add("adolescence");
  }

  if (
    /\b(college|university|degree|class|teacher|course|study|studies|school)\b/.test(
      lowered,
    ) ||
    hasTheme("education")
  ) {
    add("education");
  }

  // Work & career
  if (
    /\b(job|work|career|office|boss|manager|company|business|client|coworker|co-worker)\b/.test(
      lowered,
    ) ||
    hasTheme("work") ||
    hasTheme("career")
  ) {
    add("work_career");
  }

  // Family & relationships (this will catch girlfriend / partner, etc.)
  if (
    /\b(mom|mother|dad|father|parent|parents|sister|brother|son|daughter|wife|husband|girlfriend|boyfriend|partner|family)\b/.test(
      lowered,
    ) ||
    hasTheme("family") ||
    hasTheme("relationship")
  ) {
    add("family_relationships");
  }

  // Health & wellbeing
  if (
    /\b(health|hospital|doctor|illness|sick|disease|mental health|anxiety|stress|exercise|gym|diet|weight|blood pressure)\b/.test(
      lowered,
    ) ||
    hasTheme("health")
  ) {
    add("health_wellbeing");
  }

  // Hobbies, interests, and your Murder Crabs–style food adventures
  if (
    /\b(hobby|hobbies|music|sport|sports|cycling|bike|bicycle|travel|trip|vacation|game|gaming|movie|film|reading|book|photography|cooking|cook|kitchen|restaurant|food|crab|seafood)\b/.test(
      lowered,
    ) ||
    hasTheme("hobby") ||
    hasTheme("interest")
  ) {
    add("hobbies_interests");
  }

  // Beliefs / values
  if (
    /\b(church|temple|mosque|faith|belief|value|philosophy|religion|god|spiritual)\b/.test(
      lowered,
    ) ||
    hasTheme("belief") ||
    hasTheme("values")
  ) {
    add("beliefs_values");
  }

  // Major life events, milestones, shocks
  if (
    /\b(wedding|marriage|divorce|accident|fired|laid off|promotion|move|moved|immigration|migration|born|birth|death|died|funeral|war|earthquake|pandemic)\b/.test(
      lowered,
    ) ||
    hasTheme("major_event") ||
    hasTheme("milestone")
  ) {
    add("major_events");
  }

  // Additional life-stage cues
  if (/\b(twenties|20s)\b/.test(lowered)) {
    add("early_adulthood");
  }
  if (/\b(thirties|30s|forties|40s|fifties|50s|midlife)\b/.test(lowered)) {
    add("midlife");
  }
  if (
    /\b(retired|retirement|sixties|60s|seventies|70s|later in life|old age)\b/.test(
      lowered,
    )
  ) {
    add("later_life");
  }

  // If literally nothing matched, treat it as a memorable event.
  if (!set.size) {
    add("major_events");
  }

  return Array.from(set);
}

export async function recomputeCoverageMapForUser(
  supabase: SupabaseClient,
  userId: string
): Promise<CoverageMap | null> {
  const { data, error } = await supabase
    .from("memory_summary")
    .select(
      "id, user_id, raw_id, created_at, short_summary, full_summary, observations"
    )
    .eq("user_id", userId);

  if (error) {
    console.error("Error fetching memory_summary for coverage_map:", error);
    return null;
  }

  const rows = (data || []) as MemorySummaryRow[];
  const map = buildEmptyCoverageMap(userId);

  // If there truly are no summaries yet, write an empty map and return.
  if (!rows.length) {
    console.log(
      "[coverage] recomputeCoverageMapForUser: no memory_summary rows for user",
      userId
    );
    await upsertCoverageMapRow(supabase, userId, map);
    return map;
  }

  console.log(
    "[coverage] recomputeCoverageMapForUser: rows.length =",
    rows.length
  );

  const themeCounts: Record<string, number> = {};

  for (const row of rows) {
    const meta = (row.observations || {}) as {
      chapter_keys?: CoverageChapterKey[];
      start_year?: number;
      end_year?: number;
      word_count_estimate?: number;
      themes?: string[];
    };

    // 1) Prefer explicit chapter_keys from the new pipeline…
    let chapters: CoverageChapterKey[] = Array.isArray(meta.chapter_keys)
      ? meta.chapter_keys
      : [];

    // 2) …but for older summaries (or anything missing chapter_keys), lazily
    //    infer the best-guess chapters from the text + any theme tags.
    if (!chapters.length) {
      const textForInfer =
        row.full_summary ||
        row.short_summary ||
        "";
      const themes = Array.isArray(meta.themes) ? meta.themes : [];
      chapters = inferChapterKeysForLegacySummary(textForInfer, themes);
    }

    const text =
      row.full_summary ||
      row.short_summary ||
      "";

    const roughWordCount =
      meta.word_count_estimate ??
      (text ? text.split(/\s+/).length : 0);

    // Always count this summary globally.
    map.global.total_memories += 1;
    map.global.total_words_estimate += roughWordCount;

    if (meta.start_year != null) {
      if (
        map.global.earliest_year == null ||
        meta.start_year < map.global.earliest_year
      ) {
        map.global.earliest_year = meta.start_year;
      }
    }
    if (meta.end_year != null) {
      if (
        map.global.latest_year == null ||
        meta.end_year > map.global.latest_year
      ) {
        map.global.latest_year = meta.end_year;
      }
    }

    for (const t of meta.themes || []) {
      const key = String(t).toLowerCase();
      themeCounts[key] = (themeCounts[key] || 0) + 1;
    }

    // If there are no chapter mappings, skip the per-chapter update,
    // but keep the global counters we just updated.
    if (!chapters.length) continue;

    for (const chapterKey of chapters) {
      const chapter = map.chapters[chapterKey];
      if (!chapter) continue;

      chapter.memory_count += 1;
      chapter.word_count_estimate += roughWordCount;

      if (meta.start_year != null) {
        if (
          !chapter.time_span?.start_year ||
          meta.start_year <
            (chapter.time_span.start_year || 9999)
        ) {
          chapter.time_span = chapter.time_span || {};
          chapter.time_span.start_year = meta.start_year;
        }
      }
      if (meta.end_year != null) {
        if (
          !chapter.time_span?.end_year ||
          meta.end_year >
            (chapter.time_span.end_year || 0)
        ) {
          chapter.time_span = chapter.time_span || {};
          chapter.time_span.end_year = meta.end_year;
        }
      }

      if (
        !chapter.last_covered_at ||
        new Date(row.created_at) >
          new Date(chapter.last_covered_at)
      ) {
        chapter.last_covered_at = row.created_at;
      }

      if (!chapter.example_memory_ids.includes(row.id)) {
        if (chapter.example_memory_ids.length < 5) {
          chapter.example_memory_ids.push(row.id);
        }
      }
    }
  }

  // Recompute global totals from the per-chapter coverage so the
  // headline "memories captured" stays in sync with what the user
  // sees in the chapter buckets.
  const chapterList = Object.values(map.chapters);

  map.global.total_memories = chapterList.reduce(
    (sum, ch: any) => sum + (ch.memory_count ?? 0),
    0,
  );

  map.global.total_words_estimate = chapterList.reduce(
    (sum, ch: any) => sum + (ch.word_count_estimate ?? 0),
    0,
  );

  const themeEntries = Object.entries(themeCounts).sort(
    (a, b) => b[1] - a[1]
  );

  map.global.dominant_themes = themeEntries
    .slice(0, 5)
    .map(([key]) => key);

  const finalized = finalizeCoverageScores(map);
  finalized.last_updated = new Date().toISOString();

  await upsertCoverageMapRow(supabase, userId, finalized);
  return finalized;
}

async function buildLanguageLearningContextBlock(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string,
  maxTurns: number = 8,
): Promise<string> {
  const { data, error } = await supabase
    .from("memory_raw")
    .select("role, content, created_at, tags")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .contains("tags", ["language_learning"])
    .order("created_at", { ascending: true })
    .limit(maxTurns);

  if (error) {
    console.error(
      "Error fetching language-learning context from memory_raw:",
      error,
    );
    return "";
  }

  const rows = (data || []) as { role: string; content: string }[];
  if (!rows.length) return "";

  const lines = rows.map((row) => {
    const who = row.role === "assistant" ? "Tutor" : "Learner";
    return `- ${who}: ${row.content}`;
  });

  return formatRecentLanguageLearningConversation(lines);
}

function inferGenerationLabel(birthYear: number): string {
  if (birthYear >= 1997) return "Gen Z or younger";
  if (birthYear >= 1981) return "Millennial";
  if (birthYear >= 1965) return "Gen X";
  if (birthYear >= 1946) return "Baby Boomer";
  return "Silent Generation or older";
}

export async function recomputeLifetimeProfileForUser(
  supabase: SupabaseClient,
  userId: string,
  coverage: CoverageMap | null,
): Promise<LifetimeProfile | null> {
  // NOTE: This reads from your public.profiles table (donor preferences / settings).
  // Your schema has: display_name, legal_name, birthdate, country_region, preferred_language, supported_languages, etc.
  const { data: prof, error: profileError } = await supabase
    .from("profiles")
    .select(
      "id, display_name, legal_name, birthdate, country_region, preferred_language, supported_languages",
    )
    .eq("id", userId)
    .maybeSingle();

  if (profileError) {
    console.error("Error fetching profile for lifetime_profile:", profileError);
    return null;
  }

  const displayName = (prof as any)?.display_name ?? undefined;
  const legalName = (prof as any)?.legal_name ?? undefined;

  const birthdateRaw = (prof as any)?.birthdate as string | null | undefined;
  const birthDate = birthdateRaw ? String(birthdateRaw) : undefined;

  let birthYearEstimate: number | undefined = undefined;
  if (birthDate) {
    const m = /^(\d{4})-/.exec(birthDate);
    if (m) birthYearEstimate = Number(m[1]);
  }

  const countryRegion = (prof as any)?.country_region ?? undefined;

  const nowIso = new Date().toISOString();

  const out: LifetimeProfile = {
    version: 1,
    user_id: userId,
    last_updated: nowIso,
    core_identity: {
      legal_name: legalName,
      display_name: displayName,
      birth_date: birthDate,
      birth_year_estimate: birthYearEstimate,
    },
    locations: {
      current_location: countryRegion,
      birth_place: undefined,
    },
    preferences: {
      preferred_language: (prof as any)?.preferred_language ?? undefined,
      supported_languages: Array.isArray((prof as any)?.supported_languages)
        ? (prof as any)?.supported_languages
        : undefined,
    },
    coverage_snapshot: coverage ?? undefined,
  };

  return out;
}

export async function recomputeUserKnowledgeGraphs(
  supabase: SupabaseClient,
  userId: string
): Promise<void> {
  try {
    const coverage = await recomputeCoverageMapForUser(
      supabase,
      userId
    );
    await recomputeLifetimeProfileForUser(
      supabase,
      userId,
      coverage
    );
  } catch (err) {
    console.error("Error recomputing user knowledge graphs:", err);
  }
}


  // ============================================================================
  // HTTP Handler
  // ============================================================================
  export async function runTurnPipeline(req: Request): Promise<Response> {
    try {
      if (req.method !== "POST") {
        return jsonResponse({ error: "Only POST allowed." }, 405);
      }

      let body: AiBrainPayload;
      try {
        const raw = await req.json();
        console.log("🧠 ai-brain incoming:", raw);
        body = raw as AiBrainPayload;
      } catch (_err) {
        return jsonResponse({ error: "Invalid JSON body." }, 400);
      }

      const { user_id, conversation_id } = body;

      // -------------------------------------------------------------------
      // Response payload variables (must be defined for all code paths)
      // -------------------------------------------------------------------
      let reply_text: string | null = null; // chat-bubble text only
      let endSessionSummaryPayload: Record<string, any> | null = null;
      let insightMomentPayload: Record<string, any> | null = null;
      let summaryIdForSeeds: string | null = null;

      // Make message_text mutable (we may normalize it)
      let message_text = (body as any).message_text as string | undefined;

      // -------------------------------------------------------------------
      // End-session payloads (must be defined for all code paths)
      // -------------------------------------------------------------------
// (deduped) endSessionSummaryPayload already declared above
// (deduped) insightMomentPayload already declared above


      // Treat the hidden token as an end-session trigger too.
      const isEndSession =
        (body as any).end_session === true ||
        (body as any).action === "end_session" ||
        (typeof message_text === "string" && message_text.trim() === "__END_SESSION__");

      // Allow end_session calls to omit message_text (client may send empty).
      if (isEndSession && (!message_text || !String(message_text).trim())) {
        message_text = "__END_SESSION__";
    }
      const bodyAny = body as any;

      const receivedConversationId =
        String(bodyAny?.conversation_id ?? bodyAny?.conversationId ?? "");

      const receivedMessageText =
        String(bodyAny?.message_text ?? bodyAny?.text ?? bodyAny?.message ?? "");

      const receivedEndSession =
        bodyAny?.end_session === true ||
        bodyAny?.endSession === true ||
        bodyAny?.action === "end_session" ||
        receivedMessageText.trim() === "__END_SESSION__" ||
        receivedMessageText.trim() === "[END_SESSION]";

      console.log("AI_BRAIN_RECEIPT", {
        conversation_id: receivedConversationId,
        end_session: receivedEndSession,
        has_message_text: receivedMessageText.trim().length > 0,
        keys: Object.keys(bodyAny ?? {}),
      });

      console.log("TURN_CORE_VERSION", "turn_core_4859_learning_persist_v1_2025-12-30");

      // -----------------------------------------------------------------------
      // 1) Resolve mode, persona, locales, conversation id
      // -----------------------------------------------------------------------
      const requestedMode = (body.mode ?? "legacy") as ConversationMode;
      const conversationMode: ConversationMode =
        requestedMode === "language_learning" || requestedMode === "avatar"
          ? requestedMode
          : "legacy";

      const personaRaw =
        (body.conversation_persona ?? (body as any).persona ?? null) as
          | string
          | null;

      let conversationPersona: ConversationPersona = "adaptive";
      if (typeof personaRaw === "string" && personaRaw.trim()) {
        const lower = personaRaw.trim().toLowerCase();
        if (lower === "playful") {
          conversationPersona = "playful";
        } else if (lower === "somber" || lower === "grounded") {
          // allow older clients that still send "grounded"
          conversationPersona = "somber";
        } else {
          conversationPersona = "adaptive";
        }
      }

      const preferredLocale = normalizeLocale(
        (body.preferred_locale ?? body.preferredLocale) as unknown,
        "und",
      );

      const targetRaw =
        body.target_locale ?? body.targetLocale ?? body.targetLocaleRaw ?? null;

      const hasTarget = !!(targetRaw && String(targetRaw).trim());
      const targetLocale = hasTarget ? normalizeLocale(targetRaw as unknown, "und") : null;

      const learningLevel: LearningLevel =
        body.learning_level &&
        ["beginner", "intermediate", "advanced"].includes(body.learning_level)
          ? body.learning_level
          : "beginner";

      // ✅ NEVER use "default" as a real session key.
      // If the client didn't send a conversation_id, generate one.
      const effectiveConversationId =
        (conversation_id && conversation_id.trim() && conversation_id.trim() !== "default")
          ? conversation_id.trim()
          : crypto.randomUUID();

      const incomingStateJson = body.state_json ?? null;

      let legacyState: LegacyInterviewState | null = null;
      let languageState: LanguageLessonState | null = null;

      if (conversationMode === "language_learning") {
        // Prefer canonical progress from Supabase if available.
        const dbState = await loadLanguageProgress(user_id, targetLocale);
        const incomingState = parseLanguageLessonState(incomingStateJson);

        languageState =
          dbState ??
          incomingState ??
          getDefaultLanguageLessonState();
      } else {
        // Legacy and avatar share the LegacyInterviewState shape.
        legacyState =
          parseLegacyState(incomingStateJson) ?? getDefaultLegacyState();
      }

      // -----------------------------------------------------------------------
      // 2) Handle language-learning meta-commands before calling Gemini
      // -----------------------------------------------------------------------
      if (conversationMode === "language_learning") {
        const rawUserText =
          (body.message_text ??
            (body as any).message ??
            (body as any).user_message ??
            (body as any).input ??
            "") as string;

        const currentState =
          languageState ?? getDefaultLanguageLessonState();

        // 2a) Progress query – describe current position, do NOT advance.
        if (isProgressQuery(rawUserText)) {
          const summary = buildLanguageProgressSummary(
            preferredLocale,
            targetLocale,
            learningLevel,
            currentState,
          );

          await saveLanguageProgress(
            user_id,
            targetLocale,
            currentState,
            learningLevel,
          );

          return jsonResponse({
            reply_text: summary,
            mode: conversationMode,
            preferred_locale: preferredLocale,
            target_locale: hasTarget ? targetLocale : null,
            learning_level: learningLevel,
            conversation_id: effectiveConversationId,
            state_json: JSON.stringify(currentState),
          });
        }

        // 2b) Go-back query – regress and describe the new position.
        if (isGoBackQuery(rawUserText)) {
          const regressed = regressLanguageLessonState(currentState);

          await saveLanguageProgress(
            user_id,
            targetLocale,
            regressed,
            learningLevel,
          );

          const replyText = buildGoBackReply(
            preferredLocale,
            targetLocale,
            learningLevel,
            regressed,
          );

          return jsonResponse({
            reply_text: replyText,
            mode: conversationMode,
            preferred_locale: preferredLocale,
            target_locale: hasTarget ? targetLocale : null,
            learning_level: learningLevel,
            conversation_id: effectiveConversationId,
            state_json: JSON.stringify(regressed),
          });
        }

        // 2c) Move-ahead query – fast-forward and describe the new position.
        if (isMoveAheadQuery(rawUserText)) {
          const advancedState = fastForwardLanguageState(currentState);

          await saveLanguageProgress(
            user_id,
            targetLocale,
            advancedState,
            learningLevel,
          );

          const replyText = buildMoveAheadReply(
            preferredLocale,
            targetLocale,
            learningLevel,
            advancedState,
          );

          return jsonResponse({
            reply_text: replyText,
            mode: conversationMode,
            preferred_locale: preferredLocale,
            target_locale: hasTarget ? targetLocale : null,
            learning_level: learningLevel,
            conversation_id: effectiveConversationId,
            state_json: JSON.stringify(advancedState),
          });
        }
      }

      // -----------------------------------------------------------------------
      // 3) Build system prompt + context block
      // -----------------------------------------------------------------------
      let systemPrompt: string;
      let contextBlock = "";

      if (conversationMode === "language_learning") {
        const ls = languageState ?? getDefaultLanguageLessonState();

        // Safely pick a unit + lesson from the curriculum.
        const fallbackUnit = LANGUAGE_UNITS["U1_GREETINGS"];
        const unit =
          LANGUAGE_UNITS[ls.unit_id] ?? fallbackUnit;

        const fallbackLesson =
          (Object.values(fallbackUnit.lessons)[0] as LanguageLessonConfig) ??
          {
            lesson_id: "L1_HELLO_BASICS",
            lesson_name: "Basic greetings",
            default_stage: "intro",
            default_target_phrases: [],
          };

        const lesson =
          (unit.lessons[ls.lesson_id] as LanguageLessonConfig) ?? fallbackLesson;

        systemPrompt = buildLanguageLearningSystemPrompt(
          preferredLocale, // L1
          targetLocale,    // L2
          learningLevel,
          ls,
          unit,
          lesson,
        );


        // -------------------------------------------------------------------
        // Output formatting contract (UI + TTS rely on this)
        // -------------------------------------------------------------------
        // In language-learning mode, we REQUIRE explicit tagging so the app can:
        //  - display L1 guidance
        //  - display optional romanization
        //  - have TTS speak ONLY the [L2] lines (and skip [ROM])
        //
        // Format rules for EVERY assistant reply in language_learning mode:
        //   [L1] <short guidance in the learner's native language>
        //   [L2] <target-language text only>
        //   [ROM] <optional romanization / transliteration>  (NEVER required)
        //
        // Additional rules:
        //  - Do not mix tags on the same line.
        //  - Keep [L2] lines free of explanations.
        //  - If you include [ROM], keep it on its own line(s).

        systemPrompt = systemPrompt + "\n\n" + TAGGING_CONTRACT;


        // Beginner: prioritize L1 guidance heavily, keep L2 small + supportive
        if ((learningLevel ?? "").toLowerCase() === "beginner") {
          systemPrompt += "\n\n" + buildBeginnerModeAddon();
        }

        if (supabase) {
          contextBlock = await buildLanguageLearningContextBlock(
            supabase as SupabaseClient,
            user_id,
            effectiveConversationId,
          );
        }
      } else if (conversationMode === "avatar") {
        systemPrompt = buildAvatarSystemPrompt(preferredLocale);

        if (supabase) {
          contextBlock = await buildLegacyContextBlock(user_id);
        }
      } else {
        // Legacy storytelling mode.
        const ls = legacyState ?? getDefaultLegacyState();
        const chapter =
          LEGACY_CHAPTERS[ls.chapter_id] ?? LEGACY_CHAPTERS["childhood"];

        const legacyCtx: LegacyPromptContext = {
          persona: conversationPersona,
          preferredLocale,
          targetLocale: hasTarget ? targetLocale : null,
          legacyState: ls,
          currentChapter: chapter,
          userDisplayName: undefined,
          coverageSummary: undefined,
        };

        systemPrompt = buildLegacySystemPrompt(legacyCtx);

        if (supabase) {
          contextBlock = await buildLegacyContextBlock(user_id);
        }
      }

      // -----------------------------------------------------------------------
      // 4) Call Gemini
      // -----------------------------------------------------------------------
      const rawUserMessageForPrompt =
        (body.message_text ??
          (body as any).message ??
          (body as any).user_message ??
          (body as any).input ??
          "") as string;

      const userMessageForPrompt =
        conversationMode === "avatar"
          ? rawUserMessageForPrompt
          : (message_text ?? rawUserMessageForPrompt);

      const finalPrompt = `${systemPrompt}

${contextBlock}

User message:
"${userMessageForPrompt.trim()}"`.trim();

      let rawReply = "";

      if (!isEndSession) {
        rawReply = await callGemini(finalPrompt);
      } else {
        // End-session should not pay per-turn latency for a normal assistant reply.
        rawReply = "";
      }

      // Clean Gemini output.
      const sanitized = sanitizeGeminiOutput(rawReply);

      // Enforce language tags.
      let replyText = enforceLanguageOnTaggedLines(
        sanitized,
        preferredLocale,
        hasTarget ? targetLocale : null,
      );

      // -------------------------------------------------------------------
      // Beginner safety net: prevent "L2 wall of text"
      // If the model drifts into mostly L2, do ONE rewrite pass to enforce
      // beginner format (mostly L1, short L2 examples).
      // -------------------------------------------------------------------
      if (
        conversationMode === "language_learning" &&
        (learningLevel ?? "").toLowerCase() === "beginner" &&
        hasTarget &&
        typeof replyText === "string" &&
        replyText.trim().length > 0
      ) {
        const target = String(targetLocale ?? "").toLowerCase();
        // Thai detection (common for your use case)
        const isThai = target.startsWith("th");
        if (isThai) {
          const bodyOnly = replyText.replace(/\[(?:L1|L2|ROM|META)\]\s*/gi, " ");
          const thaiChars = (bodyOnly.match(/[\u0E00-\u0E7F]/g) ?? []).length;
          const letters = (bodyOnly.match(/[A-Za-z\u0E00-\u0E7F]/g) ?? []).length;
          const ratio = letters > 0 ? thaiChars / letters : 0;

          // If Thai is more than ~35% of letter content, rewrite.
          if (ratio > 0.35) {
            console.warn("⚠️ Beginner drift detected (Thai ratio)", ratio.toFixed(2));
            const rewritePrompt = buildBeginnerRewritePrompt({
              systemPrompt,
              contextBlock,
              replyText,
            });

            const rewrittenRaw = await callGemini(rewritePrompt);
            const rewrittenSanitized = sanitizeGeminiOutput(rewrittenRaw);
            replyText = enforceLanguageOnTaggedLines(
              rewrittenSanitized,
              preferredLocale,
              hasTarget ? targetLocale : null,
            );
          }
        }
      }



      // Remove any romanization leakage from [L1] lines (prevents L1 TTS from butchering it).
            // -------------------------------------------------------------------
      // Separate bubble text (for chat/TTS) from learning artifacts (for Learning screen)
      // -------------------------------------------------------------------
      let learningBlocksForClient: LearningBlock[] = [];
      if (conversationMode === "language_learning" && typeof replyText === "string") {
        const extracted = extractLearningArtifacts(replyText);
        // Bubble text used for UI + TTS (L1/L2 only)
        replyText = extracted.bubbleText || replyText;
        learningBlocksForClient = extracted.blocks;

        // Fallback: if model forgot any Learning blocks, create a minimal one from [L2] lines
        if (!learningBlocksForClient || learningBlocksForClient.length === 0) {
          const fb = buildFallbackLearningBlockFromBubble(replyText);
          if (fb) {
            learningBlocksForClient = [fb];
          } else {
            // Last-resort fallback: create a short LESSON block from the reply text
            // (does not affect bubble/TTS order).
            const plain = String(replyText)
              .split(/\r?\n/)
              .map((l) => l.replace(/^\[[A-Z0-9_]+\]\s*/i, "").trim())
              .filter(Boolean)
              .join("\n")
              .trim();
            if (plain.length > 0) {
              learningBlocksForClient = [
                {
                  tag: "LESSON",
                  title: "Auto lesson",
                  content: plain.slice(0, 1200),
                  raw_text: `[LESSON]\n${plain.slice(0, 1200)}`,
                },
              ];
            }
          }
        }
      }

if (conversationMode === "language_learning" && typeof replyText === "string") {
        replyText = stripRomanizationFromL1Lines(replyText);
      }

      // Persist the chat-bubble text (null for end-session)
      const trimmedReplyText = replyText.trim();
      reply_text = trimmedReplyText.length > 0 ? trimmedReplyText : null;


      // -----------------------------------------------------------------------
      // 5) Optional pronunciation scoring (language-learning only)
      // -----------------------------------------------------------------------
      let pronunciationScore: number | null = null;
      let pronunciationScoreLine: string | null = null;

      if (
        conversationMode === "language_learning" &&
        hasTarget &&
        languageState &&
        languageState.target_phrases &&
        languageState.target_phrases.length > 0
      ) {
        const main = languageState.target_phrases[0];
        const targetScript = main.l2_script;
        const targetIpa = main.ipa ?? null;

        const learnerTranscript =
          (body as any).learner_transcript as string | undefined;

        if (learnerTranscript && learnerTranscript.trim().length > 0) {
          try {
            const scoring = await scorePronunciationWithGemini(
              targetScript,
              targetIpa,
              learnerTranscript,
              preferredLocale,
              targetLocale,
            );

            if (scoring) {
              pronunciationScore = scoring.overallScore;
              pronunciationScoreLine = scoring.scoreLine;

              await logPronunciationAttempt(
                user_id,
                targetLocale,
                languageState,
                learnerTranscript,
                pronunciationScore,
                pronunciationScoreLine,
              );
            }
          } catch (err) {
            console.error("Pronunciation scoring error:", err);
          }
        }
      }

      // -----------------------------------------------------------------------
      // 6) Prepare next state for the client
      // -----------------------------------------------------------------------
      let outgoingStateJson: string | null = null;

      if (conversationMode === "language_learning") {
        const current = languageState ?? getDefaultLanguageLessonState();
        const advanced = advanceLanguageLessonState(current);
        outgoingStateJson = JSON.stringify(advanced);

        await saveLanguageProgress(
          user_id,
          targetLocale,
          advanced,
          learningLevel,
        );
      } else {
        // Legacy mode: do NOT send structured chapter routing to the client.
        // We keep any legacyState internally, but the client should treat legacy sessions as free-form.
        outgoingStateJson = "{}";
      }

      // -----------------------------------------------------------------------
      // 7) Persistence: legacy + language-learning logging
      // -----------------------------------------------------------------------
      if (supabase) {
        const client = supabase as SupabaseClient;

        // 7a) Legacy interview persistence (memory_raw + optional summary)
        if (conversationMode === "legacy") {
          try {
            const ls = legacyState ?? getDefaultLegacyState();
            let userText = (message_text ?? "").trim();
            if (userText === "__END_SESSION__") userText = "";

            const aiText = replyText.trim();
            const nowIso = new Date().toISOString();

            // Write user + AI turns into memory_raw
            const legacyRows: any[] = [];

            const coverageChapters: CoverageChapterKey[] = (() => {
              switch (ls.chapter_id) {
                case "childhood":
                  return ["early_childhood", "family_relationships", "education"];
                case "early_career":
                  return ["early_adulthood", "work_career", "major_events"];
                case "midlife":
                  return ["midlife", "family_relationships", "health_wellbeing"];
                case "later_life":
                  return ["later_life", "health_wellbeing", "major_events"];
                default:
                  return ["major_events"];
              }
            })();


            // Content-based chapter assignment for this turn.
            // We prefer a fast deterministic inference from the actual text so we don't
            // accidentally stamp every row as "early_childhood" due to a default legacy chapter.
            const inferredTurnKeys = inferChapterKeysForLegacySummary(
              [userText, aiText].filter(Boolean).join("\n"),
              [],
            );
            const primaryTurnChapterKey: CoverageChapterKey =
              (inferredTurnKeys && inferredTurnKeys[0]) ||
              (coverageChapters && coverageChapters[0]) ||
              "major_events";

            const orderedTurnKeys: CoverageChapterKey[] = (
              (inferredTurnKeys && inferredTurnKeys.length ? inferredTurnKeys : coverageChapters) || ["major_events"]
            ).slice(0, 3) as CoverageChapterKey[];

            const turnChapterKey2: CoverageChapterKey | null = orderedTurnKeys[1] ?? null;
            const turnChapterKey3: CoverageChapterKey | null = orderedTurnKeys[2] ?? null;

            const userWordCount = userText.length > 0
              ? Math.max(1, Math.round(userText.split(/\s+/).length))
              : 0;
            const aiWordCount = aiText.length > 0
              ? Math.max(1, Math.round(aiText.split(/\s+/).length))
              : 0;
            const wordCountThisTurn = userWordCount + aiWordCount;

            if (userText) {
              legacyRows.push({
                user_id,
                content: userText,
                source: "legacy_user",
                conversation_id: effectiveConversationId,
                role: "user",
                context: {
                  mode: "legacy",
                  chapter_id: ls.chapter_id,
                  chapter_title: ls.chapter_title,
                },
                tags: ["legacy"],
                created_at: nowIso,
                chapter_key: primaryTurnChapterKey,
                word_count_estimate: userWordCount,
                is_legacy_story: true,
                user_edited: false,
              });
            }

            if (aiText) {
              legacyRows.push({
                user_id,
                content: aiText,
                source: "legacy_ai",
                conversation_id: effectiveConversationId,
                role: "assistant",
                context: {
                  mode: "legacy",
                  chapter_id: ls.chapter_id,
                  chapter_title: ls.chapter_title,
                },
                tags: ["legacy"],
                created_at: nowIso,
                chapter_key: primaryTurnChapterKey,
                word_count_estimate: aiWordCount,
                is_legacy_story: true,
                user_edited: false,
              });
            }

            let rawIdThisTurn: string | null = null;
            if (legacyRows.length > 0) {
              const { data: inserted, error: insertError } = await client
                .from("memory_raw")
                .insert(legacyRows)
                .select("id")
                .limit(1);

              if (insertError) {
                console.error(
                  "Error inserting legacy rows into memory_raw:",
                  insertError,
                );
              } else if (inserted && inserted.length > 0) {
                rawIdThisTurn = (inserted[0] as any).id as string;
              }
            }

            // Only do the expensive summarisation when this is an explicit end-session.
            if (isEndSession) {
              await runEndSessionPipeline({
                client,
                user_id,
                effectiveConversationId,
                rawIdThisTurn,
                conversationMode,
                preferredLocale,
                targetLocale: hasTarget ? targetLocale : null,
                hasTarget,
                learningLevel,
                legacyState,
                nowIso,
                deps: {
                  fetchLegacySessionTranscript,
                  summarizeLegacySessionWithGemini,
                  inferChapterKeysForLegacySummary,
                  classifyCoverageFromStoryText,
                  upsertStorySeedsForConversation,
                  recomputeUserKnowledgeGraphs,
                  invokeRebuildInsightsInternal,
                },
              });
            }
          } catch (err) {
            console.error("Legacy persistence error:", err);
          }
        }

        // 7b) Language-learning logging into memory_raw (no summaries yet).
        if (conversationMode === "language_learning") {
          try {
            let userText = (message_text ?? "").trim();

            // If the client sent the hidden end-session token, treat it as no user text.
            if (userText === "__END_SESSION__") {
              userText = "";
            }

            const aiText = replyText.trim();
            const nowIso = new Date().toISOString();

            const rows: any[] = [];

            if (userText) {
              rows.push({
                user_id,
                content: userText,
                source: "language_learning_user",
                conversation_id: effectiveConversationId,
                role: "user",
                context: {
                  mode: "language_learning",
                  target_locale: targetLocale,
                  learning_level: learningLevel,
                },
                tags: ["language_learning"],
                created_at: nowIso,
            });
            }

            if (aiText) {
              rows.push({
                user_id,
                content: aiText,
                source: "language_learning_ai",
                conversation_id: effectiveConversationId,
                role: "assistant",
                context: {
                  mode: "language_learning",
                  target_locale: targetLocale,
                  learning_level: learningLevel,
                },
                tags: ["language_learning"],
                created_at: nowIso,
              });
            }

            if (rows.length > 0) {
              const { error } = await client.from("memory_raw").insert(rows);

            // Also persist Learning artifacts (donor-wide history + searchable)
            console.log("LEARNING_PERSIST_CALLSITE", {
              mode: conversationMode,
              conversation_id: effectiveConversationId,
              user_id,
              blocksLen: learningBlocksForClient?.length ?? 0,
            });

            if (learningBlocksForClient && learningBlocksForClient.length > 0) {
              try {
                await persistLearningArtifacts(client, {
                  user_id,
                  conversation_id: effectiveConversationId,
                  preferred_locale: preferredLocale,
                  target_locale: hasTarget ? targetLocale : null,
                  learning_level: learningLevel ?? null,
                  blocks: learningBlocksForClient,
                });
              } catch (e) {
                console.error("LEARNING_PERSIST_CALL_FAIL", e);
              }
            }

              if (error) {
                console.error(
                  "Error inserting language-learning rows into memory_raw:",
                  error,
                );
              }
            }
          } catch (err) {
            console.error(
              "Exception inserting language-learning rows into memory_raw:",
              err,
            );
          }
        }
      }

      // -----------------------------------------------------------------------
      
      // -----------------------------------------------------------------------
      // 7c) Prepare outgoing state_json (string) for client
      // -----------------------------------------------------------------------
      let outgoing_state_json: string | null = null;

      try {
        if (conversationMode === "language_learning") {
          outgoing_state_json = JSON.stringify(languageState ?? getDefaultLanguageLessonState(targetLocale));
        } else if (conversationMode === "avatar") {
          outgoing_state_json = JSON.stringify(legacyState ?? getDefaultLegacyState());
        } else {
          // legacy: keep state_json minimal to avoid re-triggering old chapter machine in client
          outgoing_state_json = "{}";
        }
      } catch (_) {
        outgoing_state_json = "{}";
      }

      // Provide learning artifacts to the client (language-learning only)
      const learning_artifacts_payload =
        (conversationMode === "language_learning")
          ? { blocks: learningBlocksForClient.map((b) => ({
              tag: b.tag,
              title: b.title ?? null,
              content: b.content,
            })) }
          : null;

      const legacy_artifacts_payload =
        (conversationMode === "legacy" || conversationMode === "avatar")
          ? {
              end_session_summary: endSessionSummaryPayload,
              insight_moment: insightMomentPayload,
            }
          : null;

      // Bubble reply text (null for end-session)
      const safeReplyText = (isEndSession ? null : (reply_text ?? "").trim());

      try {
        const la = (learningArtifacts as any) || null;
        const blocksLen = la?.blocks?.length ?? 0;

        console.log("LEARNING_ARTIFACTS_DEBUG", {
          mode: conversationMode,
          blocksLen,
          hasLearningArtifacts: !!la,
          hasReplyText: typeof safeReplyText === "string" && safeReplyText.length > 0,
        });
      } catch (e) {
        console.log("LEARNING_ARTIFACTS_DEBUG_ERROR", String(e));
      }

      // 8) Final response to the client
      // -----------------------------------------------------------------------
      return jsonResponse({
        reply_text: safeReplyText,
        learning_artifacts: learning_artifacts_payload,
        legacy_artifacts: legacy_artifacts_payload,
        mode: conversationMode,
        preferred_locale: preferredLocale,
        target_locale: hasTarget ? targetLocale : null,
        learning_level: learningLevel,
        conversation_id: effectiveConversationId,
        state_json: outgoing_state_json,   

        end_session: isEndSession,
        end_session_summary: endSessionSummaryPayload,
        insight_moment: insightMomentPayload,

        pronunciation_score: pronunciationScore ?? null,
        pronunciation_score_line: pronunciationScoreLine ?? null,
      });

    } catch (e) {
      console.error("❌ ai-brain handler error:", e);
      return jsonResponse(
        {
          error: "Failed to generate reply from Gemini.",
          details: String(e),
        },
        500,
      );
    }
}