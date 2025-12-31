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

/**
 * Google STT v1 expects BCP-47 language tags (ex: "en-US", "th-TH").
 * Your app/settings may store shorter tags ("en", "th") or underscore forms ("en_US").
 * This normalizes common cases while staying language-agnostic.
 */
function normalizeSttLang(input: unknown, fallback = "en-US"): string {
  const raw = String(input ?? "").trim();
  if (!raw) return fallback;

  // common formatting fixes: en_US -> en-US
  const s = raw.replace(/_/g, "-");

  // map common short codes used by apps/settings
  const lower = s.toLowerCase();
  if (lower === "en") return "en-US";
  if (lower === "th") return "th-TH";

  return s;
}

function normalizeAltLangs(list: unknown): string[] {
  const arr = Array.isArray(list) ? list : [];
  const out: string[] = [];

  for (const x of arr) {
    const norm = normalizeSttLang(x, "");
    if (!norm) continue;
    out.push(norm);
  }

  // de-dupe while preserving order
  return Array.from(new Set(out));
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

  // Additional languages (for auto-detection).
  const alt_language_codes_raw = payload.alt_language_codes;

  if (!user_id) {
    return jsonResponse({ error: "user_id is required" }, 400);
  }

  if (!GOOGLE_SPEECH_API_KEY) {
    return jsonResponse({ error: "Server is missing GOOGLE_SPEECH_API_KEY" }, 500);
  }

  // Language-agnostic:
  // 1) prefer explicit language_code
  // 2) else fall back to device_locale (client-provided)
  // 3) else last-resort "en-US" because Google STT requires *some* primary languageCode
  const device_locale = payload.device_locale as string | undefined;

  const fallbackLocale = normalizeSttLang(device_locale, "en-US");
  const languageCode = normalizeSttLang(language_code, fallbackLocale);

  // Additional languages (for auto-detection) – e.g. when the user may speak in
  // either L1 or L2 without toggling. If client doesn't send any, we keep it
  // single-language.
  let altLanguageCodes: string[] = normalizeAltLangs(alt_language_codes_raw);

  // Remove duplicates and the primary language code if it slipped in.
  altLanguageCodes = Array.from(
    new Set(
      altLanguageCodes
        .map((s) => String(s || "").trim())
        .filter((s) => s.length > 0 && s !== languageCode),
    ),
  );

  // Keep Google STT configs sane; too many alts can reduce accuracy and cost.
  if (altLanguageCodes.length > 3) altLanguageCodes = altLanguageCodes.slice(0, 3);

  console.log(
    "🧩 STT languageCode=",
    languageCode,
    "altLanguageCodes=",
    altLanguageCodes,
    "mime_type=",
    mime_type,
    "user=",
    user_id,
  );

  let audio: Record<string, unknown>;
  let config: Record<string, unknown>;

  if (gcs_object_name) {
    // ---------- VIDEO / LARGE MEDIA PATH (GCS URI) ----------
    const bucketName = bucket || "legacy-user-media";
    const uri = `gs://${bucketName}/${gcs_object_name}`;

    audio = { uri };

    // Let Google infer encoding from the file (MP4, MOV, etc).
    config = {
      languageCode,
      model: "latest_short",
      // When provided, STT will attempt to auto-detect among these options.
      ...(altLanguageCodes.length > 0 ? { alternativeLanguageCodes: altLanguageCodes } : {}),
      enableAutomaticPunctuation: true,
    };

  } else if (audio_base64) {
    // ---------- INLINE AUDIO PATH (MP3 LIE) ----------
    audio = { content: audio_base64 };

    // THE MP3 LIE: we always say MP3 so AAC wrapped from FlutterSound is accepted.
    config = {
      languageCode,
      model: "latest_short",
      ...(altLanguageCodes.length > 0 ? { alternativeLanguageCodes: altLanguageCodes } : {}),
      enableAutomaticPunctuation: true,
      encoding: "MP3",
    };

  } else {
    return jsonResponse({ error: "audio_base64 or gcs_object_name is required" }, 400);
  }

  const requestBody = { config, audio };

  try {
    const url =
      "https://speech.googleapis.com/v1/speech:recognize?key=" + GOOGLE_SPEECH_API_KEY;

    const googleRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    const bodyText = await googleRes.text();

    if (!googleRes.ok) {
      console.error("❌ Google STT error", googleRes.status, bodyText);

      const shortBody = bodyText.length > 400 ? bodyText.slice(0, 400) : bodyText;
      const errMsg = "Google STT error (status " + googleRes.status + "): " + shortBody;

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

    const results = Array.isArray(googleJson.results) ? googleJson.results : [];

    const transcript = results
      .map((r: any) => {
        if (!r || !r.alternatives || !r.alternatives[0]) return "";
        return r.alternatives[0].transcript || "";
      })
      .join(" ")
      .trim();

    if (!transcript) {
      console.warn("⚠️ No transcript returned from Google STT", googleJson);
      return jsonResponse({ error: "No transcript from Google STT", google_raw: googleJson }, 200);
    }

    // The v1 recognize endpoint does not reliably return detected language.
    // We provide a best-effort guess for UI purposes.
    const hasThai = /[\u0E00-\u0E7F]/.test(transcript);
    const detectedLanguageCode = hasThai
      ? "th-TH"
      : languageCode;

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
      requested_language_code: languageCode,
      requested_alternative_language_codes: altLanguageCodes,
    });
  } catch (err) {
    console.error("❌ STT function exception", err);
    return jsonResponse({ error: "Internal STT error", details: String(err) }, 500);
  }
});