// supabase/functions/_shared/gemini.ts
// Shared Gemini invocation utilities for all edge functions.
// - Single source of truth for API key / model selection
// - Robust JSON extraction (handles ```json fences, leading prose, etc.)

export type GeminiConfig = {
  apiKey: string;
  model: string; // e.g. "models/gemini-2.0-flash-exp" or "gemini-1.5-flash"
};

export type GeminiResponse = {
  ok: boolean;
  status: number;
  text: string; // raw response body text
  json: any | null; // parsed JSON response (if possible)
};

const DEFAULT_GEMINI_MODEL = "models/gemini-2.0-flash-exp";

export function getGeminiConfig(overrides?: Partial<GeminiConfig>): GeminiConfig {
  const apiKey =
    overrides?.apiKey ??
    Deno.env.get("GEMINI_API_KEY") ??
    Deno.env.get("GEMINI_API_KEY_EDGE") ??
    "";

  const model =
    overrides?.model ??
    Deno.env.get("GEMINI_MODEL") ??
    DEFAULT_GEMINI_MODEL;

  if (!apiKey) {
    console.error("❌ GEMINI_API_KEY is NOT set (GEMINI_API_KEY or GEMINI_API_KEY_EDGE).");
  }

  return { apiKey, model };
}

function stripCodeFences(s: string): string {
  const t = (s ?? "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const m = t.match(fence);
  return m ? (m[1] ?? "").trim() : t;
}

/**
 * Attempt to find the first JSON object/array in a string.
 * This is defensive against Gemini sometimes returning brief prose before JSON.
 */
function extractFirstJsonLike(s: string): string | null {
  const text = stripCodeFences(s);

  const firstObj = text.indexOf("{");
  const firstArr = text.indexOf("[");
  if (firstObj === -1 && firstArr === -1) return null;

  let start = firstObj;
  let open = "{";
  let close = "}";
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    start = firstArr;
    open = "[";
    close = "]";
  }

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === "\"") {
        inStr = false;
      }
      continue;
    } else {
      if (ch === "\"") {
        inStr = true;
        continue;
      }
      if (ch === open) depth++;
      if (ch === close) depth--;
      if (depth === 0) {
        return text.slice(start, i + 1).trim();
      }
    }
  }
  return null;
}

export function parseJsonSafely<T = any>(s: string): T | null {
  const candidate = extractFirstJsonLike(s);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

export async function geminiGenerateContent(
  body: any,
  overrides?: Partial<GeminiConfig>,
  timeoutMs = 120000,
): Promise<GeminiResponse> {
  const { apiKey, model } = getGeminiConfig(overrides);

  const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    const text = await resp.text();
    let json: any | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    return { ok: resp.ok, status: resp.status, text, json };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, text: msg, json: null };
  } finally {
    clearTimeout(t);
  }
}

export function extractGeminiTextFromResponse(respJson: any): string {
  // v1beta shape: candidates[0].content.parts[].text
  try {
    const parts = respJson?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      return parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("").trim();
    }
  } catch {
    // ignore
  }
  return "";
}

export async function geminiGenerateText(
  prompt: string,
  overrides?: Partial<GeminiConfig>,
  timeoutMs = 120000,
): Promise<string> {
  const body = { contents: [{ role: "user", parts: [{ text: prompt }]}] };
  const resp = await geminiGenerateContent(body, overrides, timeoutMs);
  if (!resp.ok || !resp.json) return "";
  return extractGeminiTextFromResponse(resp.json);
}

export async function geminiGenerateJson<T = any>(
  prompt: string,
  overrides?: Partial<GeminiConfig>,
  timeoutMs = 120000,
): Promise<T | null> {
  const txt = await geminiGenerateText(prompt, overrides, timeoutMs);
  return parseJsonSafely<T>(txt);
}
