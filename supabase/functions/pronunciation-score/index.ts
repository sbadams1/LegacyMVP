// supabase/functions/pronunciation-score/index.ts
//
// Input:
// {
//   "user_id": "<uuid>",
//   "audio_base64": "<base64 audio>",
//   "mime_type": "audio/aac",
//   "language_code": "th-TH",
//   "expected_text": "สวัสดีครับ",
//   "debug": true (optional)
// }
//
// Output: 200 OK
// {
//   "transcript": "สวัสดีครับ",
//   "expected_text": "สวัสดีครับ",
//   "normalized_transcript": "...",
//   "normalized_expected": "...",
//   "similarity_score": 0.94,
//   "pronunciation_score": 0.94,
//   "is_acceptable": true
// }
//
// The client can then write pronunciation_score into vocab_progress.last_score.


import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// -----------------------------------------------------------------------------
// Utility: normalize strings for similarity
// -----------------------------------------------------------------------------

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFC")
    // Strip obvious control / punctuation that shouldn't affect pronunciation
    .replace(/[\*\_\/\.\,\!\?\(\)\[\]\{\}"'`~]/g, "")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

// Levenshtein distance (dynamic programming)
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return dp[m][n];
}

// Convert distance to similarity score in [0,1]
function similarityScore(a: string, b: string): number {
  if (!a && !b) return 1.0;
  if (!a || !b) return 0.0;

  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  const sim = 1 - dist / maxLen;
  return Math.max(0, Math.min(1, sim));
}

// -----------------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------------

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const userId = body.user_id as string | undefined;
    const audioBase64 = body.audio_base64 as string | undefined;
    const mimeType = (body.mime_type as string | undefined) ?? "audio/aac";
    const languageCode = (body.language_code as string | undefined) ?? "th-TH";
    const expectedText = body.expected_text as string | undefined;
    const debug = !!body.debug;

    if (!userId || !audioBase64 || !expectedText) {
      return new Response(
        JSON.stringify({
          error:
            "user_id, audio_base64, and expected_text are required fields."
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Optional: check that user exists
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", userId)
      .maybeSingle();

    if (profileError) {
      console.error("Profile lookup error:", profileError);
    }
    if (!profile) {
      return new Response(
        JSON.stringify({ error: "User not found in profiles." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // -----------------------------------------------------------------------
    // 1) Call your existing 'speech-to-text' function to get transcript
    // -----------------------------------------------------------------------

    const sttUrl = `${supabaseUrl}/functions/v1/speech-to-text`;
    const sttPayload = {
      user_id: userId,
      audio_base64: audioBase64,
      mime_type: mimeType,
      language_code: languageCode
    };

    const sttResp = await fetch(sttUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Functions accept Bearer token as authorization header
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey
      },
      body: JSON.stringify(sttPayload)
    });

    if (!sttResp.ok) {
      const text = await sttResp.text();
      console.error("speech-to-text error:", sttResp.status, text);
      return new Response(
        JSON.stringify({
          error: "speech-to-text call failed",
          status: sttResp.status,
          details: debug ? text : undefined
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const sttData = await sttResp.json();
    if (sttData.error) {
      console.error("speech-to-text returned error:", sttData.error);
      return new Response(
        JSON.stringify({ error: "STT error", details: sttData.error }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const transcriptRaw = (sttData.transcript as string | undefined) ?? "";
    const transcript = transcriptRaw.trim();

    if (!transcript) {
      return new Response(
        JSON.stringify({
          error: "No transcript returned from speech-to-text."
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // -----------------------------------------------------------------------
    // 2) Compute normalized similarity between transcript & expected_text
    // -----------------------------------------------------------------------

    const normalizedTranscript = normalize(transcript);
    const normalizedExpected = normalize(expectedText);

    const sim = similarityScore(normalizedTranscript, normalizedExpected);
    const pronunciationScore = sim; // for now 1:1 mapping

    // You can tune threshold later
    const isAcceptable = pronunciationScore >= 0.8;

    const responsePayload = {
      transcript,
      expected_text: expectedText,
      normalized_transcript: normalizedTranscript,
      normalized_expected: normalizedExpected,
      similarity_score: sim,
      pronunciation_score: pronunciationScore,
      is_acceptable: isAcceptable,
      debug: debug ? { stt_raw: sttData } : undefined
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    console.error("pronunciation-score exception:", e);
    return new Response(
      JSON.stringify({
        error: "pronunciation-score failed",
        details: `${e}`
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
