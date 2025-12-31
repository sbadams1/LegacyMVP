// supabase/functions/_shared/http.ts
// Shared HTTP helpers for Supabase Edge Functions (Deno).

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

/** Handles preflight OPTIONS requests. Return Response if handled, else null. */
export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders, status: 200 });
  }
  return null;
}
