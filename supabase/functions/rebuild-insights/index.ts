// supabase/functions/rebuild-insights/index.ts
//
// Rebuilds cross-session "insights" from memory_summary and writes them into:
// 1) lifetime_profile.data.life_themes (master page + themes)
// 2) memory_insights as theme-level rows + one lifetime_overview row.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Match ai-brain: accept either GEMINI_API_KEY or GEMINI_API_KEY_EDGE
const GEMINI_API_KEY =
  Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GEMINI_API_KEY_EDGE");

const GEMINI_MODEL =
  Deno.env.get("GEMINI_MODEL") ?? "models/gemini-1.5-flash";

interface MemorySummaryRow {
  id: string;
  user_id: string;
  short_summary: string;
  full_summary: string | null;
  created_at: string;
  observations: Record<string, unknown> | null;
}

interface LifeTheme {
  key: string;
  title: string;
  description: string;
}

interface LifeThemesResult {
  summary_sentence: string;
  master_page: string;
  themes: LifeTheme[];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function safeTrim(s: unknown): string {
  return typeof s === "string" ? s.trim() : "";
}

/**
 * Backfill missing memory_summary rows by grouping memory_raw by conversation_id.
 * This is a safety net when ai-brain is not currently writing session summaries.
 */
async function backfillSessionSummariesFromMemoryRaw(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ inserted: number; scannedSessions: number }> {
  // Pull recent raw rows (tune the window if you want: 3–14 days).
  const sinceIso = isoDaysAgo(14);

  const { data: rawRows, error: rawErr } = await supabase
    .from("memory_raw")
    .select("id, conversation_id, created_at, role, content")
    .eq("user_id", userId)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });

  if (rawErr) {
    console.error("backfill: memory_raw fetch error", rawErr);
    return { inserted: 0, scannedSessions: 0 };
  }

  const rows = (rawRows || []) as Array<{
    id: string;
    conversation_id: string | null;
    created_at: string;
    role: string | null;
    content: string | null;
  }>;

  // Group by conversation_id
  const bySession = new Map<string, typeof rows>();
  for (const r of rows) {
    const cid = safeTrim(r.conversation_id);
    if (!cid) continue;
    if (!bySession.has(cid)) bySession.set(cid, []);
    bySession.get(cid)!.push(r);
  }

  const sessionIds = Array.from(bySession.keys());
  if (!sessionIds.length) return { inserted: 0, scannedSessions: 0 };

  // Find which sessions already have a memory_summary row.
  // Your memory_summary has a UUID conversation_id (you mentioned this), so passing a UUID string works.
  const { data: existing, error: existErr } = await supabase
    .from("memory_summary")
    .select("conversation_id")
    .eq("user_id", userId)
    .in("conversation_id", sessionIds);

  if (existErr) {
    console.error("backfill: memory_summary existence check error", existErr);
    return { inserted: 0, scannedSessions: sessionIds.length };
  }

  const existingSet = new Set<string>();
  for (const e of (existing || []) as any[]) {
    const cid = safeTrim(e?.conversation_id);
    if (cid) existingSet.add(cid);
  }

  // Build inserts for sessions that are missing.
  const inserts: any[] = [];

  for (const cid of sessionIds) {
    if (existingSet.has(cid)) continue;

    const sess = bySession.get(cid)!;
    if (!sess.length) continue;

    const first = sess[0];
    const createdAt = first.created_at;

    // Basic “session summary” text from the first few user messages.
    const userLines = sess
      .filter((x) => (x.role || "").toLowerCase() === "user")
      .map((x) => safeTrim(x.content))
      .filter(Boolean);

    const assistantLines = sess
      .filter((x) => (x.role || "").toLowerCase() === "assistant")
      .map((x) => safeTrim(x.content))
      .filter(Boolean);

    const title =
      userLines[0]?.slice(0, 120) ||
      assistantLines[0]?.slice(0, 120) ||
      "Legacy session";

    const body = [
      userLines.slice(0, 3).map((t) => `User: ${t}`).join("\n"),
      assistantLines.slice(0, 2).map((t) => `Assistant: ${t}`).join("\n"),
    ]
      .filter((s) => s.trim().length > 0)
      .join("\n\n")
      .slice(0, 4000);

    inserts.push({
      user_id: userId,
      conversation_id: cid,        // UUID string is fine for a uuid column
      raw_id: first.id,            // ties this summary to the session’s first raw row
      short_summary: title,
      full_summary: body || title,
      observations: {
        session_key: cid,
        conversation_mode: "legacy",
        is_dev: false,
        backfilled_from_memory_raw: true,
        backfilled_at: new Date().toISOString(),
      },
      // created_at: createdAt, // OPTIONAL: only include this if your table allows writing created_at
    });
  }

  if (!inserts.length) return { inserted: 0, scannedSessions: sessionIds.length };

  // Insert in chunks (safe for large sessions)
  const CHUNK = 50;
  let inserted = 0;

  for (let i = 0; i < inserts.length; i += CHUNK) {
    const chunk = inserts.slice(i, i + CHUNK);
    const { error: insErr, data: insData } = await supabase
      .from("memory_summary")
      .insert(chunk)
      .select("id");

    if (insErr) {
      console.error("backfill: insert memory_summary error", insErr);
      // Keep going; partial is better than none.
      continue;
    }

    inserted += (insData || []).length;
  }

  return { inserted, scannedSessions: sessionIds.length };
}

/**
 * Fallback: build a basic life-themes structure without Gemini.
 */
function buildFallbackLifeThemes(
  userId: string,
  rows: MemorySummaryRow[],
): LifeThemesResult {
  const recent = rows.slice(-10);
  const bullets = recent.map((row, i) => {
    const date = new Date(row.created_at).toISOString().split("T")[0];
    const body = row.full_summary || row.short_summary || "";
    const trimmed = body.length > 200 ? body.slice(0, 197) + "..." : body;
    return `${i + 1}. [${date}] ${trimmed}`;
  });

  const master_page = [
    `This is an automatically generated overview of ${userId}'s life stories so far.`,
    "",
    "Recent sessions:",
    ...bullets,
  ].join("\n");

  return {
    summary_sentence:
      "This is an early, automatically generated overview of this person's life stories so far.",
    master_page,
    themes: [
      {
        key: "early_overview",
        title: "Early automated overview",
        description:
          "These insights are an initial pass based on the available session summaries. As more legacy conversations are recorded, this overview will become richer and more precise.",
      },
    ],
  };
}

/**
 * Try to extract a JSON payload { summary_sentence, master_page, themes[] }
 * from a Gemini text response.
 */
function tryParseLifeThemesJson(
  rawText: string,
): LifeThemesResult | null {
  if (!rawText) return null;

  // Sometimes models wrap JSON in code fences; strip them.
  let text = rawText.trim();
  if (text.startsWith("```")) {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1);
    }
  }

  try {
    const parsed = JSON.parse(text);

    if (
      typeof parsed.summary_sentence === "string" &&
      typeof parsed.master_page === "string" &&
      Array.isArray(parsed.themes)
    ) {
      const themes: LifeTheme[] = parsed.themes
        .map((t: any) => ({
          key: String(t.key ?? "").trim(),
          title: String(t.title ?? "").trim(),
          description: String(t.description ?? "").trim(),
        }))
        .filter(
          (t) =>
            t.key.length > 0 &&
            t.title.length > 0 &&
            t.description.length > 0,
        );

      if (!themes.length) return null;

      return {
        summary_sentence: parsed.summary_sentence.trim(),
        master_page: parsed.master_page.trim(),
        themes,
      };
    }
  } catch (err) {
    console.error("Failed to parse life_themes JSON from Gemini:", err);
  }

  return null;
}

/**
 * Build a warmer, structured life-themes object from many session summaries.
 * - If Gemini is not configured or fails, returns a decent fallback.
 * - The prompt explicitly tells Gemini to ignore technical/dev sessions and
 *   to avoid repetitive themes.
 */
async function buildLifeThemesFromSessions(
  userId: string,
  rows: MemorySummaryRow[],
): Promise<LifeThemesResult> {
  if (!rows.length) {
    return {
      summary_sentence: "No legacy sessions have been summarized yet.",
      master_page:
        "There are not yet any summarized legacy sessions for this person. Once more life stories are recorded, this page will show a distilled overview of their life themes.",
      themes: [
        {
          key: "no_data",
          title: "No legacy data yet",
          description:
            "As soon as this person records a few legacy storytelling sessions, we will distill the main themes of their life here.",
        },
      ],
    };
  }

  const fallback = buildFallbackLifeThemes(userId, rows);

  if (!GEMINI_API_KEY) {
    console.error(
      "rebuild-insights: GEMINI_API_KEY / GEMINI_API_KEY_EDGE not set; using fallback life_themes.",
    );
    return fallback;
  }

  const sessionLines = rows.map((r, idx) => {
    const date = new Date(r.created_at).toISOString().split("T")[0];
    const body = r.full_summary || r.short_summary || "";
    return `${idx + 1}. [${date}] ${body}`;
  });

  const prompt = [
    "You are helping to gently summarize a person's life story across many recorded sessions.",
    "",
    "You will see multiple short session summaries. Some sessions are about personal biography:",
    "- childhood, family, upbringing",
    "- relationships, friendships, marriage, kids",
    "- work, career changes, retirement",
    "- hopes, regrets, values, beliefs, turning points",
    "",
    "Other sessions are highly technical and are just the person testing or debugging an app (for example, talking about Gemini, STT, Supabase, tests, functions, deployments, etc.).",
    "",
    "Your job:",
    "1) IGNORE the technical/testing sessions except as background that this person is building a legacy app.",
    "2) FOCUS on the sessions that talk about their actual life: childhood, family, important people, places, and experiences.",
    "3) Extract 3–6 durable, cross-session insights about WHO this person is, what has shaped them, and what seems important to them.",
    "4) Each theme must be DISTINCT. Do NOT restate the same idea with slightly different wording.",
    "5) Write in warm, plain language (short paragraphs). Do NOT sound like therapy or analysis; sound like a thoughtful friend who remembers past conversations.",
    "6) Do NOT mention Supabase, debugging, tests, or implementation details unless it truly matters to their identity.",
    "",
    "Return STRICT JSON with this shape:",
    "",
    "{",
    '  "summary_sentence": "one-sentence life thesis",',
    '  "master_page": "a 300–600 word cohesive overview suitable as a single Insights page",',
    '  "themes": [',
    "    {",
    '      "key": "snake_case_identifier",',
    '      "title": "short human-readable title",',
    '      "description": "2–4 sentence description of this theme, clearly distinct from the others."',
    "    }",
    "  ]",
    "}",
    "",
    "Session summaries:",
    ...sessionLines,
  ].join("\n");

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        }),
      },
    );

    if (!resp.ok) {
      console.error("Gemini error for life_themes:", await resp.text());
      return fallback;
    }

    const json = await resp.json();
    const text =
      json.candidates?.[0]?.content?.parts
        ?.map((p: { text: string }) => p.text)
        .join("") ?? "";

    const parsed = tryParseLifeThemesJson(text);
    if (!parsed) {
      console.error(
        "Gemini returned non-parseable life_themes JSON; using fallback.",
      );
      return fallback;
    }

    return parsed;
  } catch (err) {
    console.error("Gemini request failed in rebuild-insights:", err);
    return fallback;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Only POST allowed." }, 405);
  }

  let userId: string | null = null;

  try {
    const body = await req.json();
    userId = (body.user_id as string | undefined)?.trim() || null;
  } catch {
    const url = new URL(req.url);
    userId = url.searchParams.get("user_id");
  }

  if (!userId) {
    return jsonResponse({ error: "user_id is required" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

// 0) Safety net: if ai-brain didn’t create new session summaries,
// backfill missing memory_summary rows from memory_raw grouped by conversation_id.
const backfill = await backfillSessionSummariesFromMemoryRaw(supabase, userId);
console.log(
  `rebuild-insights: backfill scanned=${backfill.scannedSessions} inserted=${backfill.inserted}`,
);

// 1) Pull all session-level summaries for this user.
const { data, error } = await supabase
  .from("memory_summary")
  .select("id, user_id, short_summary, full_summary, created_at, observations")
  .eq("user_id", userId)
  .order("created_at", { ascending: true });

  if (error) {
    console.error("rebuild-insights: memory_summary error", error);
    return jsonResponse(
      { error: "Failed to fetch memory summaries", details: error },
      500,
    );
  }

  const rows = (data || []) as MemorySummaryRow[];
  if (!rows.length) {
    return jsonResponse(
      { message: "No memory_summary rows for this user; nothing to rebuild." },
      200,
    );
  }

  // 2) Ask Gemini (or fallback) to produce structured life themes.
  const lifeThemes = await buildLifeThemesFromSessions(userId, rows);
  const sourceIds = rows.map((r) => r.id);
  const nowIso = new Date().toISOString();

  // 3) Upsert into lifetime_profile.data.life_themes (merge with existing data).
  const { data: existingLifetime, error: lifetimeSelectError } = await supabase
    .from("lifetime_profile")
    .select("user_id, data")
    .eq("user_id", userId)
    .maybeSingle();

  if (lifetimeSelectError) {
    console.error("rebuild-insights: lifetime_profile select error", lifetimeSelectError);
  }

  const existingData =
    (existingLifetime?.data as Record<string, unknown> | null) ?? {};

  const newData = {
    ...existingData,
    life_themes: {
      summary_sentence: lifeThemes.summary_sentence,
      master_page: lifeThemes.master_page,
      themes: lifeThemes.themes,
      rebuilt_at: nowIso,
      source_session_count: rows.length,
    },
  };

  const { data: upsertedLifetime, error: lifetimeUpsertError } = await supabase
    .from("lifetime_profile")
    .upsert(
      {
        user_id: userId,
        data: newData,
      },
      { onConflict: "user_id" },
    )
    .select()
    .single();

  if (lifetimeUpsertError) {
    console.error(
      "rebuild-insights: lifetime_profile upsert error",
      lifetimeUpsertError,
    );
    return jsonResponse(
      {
        error: "Failed to upsert lifetime_profile.life_themes",
        details: lifetimeUpsertError,
      },
      500,
    );
  }

  // 4) Recalibrate memory_insights:
  //    - Delete prior lifetime_overview / life_theme rows for this user
  //    - Insert one lifetime_overview row + one life_theme row per theme
  const { error: deleteError } = await supabase
    .from("memory_insights")
    .delete()
    .eq("user_id", userId)
    .in("insight_type", ["lifetime_overview", "life_theme"]);

  if (deleteError) {
    console.error("rebuild-insights: delete old insights error", deleteError);
    // Not fatal; we still continue.
  }

  const insightRows = [
    // Master overview row
    {
      user_id: userId,
      source_session_ids: sourceIds,
      insight_type: "lifetime_overview",
      short_title: "What really matters to me (master overview)",
      insight_text: lifeThemes.master_page,
      confidence: 0.9,
      tags: ["overview", "master_page"],
      metadata: {
        source: "rebuild-insights",
        rebuilt_at: nowIso,
        session_count: rows.length,
      },
    },
    // Theme-level rows
    ...lifeThemes.themes.map((t) => ({
      user_id: userId,
      source_session_ids: sourceIds,
      insight_type: "life_theme",
      short_title: t.title,
      insight_text: t.description,
      confidence: 0.85,
      tags: ["life_theme", t.key],
      metadata: {
        source: "rebuild-insights",
        rebuilt_at: nowIso,
        key: t.key,
        session_count: rows.length,
      },
    })),
  ];

  const { data: insertedInsights, error: insertError } = await supabase
    .from("memory_insights")
    .insert(insightRows)
    .select();

  if (insertError) {
    console.error("rebuild-insights: insert insights error", insertError);
    return jsonResponse(
      { error: "Failed to insert insights", details: insertError },
      500,
    );
  }

  return jsonResponse(
  {
    ok: true,
    backfill,
    life_themes: lifeThemes,
    lifetime_profile: upsertedLifetime,
    insights_inserted: insertedInsights,
  },
  200,
);
});
