// supabase/functions/ai-brain/index.ts
//
// Minimal "brain" function:
// - Accepts JSON: { user_id, message, parent_id? }
// - Calls Gemini
// - Returns JSON: { reply, user_id, parent_id, created_at }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type BrainRequest = {
  user_id: string;
  message: string;
  parent_id?: string | null;
};

type BrainResponse = {
  reply: string;
  user_id: string;
  parent_id: string | null;
  created_at: string;
};

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    // Basic preflight handler (mostly useful for web clients)
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed" },
      405
    );
  }

  try {
    const body = (await req.json()) as BrainRequest;

    if (!body.user_id || !body.message) {
      return jsonResponse(
        { error: "user_id and message are required" },
        400
      );
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return jsonResponse(
        { error: "GEMINI_API_KEY is not configured on the server" },
        500
      );
    }

    // Call Gemini (v1beta) - adjust model name if needed
    const geminiRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=" +
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
              parts: [{ text: body.message }],
            },
          ],
        }),
      }
    );

    if (!geminiRes.ok) {
      const errorText = await geminiRes.text();
      console.error("Gemini error:", errorText);

      return jsonResponse(
        { error: "Gemini API error", details: errorText },
        502
      );
    }

    const geminiJson = await geminiRes.json() as any;

    const reply =
      geminiJson?.candidates?.[0]?.content?.parts
        ?.map((p: any) => p.text || "")
        .join("\n")
        .trim() || "Sorry, I could not generate a reply.";

    const responsePayload: BrainResponse = {
      reply,
      user_id: body.user_id,
      parent_id: body.parent_id ?? null,
      created_at: new Date().toISOString(),
    };

    return jsonResponse(responsePayload, 200);
  } catch (err) {
    console.error("ai-brain function error:", err);

    return jsonResponse(
      { error: "Server error", details: String(err) },
      500
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
