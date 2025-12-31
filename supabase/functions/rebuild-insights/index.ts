// supabase/functions/rebuild-insights/index.ts
//
// Thin HTTP wrapper around the shared post-processing pipeline in ../_shared/postprocess.ts
// This function remains internal-only (x-internal-key required).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { jsonResponse, handleCors } from "../_shared/http.ts";
import { runPostProcess } from "../_shared/postprocess.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SB_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!SUPABASE_URL) {
  console.error("❌ Missing SUPABASE_URL");
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing service role key: set SB_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY");
}

function requireInternalKey(req: Request) {
  const got = req.headers.get("x-internal-key") || "";
  const expect = Deno.env.get("INTERNAL_FUNCTION_KEY") || "";
  if (!expect || got !== expect) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

Deno.serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Only POST allowed." }, 405);
  }

  // Internal-only function: require shared secret header
  const deny = requireInternalKey(req);
  if (deny) return deny;

  let userId: string | null = null;
  let conversationId: string | null = null;
  let lite: boolean = true;

  try {
    const body = await req.json();
    userId = (body.user_id as string | undefined)?.trim() || null;
    conversationId = (body.conversation_id as string | undefined)?.trim() || null;
    lite = typeof body.lite === "boolean" ? body.lite : true;
  } catch {
    const url = new URL(req.url);
    userId = url.searchParams.get("user_id");
    conversationId = url.searchParams.get("conversation_id");
    lite = url.searchParams.get("lite") === "false" ? false : true;
  }

  if (!userId) {
    return jsonResponse({ error: "user_id is required" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const result = await runPostProcess(supabase as any, {
    user_id: userId,
    conversation_id: conversationId,
    lite,
  });

  return jsonResponse(result, result.ok ? 200 : 500);
});
