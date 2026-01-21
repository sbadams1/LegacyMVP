// supabase/functions/ai-brain/pipelines/themes/theme_pipeline.ts
// Best-effort cache of emergent themes per summary + durable clustering.
// This module must NEVER throw in a way that breaks end-session.

import type { EmergentTheme } from "../../types/themes.ts";

type SupabaseClientLike = {
  from: (table: string) => any;
};

function normalize(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^ -~\p{L}\p{N}\s]/gu, " ")
    .replace(/[^ -~\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccard(a: string, b: string): number {
  const A = new Set(normalize(a).split(" ").filter(Boolean));
  const B = new Set(normalize(b).split(" ").filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function themeSimilarity(a: string, b: string): number {
  const jac = jaccard(a, b);
  const na = normalize(a);
  const nb = normalize(b);
  const prefixBonus = (na.startsWith(nb) || nb.startsWith(na)) ? 0.15 : 0;
  return Math.min(1, jac + prefixBonus);
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input ?? "");
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function upsertSummaryThemesAndClusters(args: {
  client: SupabaseClientLike;
  user_id: string;
  summary_id: string;
  short_summary: string;
  full_summary?: string | null;
  extractor_version?: string; // default v1
  max_themes?: number;        // default 5
  similarity_threshold?: number; // default 0.55
  extract: (args: { short_summary: string; full_summary?: string | null; max_themes?: number }) => Promise<{ themes: EmergentTheme[] }>;
}): Promise<void> {
  const client = args.client;
  const user_id = args.user_id;
  const summary_id = args.summary_id;
  const extractor_version = args.extractor_version ?? "v1";
  const max_themes = Math.max(0, Math.min(8, Number(args.max_themes ?? 5) || 5));
  const threshold = Math.max(0.35, Math.min(0.9, Number(args.similarity_threshold ?? 0.55) || 0.55));

  const short = String(args.short_summary ?? "").trim();
  const full = args.full_summary == null ? "" : String(args.full_summary).trim();
  if (!user_id || !summary_id || !short) return;

  const fingerprint = await sha256Hex(short + "\n---\n" + full);

  // 1) Check existing summary_themes (fingerprint + extractor_version)
  const { data: existing, error: readErr } = await client
    .from("summary_themes")
    .select("id, summary_fingerprint")
    .eq("user_id", user_id)
    .eq("summary_id", summary_id)
    .eq("extractor_version", extractor_version)
    .maybeSingle();

  if (readErr) throw readErr;

  const needsRebuild = !existing || existing.summary_fingerprint !== fingerprint;

  if (!needsRebuild && existing?.id) {
    // Already cached and valid.
    return;
  }

  // 2) Extract themes (LLM)
  const extracted = await args.extract({ short_summary: short, full_summary: full, max_themes });
  const themes = Array.isArray(extracted?.themes) ? extracted.themes.slice(0, max_themes) : [];

  // 3) Upsert summary_themes row
  let summaryThemeId: string | null = existing?.id ?? null;

  if (summaryThemeId) {
    // Invalidate old cluster members for this summary_theme_id
    const { error: delErr } = await client
      .from("cluster_members")
      .delete()
      .eq("user_id", user_id)
      .eq("summary_theme_id", summaryThemeId);
    if (delErr) throw delErr;

    const { error: updErr } = await client
      .from("summary_themes")
      .update({
        summary_fingerprint: fingerprint,
        themes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", summaryThemeId);
    if (updErr) throw updErr;
  } else {
    const { data: ins, error: insErr } = await client
      .from("summary_themes")
      .insert({
        user_id,
        summary_id,
        summary_fingerprint: fingerprint,
        extractor_version,
        themes,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .maybeSingle();
    if (insErr) throw insErr;
    summaryThemeId = ins?.id ?? null;
  }

  if (!summaryThemeId) return;

  if (themes.length === 0) return;

  // 4) Load recent clusters (keep it light; we can expand later)
  const { data: clusters, error: clErr } = await client
    .from("theme_clusters")
    .select("id, cluster_label, strength, occurrence_count, first_seen_at, last_seen_at, domains")
    .eq("user_id", user_id)
    .order("strength", { ascending: false })
    .limit(200);

  if (clErr) throw clErr;
  const existingClusters = Array.isArray(clusters) ? clusters : [];

  // Helper to update cluster stats
  async function bumpCluster(cluster_id: string, addWeight: number, addDomains: string[], seenAtIso: string) {
    // Read current (avoid race: best-effort; small app scale)
    const current = existingClusters.find((c: any) => c.id === cluster_id);
    const occurrence_count = Number(current?.occurrence_count ?? 0) + 1;
    const strength = Number(current?.strength ?? 0) + addWeight;
    const first_seen_at = current?.first_seen_at ?? seenAtIso;
    const last_seen_at = seenAtIso;

    const mergedDomains = Array.from(new Set([...(current?.domains ?? []), ...addDomains])).slice(0, 8);

    const { error: updErr } = await client
      .from("theme_clusters")
      .update({
        occurrence_count,
        strength,
        first_seen_at,
        last_seen_at,
        domains: mergedDomains,
        updated_at: new Date().toISOString(),
      })
      .eq("id", cluster_id);

    if (updErr) throw updErr;

    // Update local cache so subsequent bumps in this run are consistent
    (current as any).occurrence_count = occurrence_count;
    (current as any).strength = strength;
    (current as any).first_seen_at = first_seen_at;
    (current as any).last_seen_at = last_seen_at;
    (current as any).domains = mergedDomains;
  }

  // 5) Assign each theme to a cluster + write membership rows
  for (let i = 0; i < themes.length; i++) {
    const t = themes[i];
    const label = String(t?.label ?? "").trim();
    if (!label) continue;

    const weight = Math.max(0, Math.min(1, Number((t as any).weight ?? 0.6) || 0.6));
    const receipts = Array.isArray((t as any).receipts) ? (t as any).receipts.slice(0, 3) : [];
    const domains = Array.isArray((t as any).domains) ? (t as any).domains.slice(0, 5) : [];

    // Find best matching cluster by label
    let best: any = null;
    let bestScore = 0;

    for (const c of existingClusters) {
      const score = themeSimilarity(label, String(c.cluster_label ?? ""));
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    const nowIso = new Date().toISOString();

    let clusterId: string | null = null;
    if (best && bestScore >= threshold) {
      clusterId = best.id;
    } else {
      // Create new cluster
      const { data: created, error: cErr } = await client
        .from("theme_clusters")
        .insert({
          user_id,
          cluster_label: label,
          domains,
          strength: weight,
          occurrence_count: 1,
          first_seen_at: nowIso,
          last_seen_at: nowIso,
          cluster_version: "v1",
          created_at: nowIso,
          updated_at: nowIso,
        })
        .select("id, cluster_label, strength, occurrence_count, first_seen_at, last_seen_at, domains")
        .maybeSingle();
      if (cErr) throw cErr;
      clusterId = created?.id ?? null;
      if (clusterId) existingClusters.unshift(created);
    }

    if (!clusterId) continue;

    // Write membership row
    const { error: memErr } = await client
      .from("cluster_members")
      .insert({
        user_id,
        cluster_id: clusterId,
        summary_theme_id: summaryThemeId,
        theme_index: i,
        theme_label: label,
        weight,
        receipts,
        created_at: nowIso,
      });
    if (memErr) throw memErr;

    // If matched existing cluster, bump stats
    if (best && best.id === clusterId) {
      await bumpCluster(clusterId, weight, domains, nowIso);
    }
  }
}
