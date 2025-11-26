// supabase/functions/media-ingest/index.ts
//
// Uses Gemini 2.0 Flash Experimental to describe uploaded media (image or video)
// for the Legacy app. Returns a single "caption" string that is meant to be
// shown as one unified AI chat bubble in the mobile app.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Prefer unified GOOGLE_API_KEY, fall back to GEMINI_API_KEY
const GOOGLE_API_KEY =
  Deno.env.get("GOOGLE_API_KEY") ?? Deno.env.get("GEMINI_API_KEY") ?? null;

// Extract caption text from Gemini response
function extractCaption(gJson: any): string {
  try {
    const candidates = gJson?.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return "";

    const parts = candidates[0]?.content?.parts;
    if (!Array.isArray(parts)) return "";

    const textParts = parts
      .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
      .filter((t: string) => t.trim().length > 0);

    return textParts.join("\n").trim();
  } catch {
    return "";
  }
}

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    if (!GOOGLE_API_KEY) {
      console.error("media-ingest: GOOGLE_API_KEY / GEMINI_API_KEY not set");
      return new Response(
        JSON.stringify({ error: "server_not_configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Be defensive about body shape
    const raw = await req.json().catch(() => ({}));
    const body: any = raw?.body ?? raw?.data ?? raw ?? {};

    try {
      console.log("📸 media-ingest body keys:", Object.keys(body));
    } catch {
      console.log("📸 media-ingest body is not a plain object");
    }

    const userId: string | undefined =
      body?.user_id ??
      body?.userId ??
      undefined;

    const mediaTypeRaw: string | undefined =
      body?.media_type ??
      body?.mediaType ??
      undefined;

    const imageUrl: string | undefined =
      body?.image_url ??
      body?.imageUrl ??
      body?.photo_url ??
      body?.photoUrl ??
      undefined;

    const videoUrl: string | undefined =
      body?.video_url ??
      body?.videoUrl ??
      undefined;

    const publicUrl: string | undefined =
      body?.public_url ??
      body?.publicUrl ??
      body?.url ??
      body?.media_url ??
      body?.mediaUrl ??
      undefined;

    const mediaBase64: string | undefined =
      body?.media_base64 ??
      body?.base64 ??
      body?.base64_snippet ??
      undefined;

    const mimeTypeBody: string | undefined =
      body?.mime_type ??
      body?.mimeType ??
      undefined;

    if (!userId) {
      return new Response(
        JSON.stringify({
          error: "user_id_required",
          message: "user_id is required in body",
          body_keys: Object.keys(body || {}),
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Decide media type
    let mediaType: "image" | "video" = "image";
    if (mediaTypeRaw === "image" || mediaTypeRaw === "video") {
      mediaType = mediaTypeRaw;
    } else if (!mediaTypeRaw && videoUrl && !imageUrl) {
      mediaType = "video";
    }

    const mediaUrl =
      imageUrl ??
      videoUrl ??
      publicUrl ??
      null;

    // Need *some* actual media
    if (!mediaUrl && !mediaBase64) {
      console.error("media-ingest: no media URL or base64 found in body");
      return new Response(
        JSON.stringify({
          error: "no_media_found",
          message:
            "One of image_url, video_url, public_url, or media_base64/base64_snippet is required",
          body_keys: Object.keys(body || {}),
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const mimeType =
      mimeTypeBody ??
      (mediaType === "image" ? "image/jpeg" : "video/mp4");

    console.log("📸 media-ingest called", {
      user_id: userId,
      media_type: mediaType,
      hasUrl: !!mediaUrl,
      hasBase64: !!mediaBase64,
      mimeType,
    });

    // 🔹 SIMPLE PATH FOR VIDEO (no Gemini for now)
    // You decided rich video understanding isn't worth the time tonight.
    // So for videos we return a gentle, fixed caption in the desired style.
    if (mediaType === "video") {
      const caption =
        "I see you captured a short video clip. When you have a moment, tell me what was happening and why this moment mattered to you.";

      return new Response(
        JSON.stringify({
          caption,
          media_type: mediaType,
          model: "static-video-caption",
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 🔹 IMAGE PATH (Gemini)

    // Prefer inline base64 (inlineData) whenever we have it.
    // Only fall back to fileUri if there is *no* base64.
    let mediaPart: any;
    if (mediaBase64) {
      console.log("📸 using inlineData (base64) for Gemini");
      mediaPart = {
        inlineData: {
          data: mediaBase64 as string,
          mimeType,
        },
      };
    } else if (mediaUrl) {
      console.log("📸 using fileData.fileUri for Gemini:", mediaUrl);
      mediaPart = {
        fileData: {
          fileUri: mediaUrl,
          mimeType,
        },
      };
    } else {
      console.error("media-ingest: reached no-media fallback for image");
      return new Response(
        JSON.stringify({
          error: "no_media_for_gemini",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const promptText =
      `You are helping someone build a personal memory archive.\n` +
      `They just shared a PHOTO.\n\n` +
      `Write ONE short paragraph (2–3 short sentences) that does BOTH of these things:\n` +
      `1) Briefly describe what you see in the photo: the main subject, the general setting, and the overall mood.\n` +
      `2) Then, in the same response, invite them to share more, with a gentle question like "Tell me about him", ` +
      `"Tell me about her", "Tell me about that day", or "I'd love to hear the story behind this.".\n\n` +
      `Guidelines:\n` +
      `- Use warm, conversational language.\n` +
      `- It's okay to start with "I see..." or "It looks like...".\n` +
      `- Do NOT guess exact names, precise locations, ages, or private information.\n` +
      `- Do NOT mention 'uploading' or refer to it as a file; just talk about the scene itself.\n`;

    const contents: any[] = [
      {
        role: "user",
        parts: [
          { text: promptText },
          mediaPart,
        ],
      },
    ];

    const genReq = { contents };

    const genUrl =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      "gemini-2.0-flash-exp:generateContent" +
      `?key=${GOOGLE_API_KEY}`;

    const gRes = await fetch(genUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(genReq),
    });

    if (!gRes.ok) {
      const errText = await gRes.text().catch(() => "");
      console.error("media-ingest: Gemini error", gRes.status, errText);

      return new Response(
        JSON.stringify({
          error: "gemini_api_error",
          status: gRes.status,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const gJson = await gRes.json();
    const caption = extractCaption(gJson);

    if (!caption) {
      console.warn("media-ingest: No caption extracted from Gemini response");
    }

    return new Response(
      JSON.stringify({
        caption,
        media_type: mediaType,
        model: "gemini-2.0-flash-exp",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("media-ingest: unexpected error", err);
    return new Response(
      JSON.stringify({
        error: "unexpected_server_error",
        message: String(err),
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
