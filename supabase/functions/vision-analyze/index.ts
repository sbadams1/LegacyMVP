// supabase/functions/vision-analyze/index.ts
//
// Google Cloud Vision proxy for Legacy app.
//
// Usage (from Flutter):
//   supabase.functions.invoke('vision-analyze', body: {
//     image_base64: '...'
//   });
//
// Response (simplified):
//   {
//     labels: [{ description, score }],
//     text: "full OCR text or null",
//     landmarks: [{ description, score }],
//     raw: { ...full Google annotation... }
//   }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async (req: Request): Promise<Response> => {
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
    const body = await req.json() as {
      image_base64?: string;
      maxLabels?: number;
    };

    const imageBase64 = body.image_base64;
    if (!imageBase64) {
      return jsonResponse({ error: "image_base64 is required" }, 200);
    }

    // Reuse your existing Google API key (same project)
    const apiKey =
      Deno.env.get("GOOGLE_VISION_API_KEY") ??
      Deno.env.get("GOOGLE_SPEECH_API_KEY") ??
      Deno.env.get("GOOGLE_TTS_API_KEY");

    if (!apiKey) {
      return jsonResponse(
        {
          error:
            "Google API key not found. Set GOOGLE_VISION_API_KEY or reuse GOOGLE_SPEECH_API_KEY/GOOGLE_TTS_API_KEY.",
        },
        200,
      );
    }

    const maxLabels = body.maxLabels ?? 10;

    const visionReq = {
      requests: [
        {
          image: { content: imageBase64 },
          features: [
            { type: "LABEL_DETECTION", maxResults: maxLabels },
            { type: "LANDMARK_DETECTION", maxResults: 5 },
            { type: "TEXT_DETECTION", maxResults: 5 },
          ],
        },
      ],
    };

    const vRes = await fetch(
      "https://vision.googleapis.com/v1/images:annotate?key=" + apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(visionReq),
      },
    );

    const textRes = await vRes.text();
    let json: any;
    try {
      json = JSON.parse(textRes);
    } catch {
      json = textRes;
    }

    if (!vRes.ok) {
      console.error("Google Vision error:", vRes.status, textRes);
      return jsonResponse(
        {
          error: "Google Vision error",
          details: `HTTP ${vRes.status}`,
          googleError: json,
        },
        200,
      );
    }

    const responses = (json as any).responses ?? [];
    const annotation = responses[0] ?? {};

    const labels = (annotation.labelAnnotations ?? []).map((l: any) => ({
      description: l.description,
      score: l.score,
    }));

    const landmarks = (annotation.landmarkAnnotations ?? []).map((l: any) => ({
      description: l.description,
      score: l.score,
    }));

    const fullText = annotation.fullTextAnnotation?.text ?? null;

    return jsonResponse({
      labels,
      landmarks,
      text: fullText,
      raw: annotation,
    }, 200);
  } catch (err) {
    console.error("vision-analyze function error:", err);
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
