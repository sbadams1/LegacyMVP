// supabase/functions/google-tts/index.ts
//
// Simple Text-to-Speech proxy for the Legacy app.
//
// Usage (from Flutter):
//   supabase.functions.invoke('google-tts', body: {
//     text: 'Hello from the Legacy app',
//     primary_language: 'en-US',      // ✅ NEW preferred field
//     voice_id: 'en-US-Neural2-A',    // optional, we set a nice default below
//     gender: 'NEUTRAL',              // optional
//     speakingRate: 1.0               // optional
//   });
//
// Response:
//   { audioContent: string }  // base64-encoded MP3
//   or { error, details, googleError }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type TtsBody = {
  text?: string;
  primary_language?: string;
  languageCode?: string; // kept for backward compatibility
  voice_id?: string;
  voiceName?: string; // backward compatibility
  gender?: "MALE" | "FEMALE" | "NEUTRAL";
  speakingRate?: number;
};

function defaultVoiceFor(languageCode: string): string {
  switch (languageCode) {
    case "th-TH":
      return "th-TH-Standard-A";
    case "es-ES":
      return "es-ES-Neural2-A";
    case "es-MX":
      return "es-MX-Neural2-A";
    case "fr-FR":
      return "fr-FR-Neural2-A";
    case "pt-BR":
      return "pt-BR-Neural2-A";
    case "en-GB":
      return "en-GB-Neural2-A";
    case "en-US":
    default:
      return "en-US-Neural2-A";
  }
}

serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const body = (await req.json()) as TtsBody;

    const text = body.text?.trim();
    if (!text) {
      return jsonResponse({ error: "text is required" }, 200);
    }

    // Prefer dedicated TTS key, fall back to speech key if you want
    const apiKey =
      Deno.env.get("GOOGLE_TTS_API_KEY") ??
      Deno.env.get("GOOGLE_SPEECH_API_KEY");

    if (!apiKey) {
      return jsonResponse(
        { error: "GOOGLE_TTS_API_KEY (or GOOGLE_SPEECH_API_KEY) is not set" },
        200,
      );
    }

    // ✅ Prefer primary_language, but accept legacy languageCode
    const languageCode =
      body.primary_language?.trim() ||
      body.languageCode?.trim() ||
      "en-US";

    const gender = body.gender || "MALE";

    // ✅ Prefer voice_id, then legacy voiceName, then a per-language default
    const voiceName =
      body.voice_id?.trim() ||
      body.voiceName?.trim() ||
      defaultVoiceFor(languageCode);

    const ttsReq = {
      input: { text },
      voice: {
        languageCode,
        name: voiceName,
        ssmlGender: gender,
      },
      audioConfig: {
        audioEncoding: "MP3",
        // You can tweak this slightly (e.g. 0.95) if you want a bit slower speech
        speakingRate: body.speakingRate ?? 1.0,
      },
    };

    const ttsRes = await fetch(
      "https://texttospeech.googleapis.com/v1/text:synthesize?key=" + apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ttsReq),
      },
    );

    const textRes = await ttsRes.text();
    let json: any;
    try {
      json = JSON.parse(textRes);
    } catch {
      json = textRes;
    }

    if (!ttsRes.ok) {
      console.error("Google TTS error:", ttsRes.status, textRes);
      return jsonResponse(
        {
          error: "Google TTS error",
          details: `HTTP ${ttsRes.status}`,
          googleError: json,
        },
        200,
      );
    }

    const audioContent = (json as any).audioContent;
    if (!audioContent) {
      return jsonResponse(
        { error: "No audioContent in TTS response", googleError: json },
        200,
      );
    }

    return jsonResponse({ audioContent }, 200);
  } catch (err) {
    console.error("google-tts function error:", err);
    return jsonResponse(
      { error: "Server error", details: String(err) },
      200,
    );
  }
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
