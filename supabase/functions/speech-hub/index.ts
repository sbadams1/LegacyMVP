// supabase/functions/speech-hub/index.ts
// Edge Function: Speech hub for STT v2 + pronunciation scoring + Gemini feedback
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

interface SpeechHubRequest {
  mode?: "chat_transcript" | "pronunciation_eval";
  audio_base64: string;

  // Language hints
  preferred_locale?: string; // L1 (e.g. "en-US")
  target_locale?: string | null; // L2 (e.g. "th-TH")

  // For pronunciation_eval
  reference_text?: string;      // canonical L2 phrase
  l2_locale?: string | null;    // explicit L2 override if needed

  // Optional metadata
  user_id?: string;
  audio_mime_type?: string;
  transcript?: string;
  state_json?: unknown;
}

interface PronunciationScoresResponse {
  overall_score: number;
  word_scores: Record<string, number>;
  detected_locale?: string;
  feedback_l1?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

// -----------------------------------------------------------------------------
// 1) Service account JWT → OAuth2 access token
// -----------------------------------------------------------------------------

interface ServiceAccountJson {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let cachedToken:
  | {
      accessToken: string;
      expiry: number; // epoch seconds
    }
  | null = null;

function base64UrlEncode(data: Uint8Array): string {
  let str = "";
  for (let i = 0; i < data.length; i++) {
    str += String.fromCharCode(data[i]);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function utf8Encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\r?\n|\r/g, "");
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function getServiceAccount(): Promise<ServiceAccountJson> {
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not set in Edge Function Secrets.",
    );
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON", e);
    throw new Error("Invalid GOOGLE_SERVICE_ACCOUNT_JSON");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      "Service account JSON must contain client_email and private_key.",
    );
  }
  return parsed as ServiceAccountJson;
}

async function getGoogleAccessToken(): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);

  // If we already have a token that expires in >60s, reuse it.
  if (cachedToken && cachedToken.expiry > nowSec + 60) {
    return cachedToken.accessToken;
  }

  const sa = await getServiceAccount();
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const scope = "https://www.googleapis.com/auth/cloud-platform";

  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: tokenUri,
    scope,
    iat: nowSec,
    exp: nowSec + 3600, // 1 hour
  };

  const headerStr = JSON.stringify(header);
  const payloadStr = JSON.stringify(payload);

  const headerB64 = base64UrlEncode(utf8Encode(headerStr));
  const payloadB64 = base64UrlEncode(utf8Encode(payloadStr));
  const signingInput = `${headerB64}.${payloadB64}`;

  // Import private key and sign
  const keyData = pemToArrayBuffer(sa.private_key);

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const sigBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    utf8Encode(signingInput),
  );

  const signatureB64 = base64UrlEncode(new Uint8Array(sigBuffer));
  const jwtAssertion = `${signingInput}.${signatureB64}`;

  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.set("assertion", jwtAssertion);

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Failed to get OAuth2 token", res.status, text);
    throw new Error(
      `OAuth token request failed: ${res.status} – ${text.slice(0, 500)}`,
    );
  }

  const json = await res.json();
  const accessToken = json.access_token as string | undefined;
  const expiresIn = json.expires_in as number | undefined;

  if (!accessToken) {
    console.error("Missing access_token in OAuth2 response", json);
    throw new Error("No access_token in OAuth2 response");
  }

  const expiry = nowSec + (expiresIn ?? 3600);
  cachedToken = { accessToken, expiry };
  return accessToken;
}

// -----------------------------------------------------------------------------
// 2) STT v2 helpers
// -----------------------------------------------------------------------------

async function sttRecognizeV2(params: {
  projectId: string;
  location: string;
  audioBase64: string;
  languageCodes: string[];
}): Promise<any> {
  const { projectId, location, audioBase64, languageCodes } = params;

  const accessToken = await getGoogleAccessToken();

  const url =
    `https://speech.googleapis.com/v2/projects/${projectId}/locations/${location}/recognizers/_:recognize`;

  const body = {
    config: {
      autoDecodingConfig: {},
      languageCodes,
      model: "latest_long",
      features: {
        enableWordTimeOffsets: true,
        enableWordConfidence: true,
      },
    },
    content: audioBase64,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("STT v2 error", res.status, text);
    throw new Error(
      `STT v2 recognize failed: ${res.status} – ${text.slice(0, 500)}`,
    );
  }

  return await res.json();
}

function extractBestAlt(sttResponse: any): {
  transcript: string;
  languageCode?: string;
  words: { word: string; confidence?: number }[];
} {
  const result = sttResponse?.results?.[0];
  const alt = result?.alternatives?.[0];

  const transcript: string = alt?.transcript ?? "";
  const languageCode: string | undefined = result?.languageCode ??
    alt?.languageCode;
  const wordsRaw = alt?.words ?? [];

  const words = Array.isArray(wordsRaw)
    ? wordsRaw.map((w: any) => ({
      word: String(w.word ?? "").trim(),
      confidence: typeof w.confidence === "number" ? w.confidence : undefined,
    })).filter((w: any) => w.word.length > 0)
    : [];

  return { transcript, languageCode, words };
}

function normalizeToken(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[.,!?;:()\[\]"'“”‘’\-]/g, "")
    .trim();
}

// Simple pronunciation proxy based on STT word confidence
function buildPronunciationScores(params: {
  referenceText: string;
  sttTranscript: string;
  sttWords: { word: string; confidence?: number }[];
}): PronunciationScoresResponse {
  const { referenceText, sttTranscript, sttWords } = params;

  const refTokens = referenceText
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 0);

  const hypTokens = (sttWords.length > 0
    ? sttWords.map((w) => normalizeToken(w.word))
    : sttTranscript.split(/\s+/).map(normalizeToken)
  ).filter((t) => t.length > 0);

  const hypConfMap = new Map<string, number[]>();

  if (sttWords.length > 0) {
    for (const w of sttWords) {
      const t = normalizeToken(w.word);
      if (!t) continue;
      const arr = hypConfMap.get(t) ?? [];
      if (typeof w.confidence === "number") {
        arr.push(w.confidence);
      } else {
        arr.push(0.7);
      }
      hypConfMap.set(t, arr);
    }
  } else {
    for (const t of hypTokens) {
      const arr = hypConfMap.get(t) ?? [];
      arr.push(0.7);
      hypConfMap.set(t, arr);
    }
  }

  const wordScores: Record<string, number> = {};
  const allScores: number[] = [];

  for (const ref of refTokens) {
    const confs = hypConfMap.get(ref);
    let score: number;

    if (!confs || confs.length === 0) {
      score = 40;
    } else {
      const avg = confs.reduce((a, b) => a + b, 0) / confs.length;
      if (avg >= 0.9) score = 98;
      else if (avg >= 0.8) score = 90;
      else if (avg >= 0.7) score = 80;
      else if (avg >= 0.6) score = 70;
      else if (avg >= 0.5) score = 60;
      else score = 50;
    }

    wordScores[ref] = score;
    allScores.push(score);
  }

  const overall =
    allScores.length > 0
      ? allScores.reduce((a, b) => a + b, 0) / allScores.length
      : 0;

  return {
    overall_score: Math.round(overall),
    word_scores: wordScores,
  };
}

// -----------------------------------------------------------------------------
// 3) Gemini feedback helper (still uses GEMINI_API_KEY)
// -----------------------------------------------------------------------------

async function generateFeedbackL1(params: {
  referenceText: string;
  wordScores: Record<string, number>;
  learnerL1: string; // e.g. "en-US"
}): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    console.warn("GEMINI_API_KEY not set; returning no feedback.");
    return "";
  }

  const weakEntries = Object.entries(params.wordScores)
    .filter(([_, score]) => score < 70)
    .sort((a, b) => a[1] - b[1]);

  const weakSummary = weakEntries
    .map(([w, s]) => `${w}: ${s}/100`)
    .join(", ");

  const prompt = [
    `You are a friendly pronunciation coach for ${params.learnerL1}.`,
    `The learner just tried to say this target phrase in the L2 language:`,
    `"${params.referenceText}".`,
    ``,
    `Here are pronunciation scores for each word (0–100, higher is better):`,
    Object.entries(params.wordScores)
      .map(([w, s]) => `- ${w}: ${s}/100`)
      .join("\n"),
    weakEntries.length
      ? `The weakest words are: ${weakSummary}.`
      : `All words are quite strong.`,
    ``,
    `In ${
      params.learnerL1.startsWith("en") ? "English" : "the learner's L1"
    }, give one very short sentence of encouragement and, if there are weak words, name ONLY those words and suggest what to adjust (tongue position, length, ending consonant, tone, etc.).`,
    `Keep it under 2 sentences total. Do NOT show any phonetic spellings or IPA.`,
  ].join("\n");

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Gemini feedback error", res.status, text);
    return "";
  }

  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((p: any) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();

  return text;
}

// -----------------------------------------------------------------------------
// 4) Main handler
// -----------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
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

  let body: SpeechHubRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const {
    mode = "chat_transcript",
    audio_base64,
    preferred_locale,
    target_locale,
    reference_text,
    l2_locale,
  } = body;

  if (!audio_base64 || typeof audio_base64 !== "string") {
    return jsonResponse(
      { error: "audio_base64 is required and must be a base64 string." },
      400,
    );
  }

  const projectId = Deno.env.get("GCP_STT_PROJECT_ID");
  if (!projectId) {
    return jsonResponse(
      { error: "GCP_STT_PROJECT_ID env variable is not set." },
      500,
    );
  }

  const location = Deno.env.get("GCP_STT_LOCATION") ?? "global";

  try {
    if (mode === "pronunciation_eval") {
      if (!reference_text) {
        return jsonResponse(
          {
            error:
              "reference_text is required for pronunciation_eval mode.",
          },
          400,
        );
      }

      const l2 = l2_locale || target_locale || preferred_locale || "en-US";

      const sttJson = await sttRecognizeV2({
        projectId,
        location,
        audioBase64: audio_base64,
        languageCodes: [l2],
      });

      const { transcript, languageCode, words } = extractBestAlt(sttJson);

      const baseScores = buildPronunciationScores({
        referenceText: reference_text,
        sttTranscript: transcript,
        sttWords: words,
      });

      const learnerL1 = preferred_locale || "en-US";
      const feedback = await generateFeedbackL1({
        referenceText: reference_text,
        wordScores: baseScores.word_scores,
        learnerL1,
      });

      const response: PronunciationScoresResponse = {
        overall_score: baseScores.overall_score,
        word_scores: baseScores.word_scores,
        detected_locale: languageCode || l2,
        feedback_l1: feedback,
      };

      return jsonResponse(response, 200);
    }

    // Default: chat_transcript mode (multi-language STT)
    const l1 = preferred_locale || "en-US";
    const l2 = target_locale || l1;

    const languageCodes = l1 === l2 ? [l1] : [l1, l2];

    const sttJson = await sttRecognizeV2({
      projectId,
      location,
      audioBase64: audio_base64,
      languageCodes,
    });

    const { transcript, languageCode } = extractBestAlt(sttJson);

    return jsonResponse(
      {
        mode: "chat_transcript",
        transcript,
        detected_locale: languageCode || languageCodes[0],
      },
      200,
    );
  } catch (err) {
    console.error("speech-hub error:", err);
    return jsonResponse(
      { error: "speech-hub failed", details: String(err) },
      500,
    );
  }
});
