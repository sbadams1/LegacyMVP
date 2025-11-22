// supabase/functions/speech-to-text/index.ts
//
// Edge Function: Google Cloud Speech-to-Text
// Input JSON:
// {
//   "user_id": "uuid",
//   "audio_base64": "....",  // base64 audio content
//   "mime_type": "audio/aac" | "audio/m4a" | "audio/mp4" | ...
// }
//
// Output on success:
// { "transcript": "recognized text here" }
//
// Output on error:
// { "error": "message" }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
    }

    let payload: any;
    try {
        payload = await req.json();
    } catch (err) {
        console.error("STT: invalid JSON", err);
        return jsonResponse({ error: "Invalid JSON" }, 400);
    }

    const { user_id, audio_base64, mime_type } = payload ?? {};

    if (!user_id || !audio_base64) {
        console.error("STT: missing user_id or audio_base64", payload);
        return jsonResponse(
            { error: "user_id and audio_base64 are required" },
            400,
        );
    }

    const apiKey = Deno.env.get("GOOGLE_SPEECH_API_KEY");
    if (!apiKey) {
        console.error("STT: GOOGLE_SPEECH_API_KEY not configured");
        return jsonResponse(
            { error: "GOOGLE_SPEECH_API_KEY is not configured" },
            500,
        );
    }

    // You can later make this dynamic using preferred_language from profiles.
    const languageCode = "en-US";

    // We let Google infer encoding from the content; we don't hard-code it to avoid mismatches.
    const sttRequestBody = {
        config: {
            languageCode,
            enableAutomaticPunctuation: true,
            sampleRateHertz: 48000,
            encoding: "MP3",
        },
        audio: {
            content: audio_base64,
        },
    };

    try {
        console.log("STT: calling Google Speech-to-Text", {
            mime_type,
            languageCode,
            user_id,
        });

        const resp = await fetch(
            `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(sttRequestBody),
            },
        );

        const text = await resp.text();

        if (!resp.ok) {
            console.error("STT: Google error", {
                status: resp.status,
                body: text,
            });
            return jsonResponse(
                {
                    error: "Google STT error",
                    google_status: resp.status,
                    google_body: text,
                },
                200, // keep 200 so Flutter still treats it as a handled response
            );
        }

        let result: any;
        try {
            result = JSON.parse(text);
        } catch (err) {
            console.error("STT: failed to parse Google JSON", err, text);
            return jsonResponse(
                {
                    error: "Failed to parse Google STT response",
                    raw: text,
                },
                200,
            );
        }

        const results = result.results ?? [];
        const transcripts: string[] = [];

        for (const r of results) {
            const alternatives = r.alternatives ?? [];
            if (alternatives.length > 0 && alternatives[0].transcript) {
                transcripts.push(alternatives[0].transcript as string);
            }
        }

        const finalTranscript = transcripts.join(" ").trim();
        console.log("STT: final transcript:", finalTranscript);

        if (!finalTranscript) {
            // No transcript – send a human-readable error instead of an empty string
            return jsonResponse(
                {
                    error: "No transcript returned by Google STT.",
                    google_raw: result,
                },
                200,
            );
        }

        return jsonResponse(
            { transcript: finalTranscript },
            200,
        );
    } catch (err) {
        console.error("STT: server error", err);
        return jsonResponse(
            { error: "Server error", details: String(err) },
            200,
        );
    }
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(
        JSON.stringify(body),
        {
            status,
            headers: { "Content-Type": "application/json" },
        },
    );
}
