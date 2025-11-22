// supabase/functions/image-describe/index.ts

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async (req) => {
  try {
    const { imageUrl } = await req.json();

    if (!imageUrl) {
      return new Response(
        JSON.stringify({ error: "imageUrl is required" }),
        { status: 400 },
      );
    }

    const prompt = `
You are an AI helper inside a legacy preservation app.
The user has just uploaded a photo.

Write EXACTLY ONE short, warm sentence.
- Start with: "I see you uploaded a photo..."
- Briefly imagine ONE meaningful detail about the scene (for example: it might capture a quiet moment, a joyful smile, a family gathering, or a place that matters).
- Do NOT mention that you cannot actually see the image.
- Do NOT guess specific names, dates, or locations.
- End the sentence with an inviting question like "Tell me more about this moment."

The image URL (for context only) is: ${imageUrl}
`;

    const apiKey = Deno.env.get("GEMINI_API_KEY");

    const geminiResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      },
    );

    const data = await geminiResp.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ??
      "I see you uploaded a photo that looks meaningful — tell me more about this moment.";

    return new Response(JSON.stringify({ text }), { status: 200 });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500 },
    );
  }
});
