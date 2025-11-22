// supabase/functions/media-ingest/index.ts
//
// Analyze an uploaded photo or short video using Gemini 2.0 Flash Exp,
// returning a warm, concise description + follow-up question(s).
//
// We currently only call this from the app for IMAGES,
// but the video branch is kept for future use.
//
// Request JSON:
// {
//   "user_id": "uuid",
//   "media_base64": "....",
//   "mime_type": "image/jpeg" | "video/mp4",
//   "media_type": "image" | "video",
//   "file_name": "optional string"
// }
//
// Response JSON:
// {
//   "status": "ok",
//   "description": "...",
//   "model": "models/gemini-2.0-flash-exp"
// }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async (req: Request): Promise<Response> => {
  // --- CORS ---
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

  // --- Parse incoming JSON ---
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const { user_id, media_base64, mime_type, media_type, file_name } = payload;

  if (!user_id || !media_base64 || !mime_type || !media_type) {
    return jsonResponse(
      {
        error:
          "user_id, media_base64, mime_type, and media_type are required",
      },
      400,
    );
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return jsonResponse(
      { error: "GEMINI_API_KEY is not configured" },
      500,
    );
  }

  const model =
    Deno.env.get("GEMINI_MODEL") ?? "models/gemini-2.0-flash-exp";

  // ------------------------------------------------------------------
  // 🌟 WARM, BUT CONCISE PROMPTS (image vs video)
  // ------------------------------------------------------------------
  const isVideo = media_type === "video";

  const prompt = isVideo
    ? [
        // We’re not calling this from the app yet, but keep it ready.
        "You are helping someone preserve a short life moment from a video.",
        "Describe ONLY what you can visually observe.",
        "Write 2–3 short sentences (max 50 words total) noticing concrete details like expressions, movement, and mood.",
        "Use warm, human language, but do NOT guess relationships, names, or backstory.",
        "Then ask ONE short follow-up question inviting them to share why this clip matters to them.",
        'Example: "What was happening around this moment that makes it meaningful to you?"',
        "Do NOT mention that you are an AI. Do NOT talk about 'watching' the video.",
      ].join(" ")
    : [
        "You are helping someone preserve a meaningful moment from a photo.",
        "Describe ONLY what you can directly see.",
        "Write 1–2 short sentences (max 40 words) that notice a few key visual details and the overall mood.",
        "Use warm, natural language, but do NOT guess relationships, names, or backstory.",
        "Then ask ONE gentle follow-up question that invites them to tell the story or meaning behind this moment.",
        'Example: "What was happening in this moment, and why is it important to you?"',
        "Do NOT mention that you are an AI. Do NOT talk about 'looking at' the image.",
      ].join(" ");

  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: mime_type,
              data: media_base64,
            },
          },
        ],
      },
    ],
  };

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    );

    const raw = await resp.text();
    if (!resp.ok) {
      return jsonResponse(
        {
          error: "Gemini error",
          status: resp.status,
          body: raw,
        },
        500,
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsonResponse(
        { error: "Failed to parse Gemini response", raw },
        500,
      );
    }

    const parts = parsed?.candidates?.[0]?.content?.parts ?? [];
    const description = parts
      .map((p: any) => p.text ?? "")
      .join("")
      .trim();

    return jsonResponse(
      {
        status: "ok",
        description,
        model,
      },
      200,
    );
  } catch (err) {
    return jsonResponse(
      { error: "Server error", details: String(err) },
      500,
    );
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
