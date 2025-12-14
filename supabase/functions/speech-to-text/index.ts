// supabase/functions/speech-to-text/index.ts
//
// Accepts EITHER:
//   - audio_base64 + mime_type   (for mic audio – AAC pretending to be MP3)
//   - gcs_object_name + bucket   (for video or large media in GCS)
//
// BEHAVIOR:
//   • Inline audio (audio_base64):
//       - App records AAC (Codec.aacADTS) but sends mime_type "audio/mp3".
//       - We call Google STT with encoding = "MP3" (the MP3 lie).
//   • GCS media (gcs_object_name):
//       - We build a GCS URI:  gs://<bucket>/<gcs_object_name>
//       - We DO NOT set encoding; Google infers it from the file.
//
// NEW IN THIS VERSION:
//   - Supports multi-language auto-detection for L1/L2:
//       • Client can send:
//           language_code: primary language bias (e.g. L1 or L2)
//           alt_language_codes: string[] of additional languages (e.g. [L2, L1])
//       • We pass these as languageCode + alternativeLanguageCodes to STT v1.
//
// REQUIREMENTS:
//   - Set GOOGLE_SPEECH_API_KEY in your Supabase project env vars.
//   - Turn verify_jwt OFF for this function if you don't need auth checking.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GOOGLE_SPEECH_API_KEY = Deno.env.get("GOOGLE_SPEECH_API_KEY");

if (!GOOGLE_SPEECH_API_KEY) {
  console.error("⚠️ Missing GOOGLE_SPEECH_API_KEY env var");
}

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const user_id = payload.user_id as string | undefined;
  const audio_base64 = payload.audio_base64 as string | undefined;
  const mime_type = payload.mime_type as string | undefined;
  const gcs_object_name = payload.gcs_object_name as string | undefined;
  const bucket = payload.bucket as string | undefined;

  // Primary language bias (L1 or L2) – should be sent by the client.
  const language_code = payload.language_code as string | undefined;

  // NEW: additional languages (e.g., the "other side" of L1/L2) for auto-detection.
  const alt_language_codes_raw = payload.alt_language_codes;

  const altLanguageCodes: string[] = Array.isArray(alt_language_codes_raw)
    ? alt_language_codes_raw
        .map((x) => (typeof x === "string" ? x.trim() : ""))
        .filter((x) => x.length > 0)
    : [];

  if (!user_id) {
    return jsonResponse({ error: "user_id is required" }, 400);
  }

  if (!GOOGLE_SPEECH_API_KEY) {
    return jsonResponse(
      { error: "Server is missing GOOGLE_SPEECH_API_KEY" },
      500,
    );
  }

  // We stay language-agnostic: use whatever the client sends.
  // If nothing is provided, fall back to "en-US" as a safe default
  // (Google requires a primary languageCode).
  const languageCode =
    typeof language_code === "string" && language_code.trim().length > 0
      ? language_code.trim()
      : "en-US";

  let audio: Record<string, unknown>;
  let config: Record<string, unknown>;

  if (gcs_object_name) {
    // ---------- VIDEO / LARGE MEDIA PATH (GCS URI) ----------
    const bucketName = bucket || "legacy-user-media";
    const uri = `gs://${bucketName}/${gcs_object_name}`;

    console.log(
      "🎬 STT via GCS URI",
      uri,
      "mime_type=",
      mime_type,
      "user=",
      user_id,
      "languageCode=",
      languageCode,
      "altLanguageCodes=",
      altLanguageCodes,
    );

    audio = { uri };

    // Let Google infer encoding from the file (MP4, MOV, etc).
    config = {
      languageCode,
      // Multi-language auto-detection: include any alt codes the client sent.
      ...(altLanguageCodes.length > 0 && {
        alternativeLanguageCodes: altLanguageCodes,
      }),
      enableAutomaticPunctuation: true,
    };
  } else if (audio_base64) {
    // ---------- INLINE AUDIO PATH (MP3 LIE) ----------
    console.log(
      "🎙️ STT inline audio length=" +
        audio_base64.length +
        " mime_type=" +
        mime_type +
        " user=" +
        user_id +
        " languageCode=" +
        languageCode +
        " altLanguageCodes=" +
        JSON.stringify(altLanguageCodes),
    );

    audio = { content: audio_base64 };

    // THE MP3 LIE: we always say MP3 so AAC wrapped from FlutterSound is accepted.
    config = {
      languageCode,
      ...(altLanguageCodes.length > 0 && {
        alternativeLanguageCodes: altLanguageCodes,
      }),
      enableAutomaticPunctuation: true,
      encoding: "MP3",
    };
  } else {
    return jsonResponse(
      { error: "audio_base64 or gcs_object_name is required" },
      400,
    );
  }

  const requestBody = {
    config,
    audio,
  };

  try {
    const url =
      "https://speech.googleapis.com/v1/speech:recognize?key=" +
      GOOGLE_SPEECH_API_KEY;

    const googleRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const bodyText = await googleRes.text();

    if (!googleRes.ok) {
      console.error("❌ Google STT error", googleRes.status, bodyText);

      const shortBody =
        bodyText.length > 400 ? bodyText.slice(0, 400) : bodyText;

      const errMsg =
        "Google STT error (status " + googleRes.status + "): " + shortBody;

      // Return 200 so Flutter can still parse and show a friendly message
      return jsonResponse(
        {
          error: errMsg,
          google_status: googleRes.status,
          google_body: bodyText,
        },
        200,
      );
    }

    let googleJson: any;
    try {
      googleJson = JSON.parse(bodyText);
    } catch {
      console.error("❌ Failed to parse Google STT JSON:", bodyText);
      return jsonResponse(
        {
          error: "Invalid JSON from Google STT",
          google_status: googleRes.status,
          google_body: bodyText,
        },
        200,
      );
    }

    const results = Array.isArray(googleJson.results)
      ? googleJson.results
      : [];

    const transcript = results
      .map((r: any) => {
        if (!r || !r.alternatives || !r.alternatives[0]) return "";
        return r.alternatives[0].transcript || "";
      })
      .join(" ")
      .trim();

    if (!transcript) {
      console.warn("⚠️ No transcript returned from Google STT", googleJson);
      return jsonResponse(
        {
          error: "No transcript from Google STT",
          google_raw: googleJson,
        },
        200,
      );
    }

    // Try to surface the language that Google actually decided on
    // (useful when we gave it multiple options).
    let detectedLanguageCode: string | undefined;
    try {
      const firstAlt = results[0]?.alternatives?.[0];
      if (firstAlt && typeof firstAlt.languageCode === "string") {
        detectedLanguageCode = firstAlt.languageCode;
      }
    } catch {
      // If anything goes wrong here, just ignore and fall back below.
    }

    if (!detectedLanguageCode) {
      detectedLanguageCode = languageCode;
    }

    console.log(
      "✅ STT success for user " +
        user_id +
        " transcript length=" +
        transcript.length +
        " detectedLanguageCode=" +
        detectedLanguageCode,
    );

    return jsonResponse({
      transcript,
      detected_language_code: detectedLanguageCode,
    });
  } catch (err) {
    console.error("❌ STT function exception", err);
    return jsonResponse(
      { error: "Internal STT error", details: String(err) },
      500,
    );
  }
});
