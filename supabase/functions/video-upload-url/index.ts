// supabase/functions/video-upload-url/index.ts
//
// POST -> returns a Google Cloud Storage resumable upload URL.
// Body: { fileName: string, contentType?: string, contentLength?: number }
//
// Env vars used:
// - GOOGLE_SERVICE_ACCOUNT_JSON_B64 (preferred) OR GOOGLE_SERVICE_ACCOUNT_JSON (fallback)
// - GCS_BUCKET_NAME
// - SUPABASE_URL
// - SUPABASE_ANON_KEY
// Optional:
// - VIDEO_UPLOAD_DEBUG="true"  (logs safe fingerprints)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type ServiceAccount = {
  client_email: string;
  private_key: string;
};

function isDebug(): boolean {
  return (Deno.env.get("VIDEO_UPLOAD_DEBUG") ?? "").toLowerCase() === "true";
}

function decodeB64ToString(b64: string): string {
  // Robust base64 decode for large payloads; avoids atob quirks.
  const bytes = decodeBase64(b64);
  return new TextDecoder().decode(bytes);
}

function getServiceAccountJson(): string {
  const b64 = (Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON_B64") ?? "").trim();
  if (b64) {
    try {
      return decodeB64ToString(b64);
    } catch (e) {
      throw new Error(
        `GOOGLE_SERVICE_ACCOUNT_JSON_B64 decode failed: ${String(e)}`,
      );
    }
  }

  const raw = (Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") ?? "").trim();
  if (raw) return raw;

  throw new Error(
    "Missing GOOGLE_SERVICE_ACCOUNT_JSON_B64 or GOOGLE_SERVICE_ACCOUNT_JSON",
  );
}

function extractPkcs8DerFromPem(pem: string): Uint8Array {
  const normalized = String(pem).replace(/\r/g, "").trim();
  const body = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  if (!body) return new Uint8Array();

  try {
    const bytes = decodeBase64(body);
    return bytes;
  } catch {
    // If someone accidentally passed non-base64 content, bail clearly.
    return new Uint8Array();
  }
}

async function importPrivateKeyFromPem(pem: string): Promise<CryptoKey> {
  const der = extractPkcs8DerFromPem(pem);
  if (der.length === 0) {
    throw new Error(
      "Private key PEM could not be decoded to DER (0 bytes). " +
        "Check GOOGLE_SERVICE_ACCOUNT_JSON(_B64).private_key formatting.",
    );
  }

  return await crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function b64urlFromBytes(bytes: Uint8Array): string {
  // Convert bytes -> base64url without padding.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlJson(obj: unknown): string {
  return b64urlFromBytes(new TextEncoder().encode(JSON.stringify(obj)));
}

async function signRs256(key: CryptoKey, data: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(data),
  );
  return b64urlFromBytes(new Uint8Array(sig));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function createGoogleJwtAssertion(
  clientEmail: string,
  key: CryptoKey,
  scope: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encoded = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = await signRs256(key, encoded);
  return `${encoded}.${signature}`;
}

async function getAccessToken(scope: string): Promise<string> {
  const saJson = getServiceAccountJson();

  let client_email = "";
  let private_key = "";

  try {
    const parsed = JSON.parse(saJson) as ServiceAccount;
    client_email = parsed.client_email;
    private_key = parsed.private_key;
  } catch (e) {
    throw new Error(
      `Service account JSON parse failed: ${String(e)} (check GOOGLE_SERVICE_ACCOUNT_JSON(_B64))`,
    );
  }

  if (!client_email) throw new Error("Service account JSON missing client_email");
  if (!private_key) throw new Error("Service account JSON missing private_key");

  // Hard guard: avoids the empty-DER “e3b0…” trap.
  if (private_key.length < 500) {
    throw new Error(
      `private_key too short (len=${private_key.length}). Secret likely truncated/malformed.`,
    );
  }

  const der = extractPkcs8DerFromPem(private_key);
  if (der.length === 0) {
    throw new Error(
      "private_key PEM decoded to 0 bytes. Check newline/escaping or secret content.",
    );
  }

  if (isDebug()) {
    const fp = await sha256Hex(der);
    console.log("SA client_email:", client_email);
    console.log("SA key DER bytes:", der.length);
    console.log("SA key DER sha256:", fp.slice(0, 16));
  }

  const key = await crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const jwt = await createGoogleJwtAssertion(client_email, key, scope);

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Access token error ${res.status}: ${text}`);
  }

  const json = await res.json();
  const token = json?.access_token as string | undefined;
  if (!token) throw new Error("No access_token returned by Google token endpoint");
  return token;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const bucket = (Deno.env.get("GCS_BUCKET_NAME") ?? "").trim();
    if (!bucket) throw new Error("Missing GCS_BUCKET_NAME env var");

    const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").trim();
    const SUPABASE_ANON_KEY = (Deno.env.get("SUPABASE_ANON_KEY") ?? "").trim();
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY env var");
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return new Response("Unauthorized", { status: 401 });

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      console.error("Auth error:", userError);
      return new Response("Unauthorized", { status: 401 });
    }

    const body = await req.json();
    const fileName = String(body.fileName ?? "").trim();
    const contentType = String(body.contentType ?? "video/mp4").trim();
    const contentLength = body.contentLength as number | undefined;

    if (!fileName) return new Response("fileName is required", { status: 400 });

    const safeFileName = fileName.replace(/[^\w.\-]+/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const objectName = `user_${user.id}/${timestamp}_${safeFileName}`;

    // Access token for GCS read/write
    const accessToken = await getAccessToken(
      "https://www.googleapis.com/auth/devstorage.read_write",
    );

    // Start resumable upload session
    const initUrl =
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=resumable&name=${encodeURIComponent(objectName)}`;

    const headers: HeadersInit = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": contentType,
    };

    if (typeof contentLength === "number" && contentLength > 0) {
      headers["X-Upload-Content-Length"] = String(contentLength);
    }

    const initRes = await fetch(initUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });

    if (!initRes.ok) {
      const text = await initRes.text();
      console.error("GCS init error:", initRes.status, text);
      return new Response("Failed to init upload session", { status: 500 });
    }

    const uploadUrl = initRes.headers.get("Location");
    if (!uploadUrl) {
      console.error("No Location header from GCS init");
      return new Response("No upload URL from GCS", { status: 500 });
    }

    return new Response(
      JSON.stringify({ uploadUrl, objectName, bucket, contentType }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("video-upload-url error:", e);
    return new Response("Internal Server Error", { status: 500 });
  }
});
