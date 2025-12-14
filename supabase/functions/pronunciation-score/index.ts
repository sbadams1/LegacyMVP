// supabase/functions/pronunciation-score/index.ts
//
// REAL pronunciation scoring using Gemini Pro audio.
// - Input: base64 audio + target phrase in L2
// - Output: JSON with score, feedback, ideal L2 form, attempt transcript
//
// This function is intentionally separate from ai-brain/index.ts so
// conversation logic (flash) and pronunciation scoring (pro audio) stay clean.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.48.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const GEMINI_API_KEY =
  Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GEMINI_API_KEY_EDGE");

// Use an audio-capable Pro model.
const GEMINI_AUDIO_MODEL =
  Deno.env.get("GEMINI_AUDIO_MODEL") ?? "models/gemini-1.5-pro-latest";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.");
}

if (!GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY / GEMINI_API_KEY_EDGE is not set.");
}

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
  : null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Small helper to strip code fences if Gemini ever wraps JSON.
function stripCodeFences(text: string): string {
  if (!text) return text;
  let result = text.trim();
  // remove ```json ... ``` or ``` ... ```
  result = result.replace(/^```[a-zA-Z0-9]*\s*/m, "");
  result = result.replace(/```$/m, "");
  return result.trim();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!GEMINI_API_KEY) {
    return jsonResponse({ error: "Gemini API key not configured" }, 500);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON payload" }, 400);
  }

  const {
    user_id,
    l1_locale,
    l2_locale,
    target_phrase_l2,
    target_phrase_romanization,
    audio_base64,
    audio_mime_type,
    lesson_meta,
  } = body ?? {};

  if (!user_id || !audio_base64 || !target_phrase_l2 || !l2_locale) {
    return jsonResponse(
      {
        error:
          "Missing required fields: user_id, audio_base64, target_phrase_l2, l2_locale",
      },
      400,
    );
  }

  const safeL1 = typeof l1_locale === "string" && l1_locale.trim()
    ? l1_locale
    : "en-US";

  // You should set this to match your recorder output:
  // e.g. "audio/webm", "audio/m4a", "audio/aac", "audio/wav"
  const mimeType = typeof audio_mime_type === "string" && audio_mime_type.trim()
    ? audio_mime_type.trim()
    : "audio/webm";

  const prompt = `
You are a pronunciation coach in a language-learning app.

Learner:
- Main language (L1) locale: ${safeL1}
- Target language (L2) locale: ${l2_locale}

Target phrase:
- L2 script: "${target_phrase_l2}"
- L2 romanization (if provided): "${target_phrase_romanization || ""}"

TASK:
1) Listen carefully to the learner's audio.
2) Compare it to the target phrase.
3) Evaluate pronunciation accuracy (segmental sounds, tones, stress, rhythm, etc.).
4) Respond ONLY with a single JSON object, strictly following this schema:

{
  "score_0_100": <integer 0-100>,
  "feedback_l1": "<short feedback in the learner's main language>",
  "ideal_l2_script": "<correct target phrase in L2 script>",
  "ideal_l2_romanization": "<romanization for the correct phrase>",
  "attempt_transcript_l2": "<your best guess at what the learner actually said in L2>"
}

CONSTRAINTS:
- "feedback_l1" MUST be concise (1–2 sentences), friendly, and specific:
  - Mention 1–2 key strengths.
  - Mention 1–2 key issues (e.g., final tone too flat, vowel too short).
- "score_0_100":
  - 0–40: very hard to understand / many issues.
  - 41–70: understandable but several clear pronunciation issues.
  - 71–90: generally good, with some minor issues.
  - 91–100: very close to native-like pronunciation.
- Output MUST be valid JSON. Do NOT include any extra commentary, Markdown, or text outside the JSON object.
`.trim();

  const geminiUrl =
    `https://generativelanguage.googleapis.com/v1beta/${GEMINI_AUDIO_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const geminiRequestBody = {
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType,
              data: audio_base64,
            },
          },
          { text: prompt },
        ],
      },
    ],
  };

  let geminiText = "";
  try {
    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiRequestBody),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini error:", errText);
      return jsonResponse(
        { error: "Gemini request failed", details: errText },
        500,
      );
    }

    const geminiJson = await geminiRes.json();

    // We expect the JSON to be in the first text part.
    const parts = geminiJson?.candidates?.[0]?.content?.parts ?? [];
    const textParts = parts
      .map((p: any) => p?.text)
      .filter((t: any) => typeof t === "string") as string[];

    geminiText = stripCodeFences(textParts.join("\n").trim());
  } catch (err) {
    console.error("Gemini request exception:", err);
    return jsonResponse(
      { error: "Gemini request exception", details: String(err) },
      500,
    );
  }

  // Parse JSON from the model
  let parsed: any;
  try {
    parsed = JSON.parse(geminiText);
  } catch (err) {
    console.error("Failed to parse Gemini JSON:", err, geminiText);
    return jsonResponse(
      { error: "Bad model JSON", raw: geminiText },
      500,
    );
  }

  let score = Number(parsed.score_0_100 ?? 0);
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(100, score));

  const feedback_l1 = String(parsed.feedback_l1 ?? "");
  const ideal_l2_script = String(parsed.ideal_l2_script ?? target_phrase_l2);
  const ideal_l2_romanization = String(
    parsed.ideal_l2_romanization ?? target_phrase_romanization ?? "",
  );
  const attempt_transcript = String(parsed.attempt_transcript_l2 ?? "");

  // Optional logging into pronunciation_attempts (reuse schema from ai-brain).
  if (supabase) {
    try {
      const payload = {
        user_id,
        target_language: l2_locale,
        unit_id: lesson_meta?.unit_id ?? null,
        lesson_id: lesson_meta?.lesson_id ?? null,
        concept_key: lesson_meta?.concept_key ?? null,
        target_phrase: target_phrase_l2,
        learner_transcript: attempt_transcript || null,
        score,
        raw_model_score_line: feedback_l1,
        created_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from("pronunciation_attempts")
        .insert(payload);

      if (error) {
        console.error("pronunciation_attempts insert error:", error);
      }
    } catch (err) {
      console.error("pronunciation_attempts insert exception:", err);
    }
  }

  return jsonResponse({
    score,
    feedback_l1,
    ideal_l2_script,
    ideal_l2_romanization,
    attempt_transcript,
  });
});
