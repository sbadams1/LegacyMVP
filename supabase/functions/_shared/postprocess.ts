import { createClient } from "npm:@supabase/supabase-js@2";

type Phase3Mode = "incremental" | "full";

type Phase3Options = {
  user_id: string;
  phase3_mode?: Phase3Mode;
  since?: string;
  limit?: number;
};

type Phase3SessionCapsule = {
  summary_id: string;
  user_id: string;
  created_at: string;
  updated_at: string;

  short_summary: string;
  full_summary: string | null;

  reflections: unknown;
  insights: unknown;
  patterns: unknown;
  rare_insights: unknown;

  chapter_keys: unknown;
  themes: unknown;

  eligibility: any;

  summary_quality: string;
  voice_pov: string;

  phase: number;
  finalized: boolean;
};

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter(x => typeof x === "string") as string[] : [];

type PostProcessResult =
  | ({ ok: true } & {
      processed: number;
      message?: string;
      insights_written?: number;
      phase3_mode?: Phase3Mode;
      since?: string;
    })
  | ({ ok: false } & {
      error: string;
      details?: string;
      processed?: number;
      message?: string;
    });

function coerceString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const anyV = v as any;
    if (typeof anyV.url === "string") return anyV.url;
    if (typeof anyV.supabaseUrl === "string") return anyV.supabaseUrl;
  }
  return "";
}

function normalizeSupabaseUrl(raw: unknown): string {
  // Accept plain string, object with {url}, or JSON-string like {"url":"https://..."}
  let s = String(coerceString(raw) || raw || "").trim();

  if (s.startsWith("{") && s.endsWith("}")) {
    try {
      const parsed = JSON.parse(s);
      const extracted = coerceString(parsed);
      if (extracted) s = extracted.trim();
    } catch {
      // ignore
    }
  }
  return s;
}

function normalizeKey(raw: unknown): string {
  return String(raw ?? "").trim();
}

export async function runPostProcess(
  supabaseUrlRaw: unknown,
  serviceRoleKeyRaw: unknown,
  opts: Phase3Options
): Promise<PostProcessResult> {
  try {
    const supabaseUrl = normalizeSupabaseUrl(supabaseUrlRaw) || normalizeSupabaseUrl(Deno.env.get("SUPABASE_URL"));
    const serviceRoleKey = normalizeKey(serviceRoleKeyRaw) || normalizeKey(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

    if (!supabaseUrl) {
      return { ok: false, error: "config_missing", details: "SUPABASE_URL is missing or invalid" };
    }
    if (!serviceRoleKey) {
      return { ok: false, error: "config_missing", details: "SUPABASE_SERVICE_ROLE_KEY is missing" };
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const {
      user_id,
      phase3_mode = "incremental",
      since,
      limit = 200,
    } = opts;

    if (!user_id) {
      return { ok: false, error: "bad_arguments", details: "runPostProcess: user_id is required" };
    }

  // Determine time window
  // -----------------------------
  let effectiveSince = since ?? null;

  if (phase3_mode === "incremental" && !since) {
    const { data: state } = await supabase
      .from("pipeline_state")
      .select("value")
      .eq("user_id", user_id)
      .eq("key", "phase3_memory_insights")
      .maybeSingle();

    effectiveSince = state?.value?.last_run_at ?? null;
  }

  // -----------------------------
  // Fetch Phase 3 capsules
  // -----------------------------
  let query = supabase
    .from("phase3_session_capsules_narrative")
    .select("*")
    .eq("user_id", user_id)
    .order("created_at", { ascending: true });

  if (phase3_mode === "incremental" && effectiveSince) {
    query = query.gte("created_at", effectiveSince);
  }

  if (limit) {
    query = query.limit(limit);
  }

  const { data: capsules, error } = await query;

  if (error) {
    throw error;
  }

  if (!capsules || capsules.length === 0) {
    return {
      processed: 0,
      message: "No Phase 3 capsules to process",
    };
  }

  // -----------------------------
  // Aggregate longitudinal insights
  // -----------------------------
  const longitudinalInsights: string[] = [];
  const seen = new Set<string>();

  for (const c of capsules as Phase3SessionCapsule[]) {
    if (!c.finalized || c.phase !== 2) continue;
    if (!c.eligibility?.insightsEligible) continue;

    for (const insight of asStringArray(c.insights)) {
      const key = insight.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        longitudinalInsights.push(insight);
      }
    }
  }

  if (longitudinalInsights.length === 0) {
    return {
      ok: true,
      processed: capsules.length,
      message: "No new longitudinal insights found",
    };
  }

  // -----------------------------
  // Write to memory_insights
  // -----------------------------
  const now = new Date().toISOString();

  const { error: upsertError } = await supabase
    .from("memory_insights")
    .upsert(
      longitudinalInsights.map(text => ({
        user_id,
        insight_text: text,
        source: "phase3",
        updated_at: now,
      })),
      { onConflict: "user_id,insight_text" }
    );

  if (upsertError) {
    throw upsertError;
  }

  // -----------------------------
  // Update pipeline state
  // -----------------------------
  await supabase
    .from("pipeline_state")
    .upsert(
      {
        user_id,
        key: "phase3_memory_insights",
        value: { last_run_at: now },
        updated_at: now,
      },
      { onConflict: "user_id,key" }
    );

  return {
    ok: true,
    processed: capsules.length,
    insights_written: longitudinalInsights.length,
    phase3_mode,
    since: effectiveSince,
  };
  } catch (err) {
    return {
      ok: false,
      error: "postprocess_failed",
      details: err instanceof Error ? err.message : String(err),
    };
  }
}
