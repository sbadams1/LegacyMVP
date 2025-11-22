// supabase/functions/memory-summarize/index.ts
//
// Level 2 memory summarizer.
// - Reads recent memory_raw rows for a user
// - Looks up the latest summary for a conversation (if any)
// - Calls Gemini to produce short_summary, full_summary, observations
// - Upserts a single row per (user_id, conversation_id) in memory_summary
// - Also updates a lifetime memory_profile row per user
//
// Expects JSON body:
//   {
//     "user_id": "<uuid>",
//     "conversation_id": "<uuid or string>"
//   }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---- Config ----

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Use the same model style as ai-brain:
const MODEL = "models/gemini-2.0-flash-exp";

// Prefer the same env var naming as ai-brain (adjust if needed)
const GEMINI_API_KEY =
  Deno.env.get("GOOGLE_GEMINI_API_KEY") ??
  Deno.env.get("GEMINI_API_KEY") ??
  "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
}

if (!GEMINI_API_KEY) {
  console.warn(
    "GEMINI API key (GOOGLE_GEMINI_API_KEY / GEMINI_API_KEY) is not set.",
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---- Handler ----

serve(async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const body = (await req.json()) as {
      user_id?: string;
      conversation_id?: string;
    };

    const userId = body.user_id?.trim();
    const conversationId = body.conversation_id?.toString().trim();

    if (!userId || !conversationId) {
      return jsonResponse(
        { error: "user_id and conversation_id are required" },
        200,
      );
    }

    if (!GEMINI_API_KEY) {
      return jsonResponse(
        { error: "GEMINI_API_KEY / GOOGLE_GEMINI_API_KEY is not configured." },
        200,
      );
    }

    // 1) Latest existing summary (if any) for this conversation
    const { data: latestSummary, error: latestSummaryError } = await supabase
      .from("memory_summary")
      .select("*")
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestSummaryError) {
      console.error("Error reading memory_summary:", latestSummaryError);
    }

    const lastRawId = latestSummary?.raw_id ?? null;
    const previousFullSummary: string | null =
      latestSummary?.full_summary ?? null;

    // 2) Load recent raw memories
    let rawQuery = supabase
      .from("memory_raw")
      .select("id, source, content, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (lastRawId !== null && lastRawId !== undefined) {
      // Only summarize newer rows
      rawQuery = rawQuery.gt("id", lastRawId);
    } else {
      // First time: cap to last N messages
      rawQuery = rawQuery.limit(50);
    }

    const { data: rawRows, error: rawError } = await rawQuery;

    if (rawError) {
      console.error("Error reading memory_raw:", rawError);
      return jsonResponse(
        { error: "Failed to load memory_raw", details: rawError.message },
        200,
      );
    }

    if (!rawRows || rawRows.length === 0) {
      return jsonResponse(
        { message: "No new memory_raw rows to summarize." },
        200,
      );
    }

    const latestRawRow = rawRows[rawRows.length - 1];
    const newRawId = latestRawRow.id;

    const newMessagesText = rawRows
      .map((row: any) => {
        const time = row.created_at ?? "";
        const src = row.source ?? "unknown";
        const content = (row.content ?? "").toString().trim();
        return `[${time}] (${src}) ${content}`;
      })
      .join("\n");

    // 3) Build Gemini prompt (USER-FOCUSED CONVERSATION SUMMARY)
    const promptParts: string[] = [];

    promptParts.push(
      'You are an AI "user-memory summarizer" for a legacy-preservation app.',
    );
    promptParts.push("");
    promptParts.push(
      "Your ONLY job is to update a long-term memory profile of the HUMAN USER based on this conversation.",
    );
    promptParts.push("");
    promptParts.push(
      "The messages below come from a chat between the user and an assistant.",
    );
    promptParts.push(
      "Each line includes a 'source' tag like (user) or (assistant).",
    );
    promptParts.push(
      "FOCUS ONLY on what we can learn about the USER: their identity, background, projects, values, preferences, goals, feelings, decisions, and important life details.",
    );
    promptParts.push(
      "Ignore the assistant's explanations, lectures, feature ideas, and ethical discussions EXCEPT when the user's reaction reveals something about them.",
    );
    promptParts.push(
      "Do NOT summarize what the assistant said. Do NOT describe AI behavior.",
    );
    promptParts.push(
      "Only include implementation or technical details if they clearly matter to the user's ongoing projects or long-term intentions.",
    );
    promptParts.push("");

    if (previousFullSummary) {
      promptParts.push(
        "Here is the existing full_summary of what we know about the USER so far in this conversation:",
      );
      promptParts.push(previousFullSummary);
      promptParts.push("");
      promptParts.push(
        "Now here are NEW messages that happened after that summary (in chronological order):",
      );
    } else {
      promptParts.push(
        "There is NO prior summary yet for this conversation. Here are the recent messages (in chronological order):",
      );
    }

    promptParts.push("");
    promptParts.push(newMessagesText);
    promptParts.push("");
    promptParts.push(
      "From these messages, extract ONLY information about the USER.",
    );
    promptParts.push(
      "Think of this as updating a memory profile that will drive a future legacy avatar of the user.",
    );
    promptParts.push("");
    promptParts.push(
      "Now produce a single JSON object with EXACTLY this shape:",
    );
    promptParts.push(`{
  "short_summary": "1–2 sentences describing what we learned about the user in this conversation.",
  "full_summary": "A richer, USER-FOCUSED narrative that merges any prior context with the new information.",
  "observations": {
    "themes": ["string", "..."],
    "emotions": ["string", "..."],
    "followup_questions": ["string", "..."]
  },
  "raw_id": null,
  "conversation_id": "${conversationId}"
}`);
    promptParts.push("");
    promptParts.push("Rules:");
    promptParts.push(
      "- Always write from the perspective of describing the USER, not the assistant.",
    );
    promptParts.push(
      "- If there is very little new information about the user, produce a minimal update and note that explicitly in the summaries.",
    );
    promptParts.push(
      "- Respond with valid JSON only. No markdown, no comments, no extra text.",
    );

    const prompt = promptParts.join("\n");

    // 4) Call Gemini for conversation-level summary
    const geminiUrl =
      `https://generativelanguage.googleapis.com/v1beta/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const summaryReqBody = {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 512,
        responseMimeType: "application/json",
      },
    };

    const summaryRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summaryReqBody),
    });

    const summaryText = await summaryRes.text();
    let summaryJson: any;

    try {
      summaryJson = JSON.parse(summaryText);
    } catch (_err) {
      console.error("Failed to parse Gemini summary HTTP body as JSON:", summaryText);
      return jsonResponse(
        {
          error: "Failed to parse Gemini summary HTTP body",
          raw: summaryText,
        },
        200,
      );
    }

    if (!summaryRes.ok) {
      console.error("Gemini summary HTTP error:", summaryRes.status, summaryJson);
      return jsonResponse(
        {
          error: "Gemini error (summary)",
          details: `HTTP ${summaryRes.status}`,
          geminiError: summaryJson,
        },
        200,
      );
    }

    // 5) Extract model JSON payload for conversation summary
    let summaryObj: any = null;
    try {
      const textFromModel =
        summaryJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

      summaryObj = JSON.parse(textFromModel);
    } catch (err) {
      console.error("Failed to parse model's summary JSON payload:", err, summaryJson);
      return jsonResponse(
        { error: "Invalid JSON from model (summary)", geminiRaw: summaryJson },
        200,
      );
    }

    const shortSummary =
      (summaryObj?.short_summary ?? "").toString().trim() ||
      "Short summary unavailable.";
    const fullSummary =
      (summaryObj?.full_summary ?? "").toString().trim() ||
      previousFullSummary ||
      "Full summary unavailable.";
    const observations = summaryObj?.observations ?? {};

    // 6) Upsert-style behavior for memory_summary: one row per (user_id, conversation_id)
    const summaryPayload = {
      user_id: userId,
      conversation_id: conversationId,
      raw_id: newRawId,
      short_summary: shortSummary,
      full_summary: fullSummary,
      observations,
    };

    let savedSummaryRow: any;

    if (latestSummary) {
      const { data, error } = await supabase
        .from("memory_summary")
        .update(summaryPayload)
        .eq("id", latestSummary.id)
        .select("*")
        .single();

      if (error) {
        console.error("Error updating memory_summary:", error);
        return jsonResponse(
          {
            error: "Failed to update memory_summary",
            details: error.message,
            payload: summaryPayload,
          },
          200,
        );
      }

      savedSummaryRow = data;
    } else {
      const { data, error } = await supabase
        .from("memory_summary")
        .insert(summaryPayload)
        .select("*")
        .single();

      if (error) {
        console.error("Error inserting memory_summary:", error);
        return jsonResponse(
          {
            error: "Failed to insert memory_summary",
            details: error.message,
            payload: summaryPayload,
          },
          200,
        );
      }

      savedSummaryRow = data;
    }

    // 7) Update lifetime memory_profile (one row per user)
    try {
      const { data: existingProfile, error: profileError } = await supabase
        .from("memory_profile")
        .select("*")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (profileError) {
        console.error("Error reading memory_profile:", profileError);
      }

      const previousProfileText: string | null =
        existingProfile?.full_profile ?? null;

      const lifetimeParts: string[] = [];

      lifetimeParts.push(
        "You are an AI lifetime-profile summarizer for a legacy-preservation app.",
      );
      lifetimeParts.push("");
      lifetimeParts.push(
        "Your job is to maintain an evolving, long-term profile of the HUMAN USER across all conversations.",
      );
      lifetimeParts.push(
        "The profile should capture stable facts, life history, recurring themes, values, goals, and enduring preferences.",
      );
      lifetimeParts.push("");
      if (previousProfileText) {
        lifetimeParts.push(
          "Here is the existing lifetime profile of the user so far:",
        );
        lifetimeParts.push(previousProfileText);
        lifetimeParts.push("");
        lifetimeParts.push(
          "Here is a fresh conversation-level summary from the most recent interaction:",
        );
      } else {
        lifetimeParts.push(
          "There is NO prior lifetime profile yet. Here is a conversation-level summary from a recent interaction. Use this as initial material for the lifetime profile:",
        );
      }

      lifetimeParts.push("");
      lifetimeParts.push(fullSummary);
      lifetimeParts.push("");
      lifetimeParts.push(
        "From this, produce an UPDATED lifetime profile of the user.",
      );
      lifetimeParts.push(
        "Focus on enduring details – not transient specifics like 'today I had coffee' unless they clearly reveal stable habits or identity.",
      );
      lifetimeParts.push("");
      lifetimeParts.push(
        "Return a single JSON object with EXACTLY this shape:",
      );
      lifetimeParts.push(`{
  "full_profile": "A long-form, user-focused description of who this person is across time.",
  "observations": {
    "themes": ["string", "..."],
    "emotions": ["string", "..."],
    "followup_questions": ["string", "..."]
  }
}`);
      lifetimeParts.push("");
      lifetimeParts.push(
        "Rules: Respond with valid JSON only. No markdown, no comments, no extra text.",
      );

      const lifetimePrompt = lifetimeParts.join("\n");

      const profileReqBody = {
        contents: [
          {
            role: "user",
            parts: [{ text: lifetimePrompt }],
          },
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 768,
          responseMimeType: "application/json",
        },
      };

      const profileRes = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profileReqBody),
      });

      const profileText = await profileRes.text();
      let profileJson: any;

      try {
        profileJson = JSON.parse(profileText);
      } catch (_err) {
        console.error(
          "Failed to parse Gemini lifetime-profile HTTP body as JSON:",
          profileText,
        );
        // Non-fatal for the main response
        profileJson = null;
      }

      if (!profileRes.ok) {
        console.error(
          "Gemini lifetime-profile HTTP error:",
          profileRes.status,
          profileJson,
        );
      } else if (profileJson) {
        let profileObj: any = null;
        try {
          const textFromModel =
            profileJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

          profileObj = JSON.parse(textFromModel);
        } catch (err) {
          console.error(
            "Failed to parse model's lifetime-profile JSON payload:",
            err,
            profileJson,
          );
          profileObj = null;
        }

        if (profileObj) {
          const fullProfile =
            (profileObj?.full_profile ?? "").toString().trim() ||
            previousProfileText ||
            "Profile unavailable.";
          const profileObservations = profileObj?.observations ?? {};

          const profilePayload = {
            user_id: userId,
            full_profile: fullProfile,
            observations: profileObservations,
          };

          if (existingProfile) {
            const { error: updateProfileError } = await supabase
              .from("memory_profile")
              .update(profilePayload)
              .eq("id", existingProfile.id);

            if (updateProfileError) {
              console.error(
                "Error updating memory_profile:",
                updateProfileError,
              );
            }
          } else {
            const { error: insertProfileError } = await supabase
              .from("memory_profile")
              .insert(profilePayload);

            if (insertProfileError) {
              console.error(
                "Error inserting memory_profile:",
                insertProfileError,
              );
            }
          }
        }
      }
    } catch (err) {
      console.error("Error while updating memory_profile:", err);
      // Non-fatal
    }

    // 8) Return conversation-level summary as function result
    return jsonResponse(
      {
        short_summary: savedSummaryRow.short_summary,
        full_summary: savedSummaryRow.full_summary,
        observations: savedSummaryRow.observations,
        raw_id: savedSummaryRow.raw_id,
        conversation_id: savedSummaryRow.conversation_id,
      },
      200,
    );
  } catch (err) {
    console.error("memory-summarize function error:", err);
    return jsonResponse(
      { error: "Server error", details: String(err) },
      200,
    );
  }
});

// ---- Helpers ----

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}
