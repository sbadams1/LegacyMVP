// supabase/functions/grandpa-chat/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is not set");
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { prompt } = await req.json() as { prompt?: string };

    if (!prompt) {
      return new Response(
        JSON.stringify({ error: "Missing 'prompt' in body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const geminiRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=" +
        GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
        }),
      },
    );

    if (!geminiRes.ok) {
      const msg = await geminiRes.text();
      console.error("Gemini error:", geminiRes.status, msg);
      return new Response(
        JSON.stringify({ error: "Gemini API error", detail: msg }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const data = await geminiRes.json();

    const replyText =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ??
      "Sorry, I couldn't think of a reply.";

    return new Response(JSON.stringify({ reply: replyText }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Function error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
