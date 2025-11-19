// supabase/functions/ai-brain/index.ts
//
// Minimal "brain" function using Gemini.
// - Accepts JSON: { user_id, message, parent_id? }
// - Calls Gemini
// - Returns JSON: { reply, user_id, parent_id, created_at }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const MODEL = "models/gemini-2.0-flash-exp";

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

    // Minimal validation – user_id + non-empty message required
    if (!user_id || !message.trim()) {
      return jsonResponse(
        { error: "user_id and message are required" },
        400,
      );
    }

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      // Clear, explicit error if env var not set
      return jsonResponse(
        { error: "GEMINI_API_KEY is not configured on the server" },
        500,
      );
    }

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
              parts: [{ text: message }],
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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
