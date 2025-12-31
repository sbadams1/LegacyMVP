// supabase/functions/_shared/insightsLifecycle.ts
import type { SupabaseClient } from "npm:@supabase/supabase-js";

export type InsightStatus = "emerging" | "active" | "cooling" | "archived";

export type MemoryInsight = {
  id: string;
  user_id: string;
  insight_key: string;
  insight_text: string | null;
  status: InsightStatus;
  confidence_score: number | null;
  supporting_sessions: number | null;
  last_reinforced_at: string | null;
  last_presented_at: string | null;
  contradiction_count: number | null;
  evidence_raw_ids: unknown;        // jsonb
  originating_seed_keys: unknown;   // jsonb
  context_domains: unknown;         // jsonb
};

export async function applyInsightDecayRPC(
  supabase: SupabaseClient,
  user_id: string,
  nowISO?: string,
) {
  const { data, error } = await supabase.rpc("apply_insight_decay", {
    p_user_id: user_id,
    p_now: nowISO ?? new Date().toISOString(),
  });

  if (error) throw new Error(`apply_insight_decay RPC failed: ${error.message}`);
  return data;
}

/**
 * Select a single "Insight Moment" candidate:
 * - must be active
 * - must not have been presented recently
 * - must have decent confidence
 */
export async function pickInsightMomentCandidate(
  supabase: SupabaseClient,
  user_id: string,
  opts?: { minConfidence?: number; coolDownDays?: number },
) {
  const minConfidence = opts?.minConfidence ?? 0.65;
  const coolDownDays = opts?.coolDownDays ?? 21;

  // Pull a small set and choose deterministically in code.
  const { data, error } = await supabase
    .from("memory_insights")
    .select("id,user_id,insight_key,insight_text,status,confidence_score,supporting_sessions,last_reinforced_at,last_presented_at,contradiction_count,evidence_raw_ids,originating_seed_keys,context_domains")
    .eq("user_id", user_id)
    .eq("status", "active")
    .gte("confidence_score", minConfidence)
    .order("last_reinforced_at", { ascending: false })
    .limit(20);

  if (error) throw new Error(`pickInsightMomentCandidate query failed: ${error.message}`);
  if (!data || data.length === 0) return null;

  const now = Date.now();
  const msCooldown = coolDownDays * 24 * 60 * 60 * 1000;

  const eligible = data.filter((row: any) => {
    if (!row.insight_text) return false;
    if (!row.last_presented_at) return true;
    const last = Date.parse(row.last_presented_at);
    return isFinite(last) && (now - last) > msCooldown;
  });

  if (eligible.length === 0) return null;

  // Prefer higher confidence, then more supporting_sessions, then newer reinforcement.
  eligible.sort((a: any, b: any) => {
    const c = (b.confidence_score ?? 0) - (a.confidence_score ?? 0);
    if (c !== 0) return c;
    const s = (b.supporting_sessions ?? 0) - (a.supporting_sessions ?? 0);
    if (s !== 0) return s;
    return Date.parse(b.last_reinforced_at ?? 0) - Date.parse(a.last_reinforced_at ?? 0);
  });

  return eligible[0] as MemoryInsight;
}

export async function markInsightPresented(
  supabase: SupabaseClient,
  insight_id: string,
) {
  const { error } = await supabase
    .from("memory_insights")
    .update({ last_presented_at: new Date().toISOString() })
    .eq("id", insight_id);

  if (error) throw new Error(`markInsightPresented failed: ${error.message}`);
}
