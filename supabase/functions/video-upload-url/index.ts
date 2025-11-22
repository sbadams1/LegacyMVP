// supabase/functions/video-upload-url/index.ts
//
// POST -> returns a GCS resumable upload URL
// Body: { fileName: string, contentType?: string, contentLength?: number }
//
// Uses:
// - GOOGLE_SERVICE_ACCOUNT_JSON (env)
// - GCS_BUCKET_NAME (env)
// - SUPABASE_URL, SUPABASE_ANON_KEY (env) to get current user

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { create } from "https://deno.land/x/djwt@v2.8/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------- Helpers for Google auth ----------

type ServiceAccount = {
  client_email: string;
  private_key: string;
};

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemHeader = "-----BEGIN PRIVATE KEY-----\n";
  const pemFooter = "-----END PRIVATE KEY-----\n";
  const pemContents = pem
    .replace(/\r/g, "")
    .substring(pemHeader.length, pem.length - pemFooter.length);

  const binaryDer = Uint8Array.from(
    atob(pemContents),
    (c) => c.charCodeAt(0),
  );

  return await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
}

async function getAccessToken(scope: string): Promise<string> {
  const saJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!saJson) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env var");
  }
  const { client_email, private_key } = JSON.parse(saJson) as ServiceAccount;

  const key = await importPrivateKey(private_key);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const jwt = await create(header, payload, key);

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
  return json.access_token as string;
}

// ---------- Main handler ----------

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const bucket = Deno.env.get("GCS_BUCKET_NAME");
    if (!bucket) {
      throw new Error("Missing GCS_BUCKET_NAME env var");
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const authHeader = req.headers.get("Authorization") ?? "";

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    // Get current user (for folder naming)
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
    const contentType = String(body.contentType ?? "video/mp4");
    const contentLength = body.contentLength as number | undefined;

    if (!fileName) {
      return new Response("fileName is required", { status: 400 });
    }

    // Build object name in GCS (folder per user)
    const safeFileName = fileName.replace(/[^\w\.\-]+/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const objectName = `user_${user.id}/${timestamp}_${safeFileName}`;

    // Get OAuth2 access token for GCS
    const accessToken = await getAccessToken(
      "https://www.googleapis.com/auth/devstorage.read_write",
    );

    // Start resumable upload session
    const initUrl =
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=resumable&name=${encodeURIComponent(objectName)}`;

    const headers: HeadersInit = {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": contentType,
    };
    if (typeof contentLength === "number" && contentLength > 0) {
      headers["X-Upload-Content-Length"] = String(contentLength);
    }

    const initRes = await fetch(initUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({}), // no extra metadata for now
    });

    if (!initRes.ok) {
      const text = await initRes.text();
      console.error("GCS init error:", initRes.status, text);
      return new Response("Failed to init upload session", { status: 500 });
    }

    const uploadUrl = initRes.headers.get("Location");
    if (!uploadUrl) {
      console.error("No Location header from GCS");
      return new Response("No upload URL from GCS", { status: 500 });
    }

    const responseBody = {
      uploadUrl,
      objectName,
      bucket,
      contentType,
    };

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("video-upload-url error:", e);
    return new Response("Internal Server Error", { status: 500 });
  }
});
