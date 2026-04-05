// supabase/functions/end-session-worker/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// IMPORTANT: relative path from end-session-worker/ to ai-brain/pipelines/
import { runEndSessionPhaseBFromJob } from "../ai-brain/pipelines/end_session.ts";

type JobRow = {
  id: string;
  user_id: string;
  conversation_id: string;
  status: string;
  attempt_count: number;
  payload: Record<string, any>;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

 serve(async (req) => {
   // Accept POST, but don’t require body.
   if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
 
  let requestedJobId: string | null = null;
  try {
    const body = await req.json().catch(() => null);
    requestedJobId = body?.job_id ? String(body.job_id).trim() : null;
  } catch {
    requestedJobId = null;
  }

   const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
   const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
   const client = createClient(supabaseUrl, serviceKey);
 
   // 1) Fetch one queued job
  let jobsQuery = client
    .from("end_session_jobs")
    .select("*")
    .eq("status", "queued");

  if (requestedJobId) jobsQuery = jobsQuery.eq("id", requestedJobId);

  const { data: jobs, error: qErr } = await jobsQuery
    .order("created_at", { ascending: true })
    .limit(1);
 
   if (qErr) return json({ ok: false, error: qErr.message }, 500);
  if (!jobs || jobs.length === 0) {
    return json({ ok: true, ran: 0, requested_job_id: requestedJobId });
  }
 
   const job = jobs[0] as JobRow;
 
   // 2) Claim (optimistic lock)
  const { data: claimed, error: claimErr } = await client
     .from("end_session_jobs")
     .update({
       status: "running",
       started_at: new Date().toISOString(),
       attempt_count: (job.attempt_count ?? 0) + 1,
       last_error: null,
     })
     .eq("id", job.id)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();
 
  if (claimErr) return json({ ok: true, ran: 0, note: "lost race claiming job", error: claimErr.message });
  if (!claimed?.id) return json({ ok: true, ran: 0, note: "lost race claiming job" });
 
   // 3) Run Phase B
   try {
     await runEndSessionPhaseBFromJob({
      client,
      job_id: job.id,
      user_id: job.user_id,
      conversation_id: job.conversation_id,
      payload: job.payload ?? {},
    });

    // 4) Mark done
    const { error: doneErr } = await client
      .from("end_session_jobs")
      .update({ status: "done", finished_at: new Date().toISOString() })
      .eq("id", job.id);

    if (doneErr) throw new Error(doneErr.message);

    return json({ ok: true, ran: 1, job_id: job.id, status: "done" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);

    await client
      .from("end_session_jobs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        last_error: msg,
      })
      .eq("id", job.id);

    return json({ ok: false, ran: 1, job_id: job.id, status: "failed", error: msg }, 500);
  }
});
