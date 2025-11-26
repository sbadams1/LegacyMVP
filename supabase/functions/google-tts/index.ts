// supabase/functions/google-tts/index.ts
//
// TEMP sanity-check version:
// - Always returns HTTP 200
// - Never calls Google
// - Just echoes the text and returns a fake "audio_base64"
//
// Once this is confirmed working (no FunctionException),
// we can reintroduce real TTS logic.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed (POST only)" }, 200);
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 200);
  }

  const user_id = payload.user_id as string | undefined;
  const text = payload.text as string | undefined;

  if (!user_id) {
    return jsonResponse({ error: "user_id is required" }, 200);
  }
  if (!text || typeof text !== "string" || !text.trim()) {
    return jsonResponse({ error: "text is required" }, 200);
  }

  // This would NOT be a real MP3; it's just the base64 for the ASCII word "test".
  const fakeAudioBase64 = "dGVzdA==";

  return jsonResponse(
    {
      ok: true,
      echo_text: text,
      audio_base64: fakeAudioBase64,
    },
    200,
  );
});
