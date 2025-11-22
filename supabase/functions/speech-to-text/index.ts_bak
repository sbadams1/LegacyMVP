// supabase/functions/speech-to-text/index.ts
//
// Simple STT proxy:
//  - Reads GOOGLE_SPEECH_API_KEY from env (Supabase Vault / secrets)
//  - Calls Google Cloud Speech-to-Text REST API
//  - Returns { transcript } on success
//  - Returns { error, details, googleError } with status 200 on failure
//    so supabase.functions.invoke doesn't throw 502/400 at the client.

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
        return jsonResponse({ error: "Method not allowed" }, 200);
    }

    try {
        const body = await req.json() as {
            audio_base64?: string;
            mime_type?: string;
            sample_rate_hz?: number;
        };

        const audioBase64 = body.audio_base64 ?? "";
        const sampleRate = body.sample_rate_hz ?? 48000;

        if (!audioBase64) {
            return jsonResponse(
                { error: "audio_base64 is required" },
                200,
            );
        }

        const apiKey = Deno.env.get("GOOGLE_SPEECH_API_KEY");
        console.log("Using GOOGLE_SPEECH_API_KEY prefix:", apiKey?.substring(0, 10));

        if (!apiKey) {
            return jsonResponse(
                { error: "GOOGLE_SPEECH_API_KEY is not configured in Supabase" },
                200,
            );
        }

        // Build Google STT request using the "MP3 lie" that worked previously
        const sttReq = {
            config: {
                encoding: "MP3", // ✅ your original working hack
                languageCode: "en-US",
                sampleRateHertz: sampleRate,
                enableAutomaticPunctuation: true,
                model: "default",
            },
            audio: {
                content: audioBase64, // Already base64-encoded on the client
            },
        };

        const sttRes = await fetch(
            "https://speech.googleapis.com/v1/speech:recognize?key=" + apiKey,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(sttReq),
            },
        );

        const text = await sttRes.text();
        let sttJson: any = {};
        try {
            sttJson = JSON.parse(text);
        } catch {
            sttJson = text;
        }

        if (!sttRes.ok) {
            console.error("Google STT error:", sttRes.status, text);
            return jsonResponse(
                {
                    error: "Google STT error",
                    details: `HTTP ${sttRes.status}`,
                    googleError: sttJson,
                },
                200,
            );
        }

        let transcript = "";

        try {
            const results = (sttJson as any).results ?? [];
            for (const r of results) {
                const alternatives = r.alternatives ?? [];
                for (const alt of alternatives) {
                    if (typeof alt.transcript === "string") {
                        transcript += alt.transcript + " ";
                    }
                }
            }
        } catch (e) {
            console.error("Error parsing STT response:", e, sttJson);
            return jsonResponse(
                {
                    error: "Error parsing STT response",
                    details: String(e),
                    googleError: sttJson,
                },
                200,
            );
        }

        transcript = transcript.trim();

        return jsonResponse(
            { transcript },
            200,
        );
    } catch (err) {
        console.error("speech-to-text function error:", err);
        return jsonResponse(
            { error: "Server error", details: String(err) },
            200,
        );
    }
});

function jsonResponse(data: unknown, _status = 200): Response {
    // NOTE: we always send HTTP 200 back to Supabase client,
    // and encode errors inside the JSON body as { error, ... }.
    return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    });
}
