/// <reference types="https://deno.land/x/supabase_functions@1.0.0/mod.ts" />

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Payload = {
  user_id?: string;
  edited_raw_ids?: string[];
  reason?: string;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return json(500, { error: "Missing required environment variables" });
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json(401, { error: "Missing Authorization bearer token" });
    }

    // Use user-scoped client to validate identity
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: authData, error: authErr } = await userClient.auth.getUser();
    if (authErr || !authData?.user?.id) {
      return json(401, { error: "Invalid auth token" });
    }
    const authedUserId = authData.user.id;

    let payload: Payload = {};
    try {
      payload = (await req.json()) as Payload;
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    // Trust auth token; require body user_id to match (or omit body user_id and use token id)
    const userId = (payload.user_id ?? "").trim() || authedUserId;
    if (userId !== authedUserId) {
      return json(403, { error: "user_id does not match authenticated user" });
    }

    const editedRawIds = (payload.edited_raw_ids ?? [])
      .map((x) => String(x ?? "").trim())
      .filter((x) => x.length > 0);

    if (!editedRawIds.length) {
      return json(200, { ok: true, touched_seed_count: 0, message: "No edited_raw_ids" });
    }

    const reason = (payload.reason ?? "transcript_edit").trim() || "transcript_edit";
    const nowIso = new Date().toISOString();

    // Use service role for overlap queries + updates (reliable even with RLS)
    const admin = createClient(supabaseUrl, serviceRoleKey);

    // 1) Find impacted seeds via evidence_raw_ids overlap
    const seedIds = new Set<string>();

    const { data: seeds1, error: e1 } = await admin
      .from("story_seeds")
      .select("id")
      .eq("user_id", userId)
      .overlaps("evidence_raw_ids", editedRawIds)
      .limit(500);

    if (e1) {
      console.warn("mark-story-seeds-stale: evidence_raw_ids overlap failed:", e1);
    } else {
      for (const s of seeds1 ?? []) {
        const id = String((s as any)?.id ?? "").trim();
        if (id) seedIds.add(id);
      }
    }

    // 2) Also try source_raw_ids overlap (in case you use it instead of evidence_raw_ids)
    const { data: seeds2, error: e2 } = await admin
      .from("story_seeds")
      .select("id")
      .eq("user_id", userId)
      .overlaps("source_raw_ids", editedRawIds)
      .limit(500);

    if (e2) {
      console.warn("mark-story-seeds-stale: source_raw_ids overlap failed:", e2);
    } else {
      for (const s of seeds2 ?? []) {
        const id = String((s as any)?.id ?? "").trim();
        if (id) seedIds.add(id);
      }
    }

    const ids = Array.from(seedIds);
    if (!ids.length) {
      return json(200, { ok: true, touched_seed_count: 0, message: "No impacted seeds found" });
    }

    // 3) Mark seeds stale (non-breaking: uses existing columns)
    // We store a rebuild signal in seed_label and touch last_seen_at.
    const { error: upErr } = await admin
      .from("story_seeds")
      .update({
        seed_label: `stale_${reason}`,
        last_seen_at: nowIso,
      })
      .in("id", ids);

    if (upErr) {
      console.warn("mark-story-seeds-stale: story_seeds update failed:", upErr);
      return json(500, { error: "Failed to update story_seeds", details: upErr.message });
    }

    // 4) Touch recall rows too (helps your retrieval layer notice change)
    const { error: rErr } = await admin
      .from("story_recall")
      .update({ updated_at: nowIso })
      .eq("user_id", userId)
      .in("story_seed_id", ids);

    if (rErr) {
      // Non-fatal: seeds are still marked stale
      console.warn("mark-story-seeds-stale: story_recall update failed (non-fatal):", rErr);
    }

    return json(200, {
      ok: true,
      touched_seed_count: ids.length,
      touched_seed_ids: ids.slice(0, 50),
    });
  } catch (e) {
    return json(500, { error: "Unhandled error", message: (e as any)?.message ?? String(e) });
  }
});
