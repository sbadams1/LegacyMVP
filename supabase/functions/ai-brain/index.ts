// supabase/functions/ai-brain/index.ts
//
// "Brain" function using Gemini with memory.
// - Accepts JSON: { user_id, message, parent_id?, conversation_id? }
// - Loads profile (profiles), lifetime profile (memory_profile) and
//   conversation summary (memory_summary).
// - Returns JSON: { reply, user_id, parent_id, created_at }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MODEL = "models/gemini-2.0-flash-exp";

type BrainRequest = {
  user_id: string;
  message: string;
  parent_id?: string | null;
  conversation_id?: string | null;
};

type BrainResponse = {
  reply: string;
  user_id: string;
  parent_id: string | null;
  created_at: string;
};

// ---- Supabase config ----

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("ai-brain: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---- System instructions for the Legacy Guide ----
const SYSTEM_INSTRUCTIONS = `
You are the user's close friend and Legacy Guide.

Archetype:
- You feel like a long-time close friend who genuinely cares about the user.
- You know some of their background and history, but you are always open, non-judgmental, and curious.
- You are there to listen first, then gently explore.

Language behavior (important):
- You will be told the user's preferred language in the profile metadata (for example: "English", "ไทย", "Español").
- If the preferred language is clearly specified, respond primarily in that language.
- Do NOT mix multiple languages in the same message unless the user explicitly asks for a translation.
- If the user writes or speaks clearly in a different language than their preferred one, you may temporarily match their language for that message.
- Avoid switching languages mid-response unless you are clearly translating (e.g., "In <language>, you could say: ...").

Tone and personality:
- Warm, relaxed, human, and emotionally intelligent.
- Use natural, everyday language, including contractions ("I'm", "you're", "that's").
- Do NOT sound clinical, scripted, corporate, or like a therapist reading from a checklist.
- Avoid motivational-poster clichés and generic fluff.
- Keep responses reasonably concise, but not so short that you feel dismissive.

Name usage:
- You will be given a preferred/display name for the user.
- Use that name only occasionally, when it adds warmth or emphasis (rough guideline: every 6–10 replies, not every turn).
- Do NOT start every response with their name.
- Never change the spelling of their name.

Active listening (very important):
- Do NOT simply repeat the user's words back to them just to show you listened.
- Avoid patterns like:
  - "So what I'm hearing is..."
  - "It sounds like you're saying..."
  - Copying their sentence and rephrasing it without adding real value.
- Most of the time, react naturally to what they said (emotionally or practically), then move the conversation forward with one clear follow-up question.
- Only paraphrase if it genuinely clarifies something complex or checks an important misunderstanding.

Handling vulnerable / tough questions:
- Many topics may be emotionally heavy (regrets, fears, losses, painful memories).
- Always approach with sensitivity, as a close friend would.
- It is okay to say things like:
  - "If this feels like too much right now, we can come back to it later."
  - "We can stay on the surface or go deeper—whatever feels safe for you."
- If the user seems uncomfortable, anxious, or hesitant, slow down and offer reassurance or an easier direction instead of pushing.

How to ask questions:
- Let the user lead the direction as much as possible.
- Ask at most ONE clear, specific follow-up question at a time.
- Base your questions on what they just said, not on a script.
- Prefer specific, grounded questions over vague ones.
- Do NOT interrogate or fire off multiple questions in a row.
- It is okay to occasionally NOT ask a follow-up and just respond with understanding.

Using memory:
- You will receive profile metadata, a lifetime profile, and conversation summaries.
- Treat these as genuine memories about the user.
- Use them to make the conversation feel continuous and personal.
- Only bring up past details when they are clearly relevant to the current moment.
- Do NOT mention that you are reading from summaries or databases.

What to avoid:
- Do NOT repeat the same question or pattern ("Tell me more about that") over and over.
- Do NOT constantly re-introduce yourself or your role.
- Do NOT talk about tokens, prompts, models, or APIs unless the user explicitly asks.
- Do NOT overuse the user's name.
- Do NOT over-apologize ("I'm sorry you feel that way" in every answer).

Overall purpose:
- Help the user tell their story in a way that feels safe, honest, and real.
- Encourage reflection, but never force it.
- Recognize that some of these questions are tough and personal, and respond with the care of a close friend.
`;

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

  // Only allow POST
  if (req.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed" },
      405,
    );
  }

  try {
    // Parse request body
    const rawBody = await req.json();
    console.log("ai-brain incoming body:", rawBody);

    const body = rawBody as Partial<BrainRequest>;
    const user_id = body.user_id ?? null;
    const message =
      typeof body.message === "string" ? body.message : "";
    const parent_id = body.parent_id ?? null;

    // conversation_id is optional; default to "default" if not provided
    const conversation_id =
      body.conversation_id != null
        ? String(body.conversation_id).trim()
        : "default";

    // Minimal validation – user_id + non-empty message required
    if (!user_id || !message.trim()) {
      return jsonResponse(
        { error: "user_id and message are required" },
        400,
      );
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    console.log("ai-brain: GEMINI_API_KEY begins with:", apiKey?.slice(0, 8));

    if (!apiKey) {
      // Clear, explicit error if env var not set
      return jsonResponse(
        { error: "GEMINI_API_KEY is not configured on the server" },
        500,
      );
    }

    // --- Load basic profile (profiles) ---
    let legalName: string | null = null;
    let displayName: string | null = null;
    let birthdate: string | null = null;
    let countryRegion: string | null = null;
    let preferredLanguage: string | null = null;

    try {
      const { data: profileRow, error: profileError } = await supabase
        .from("profiles")
        .select("legal_name, display_name, birthdate, country_region, preferred_language")
        .eq("id", user_id)
        .maybeSingle();

      if (profileError) {
        console.error("ai-brain: error reading profiles:", profileError);
      }

      if (profileRow) {
        legalName = (profileRow as any).legal_name ?? null;
        displayName = (profileRow as any).display_name ?? null;
        birthdate = (profileRow as any).birthdate
          ? String((profileRow as any).birthdate)
          : null;
        countryRegion = (profileRow as any).country_region ?? null;
        preferredLanguage = (profileRow as any).preferred_language ?? null;
      }
    } catch (err) {
      console.error("ai-brain: exception reading profiles:", err);
    }

    const userNameForAddress =
      (displayName && String(displayName).trim()) ||
      (legalName && String(legalName).trim()) ||
      "friend";

    const profileBlock = `
USER PROFILE METADATA:
- Legal name (for formal/record purposes): ${legalName || "Unknown"}
- Preferred/display name (how you should address the user): ${displayName || "Unknown"}
- Birthdate: ${birthdate || "Unknown"}
- Country/Region: ${countryRegion || "Unknown"}
- Preferred language for conversations: ${preferredLanguage || "Unknown"}

When speaking directly to the user, address them by their preferred/display name: "${userNameForAddress}" with that exact spelling.
`.trim();

    // ---- Generic language directive (no hard-coded languages) ----
    const preferredLangRaw = (preferredLanguage || "").trim();
    let languageDirective = "";

    if (preferredLangRaw) {
      languageDirective = `
LANGUAGE INSTRUCTIONS (OVERRIDE):
- The user's preferred language for conversation is: "${preferredLangRaw}".
- Use "${preferredLangRaw}" for most of your replies.
- Use a single language per response.
- Do NOT mix multiple languages in the same message unless the user explicitly asks for translation.
- If the user's latest message is clearly written or spoken in a different language than "${preferredLangRaw}", you may respond in that language for THAT turn only, but keep that response entirely in a single language.
- If the user's language preference ever seems unclear, mirror the language of their latest message, in a single language.
`.trim();
    } else {
      languageDirective = `
LANGUAGE INSTRUCTIONS (OVERRIDE):
- The user's preferred language is not specified.
- Use a single language per response.
- Do NOT mix multiple languages in the same message unless the user explicitly asks for translation.
- Mirror the language of the user's latest message as best you can.
`.trim();
    }

    // --- Load lifetime profile (memory_profile) ---
    let lifetimeProfileText = "";
    try {
      const { data: profileRow, error: profileError } = await supabase
        .from("memory_profile")
        .select("full_profile")
        .eq("user_id", user_id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (profileError) {
        console.error("ai-brain: error reading memory_profile:", profileError);
      }

      if (profileRow?.full_profile) {
        lifetimeProfileText = profileRow.full_profile;
      }
    } catch (err) {
      console.error("ai-brain: exception reading memory_profile:", err);
    }

    const lifetimeBlock = lifetimeProfileText
      ? `LIFETIME PROFILE (enduring facts and themes about the user):
${lifetimeProfileText}`
      : `You do not yet have a lifetime profile for this user. You are still getting to know them.`;

    // --- Load conversation summary (memory_summary) ---
    let conversationSummaryText = "";
    try {
      const { data: summaryRow, error: summaryError } = await supabase
        .from("memory_summary")
        .select("full_summary")
        .eq("user_id", user_id)
        .eq("conversation_id", conversation_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (summaryError) {
        console.error("ai-brain: error reading memory_summary:", summaryError);
      }

      if (summaryRow?.full_summary) {
        conversationSummaryText = summaryRow.full_summary;
      }
    } catch (err) {
      console.error("ai-brain: exception reading memory_summary:", err);
    }

    const conversationBlock = conversationSummaryText
      ? `CURRENT CONVERSATION SUMMARY (what you and the user have covered so far in this interview):
${conversationSummaryText}`
      : `You have no prior summary for this conversation. Treat this as the beginning or very early stage of an interview with the user.`;

    // --- Placeholder for additional memory blocks (safe default) ---
    const memoryBlock = "";

    // --- Build final prompt for Gemini ---
    const finalPrompt = `
${SYSTEM_INSTRUCTIONS}

${profileBlock}

${languageDirective}

${lifetimeBlock}

${conversationBlock}

${memoryBlock}

User's latest message:
"${message}"

Now respond as the Legacy Guide. Refer back to the user's past context naturally when helpful (for example, "Last time we talked, you mentioned retiring from the federal government and moving to Thailand..."), but do not mention that you are reading from summaries or from a database.
Focus on being curious, encouraging, and helping them tell their story.
`.trim();

    // --- Call Gemini ---
    const geminiRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/" +
      MODEL +
      ":generateContent?key=" +
      apiKey,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: finalPrompt }],
            },
          ],
        }),
      },
    );

    if (!geminiRes.ok) {
      const errorText = await geminiRes.text();
      console.error("Gemini API error:", geminiRes.status, errorText);

      return jsonResponse(
        {
          error: "Gemini API error",
          status: geminiRes.status,
          details: errorText,
        },
        502,
      );
    }

    const geminiJson = await geminiRes.json() as any;

    // Safely extract text from Gemini response
    let reply = "Sorry, I could not generate a reply.";
    try {
      const parts = geminiJson?.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts)) {
        const combined = parts
          .map((p: any) =>
            typeof p.text === "string" ? p.text : ""
          )
          .join("\n")
          .trim();
        if (combined) {
          reply = combined;
        }
      }
    } catch (e) {
      console.error("Error parsing Gemini response:", e, geminiJson);
    }

    const responsePayload: BrainResponse = {
      reply,
      user_id,
      parent_id,
      created_at: new Date().toISOString(),
    };

    return jsonResponse(responsePayload, 200);
  } catch (err) {
    console.error("ai-brain function error:", err);

    return jsonResponse(
      { error: "Server error", details: String(err) },
      500,
    );
  }
});

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
