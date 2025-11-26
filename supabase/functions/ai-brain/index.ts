// supabase/functions/ai-brain/index.ts
//
// Updated to use Gemini 2.0 Flash Experimental model.
// Keeps same external contract + system prompts + JSON interface.
// Fixes API key loading + endpoint + model name.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ============================================================================
// ENV VARS & MODEL
// ============================================================================
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

// Correct Gemini model + correct endpoint structure
// You *can* override with GEMINI_MODEL in Supabase if needed
const GEMINI_MODEL =
  Deno.env.get("GEMINI_MODEL") ?? "models/gemini-2.0-flash-exp";

if (!GEMINI_API_KEY) {
  console.error("❌ GEMINI_API_KEY is NOT set in Supabase environment.");
}

// ============================================================================
// Types
// ============================================================================
type ConversationMode = "legacy" | "language_learning";
type LearningLevel = "beginner" | "intermediate" | "advanced";

interface AiBrainPayload {
  user_id: string;
  conversation_id?: string;
  message_text: string;
  mode?: ConversationMode;
  preferred_locale?: string;
  target_locale?: string | null;
  learning_level?: LearningLevel;
}

// ============================================================================
// Helpers
// ============================================================================
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeLocale(raw: unknown, fallback = "en-US"): string {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const val = raw.trim();
  const lower = val.toLowerCase();

  switch (lower) {
    case "en":
    case "en-us":
      return "en-US";
    case "en-gb":
      return "en-GB";
    case "th":
    case "th-th":
      return "th-TH";
    case "es":
    case "es-es":
      return "es-ES";
    case "fr":
    case "fr-fr":
      return "fr-FR";
    case "de":
    case "de-de":
      return "de-DE";
    default: {
      const cleaned = lower.replaceAll("_", "-");
      if (cleaned.includes("-")) return cleaned;
      return `${cleaned}-${cleaned.toUpperCase()}`;
    }
  }
}

// ============================================================================
// System prompts (unchanged logically)
// ============================================================================
function buildLegacySystemPrompt(preferredLocale: string): string {
  return `
You are the LEGACY STORYTELLING brain for the LegacyMVP app.

ROLE
- The donor is sharing life stories, reflections, values, regrets, and hopes.
- You are a warm, empathetic conversational partner and gentle interviewer.

LANGUAGE
- The donor's preferred language is "${preferredLocale}".
- You MUST respond ONLY in this language.

BEHAVIOR
- Acknowledge what they said.
- Reflect back key emotions or themes.
- Ask ONE thoughtful follow-up question per reply.

STYLE
- Clear, natural sentences.
- Keep replies 30–60 seconds when spoken aloud.
`.trim();
}

function buildLanguageLearningSystemPrompt(
  l1: string,
  l2: string,
  level: LearningLevel,
): string {
  return `
You are the LANGUAGE LEARNING brain for the LegacyMVP app.

CONTEXT
- L1: "${l1}"
- L2: "${l2}"
- Level: "${level}"

OVERRIDE
- You MUST output lines with tags [${l1}] or [${l2}] at the start of each line.
- Never mix languages in a single line.
- ALWAYS provide at least one [${l2}] line as a repeat-after-me example.

GOOD FORMAT EXAMPLE
[${l1}] Today we will practice a short phrase.
[${l2}] <target language phrase>
[${l1}] This means <explanation>.
[${l1}] Please repeat it three times.
[${l2}] <repeat phrase>
`.trim();
}

// ============================================================================
// Gemini call (FIXED for 2.0 Flash Experimental)
// ============================================================================
async function callGemini(finalPrompt: string): Promise<string> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing.");
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: finalPrompt }],
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("❌ Gemini API error:", res.status, errText);
    throw new Error(`Gemini API error: ${res.status} - ${errText}`);
  }

  const json = await res.json();

  try {
    const parts = json?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const text = parts
        .map((p: any) => (typeof p.text === "string" ? p.text : ""))
        .join("\n")
        .trim();

      if (text) return text;
    }
  } catch (e) {
    console.error("❌ Error parsing Gemini response:", e, json);
  }

  return "Sorry, I could not generate a reply.";
}

// ============================================================================
// HTTP Handler
// ============================================================================
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Only POST allowed." }, 405);
  }

  let body: AiBrainPayload;

  try {
    const raw = await req.json();
    console.log("🧠 ai-brain incoming:", raw);
    body = raw as AiBrainPayload;
  } catch (_) {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const { user_id, message_text, conversation_id } = body;

  if (!user_id || !user_id.trim()) {
    return jsonResponse({ error: "user_id is required." }, 400);
  }
  if (!message_text || !message_text.trim()) {
    return jsonResponse({ error: "message_text is required." }, 400);
  }

  // Resolve modes, locales
  const modeRaw = (body.mode ?? "legacy").toLowerCase();
  const conversationMode: ConversationMode =
    modeRaw === "language_learning" ? "language_learning" : "legacy";

  const preferredLocale = normalizeLocale(body.preferred_locale, "en-US");

  const targetRaw =
    body.target_locale === undefined || body.target_locale === null
      ? null
      : String(body.target_locale);

  const hasTarget = !!(targetRaw && targetRaw.trim());
  const targetLocale = hasTarget
    ? normalizeLocale(targetRaw)
    : preferredLocale;

  const learningLevel: LearningLevel =
    body.learning_level &&
      ["beginner", "intermediate", "advanced"].includes(body.learning_level)
      ? body.learning_level
      : "beginner";

  const effectiveConversationId =
    conversation_id && conversation_id.trim()
      ? conversation_id
      : "default";

  // Build system prompt
  const systemPrompt =
    conversationMode === "language_learning"
      ? buildLanguageLearningSystemPrompt(
        preferredLocale,
        targetLocale,
        learningLevel,
      )
      : buildLegacySystemPrompt(preferredLocale);

  const finalPrompt = `${systemPrompt}

User message:
"${message_text.trim()}"`.trim();

  // Call Gemini
  try {
    const replyText = await callGemini(finalPrompt);

    return jsonResponse({
      reply_text: replyText,
      mode: conversationMode,
      preferred_locale: preferredLocale,
      target_locale: hasTarget ? targetLocale : null,
      learning_level: learningLevel,
      conversation_id: effectiveConversationId,
    });
  } catch (e) {
    console.error("❌ ai-brain handler error:", e);
    return jsonResponse(
      {
        error: "Failed to generate reply from Gemini.",
        details: String(e),
      },
      500,
    );
  }
});
