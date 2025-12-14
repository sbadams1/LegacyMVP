// supabase/functions/_shared/googleAuth.ts
// Helper for exchanging a service account JWT for a Google OAuth2 access token
// Works in Supabase Edge Functions (Deno runtime).

let cachedAccessToken: string | null = null;
let cachedExpiryEpochSeconds = 0;

export async function getGoogleAccessToken(
  scopes: string[] = ["https://www.googleapis.com/auth/cloud-platform"],
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // Use cached token if still valid (with a 60s safety buffer).
  if (cachedAccessToken && now < cachedExpiryEpochSeconds - 60) {
    return cachedAccessToken;
  }

  const saJson = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!saJson) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not set in Edge Function secrets.",
    );
  }

  let sa;
  try {
    sa = JSON.parse(saJson);
  } catch (err) {
    console.error("Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON", err);
    throw new Error("Invalid GOOGLE_SERVICE_ACCOUNT_JSON (not valid JSON).");
  }

  const clientEmail: string = sa.client_email;
  const privateKeyPem: string = sa.private_key;
  if (!clientEmail || !privateKeyPem) {
    throw new Error(
      "Service account JSON must contain client_email and private_key.",
    );
  }

  const tokenEndpoint = "https://oauth2.googleapis.com/token";
  const scopeStr = scopes.join(" ");

  const nowSec = now;
  const iat = nowSec;
  const exp = nowSec + 3600; // 1 hour

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    scope: scopeStr,
    aud: tokenEndpoint,
    iat,
    exp,
  };

  const encoder = new TextEncoder();

  const encodedHeader = base64UrlEncode(
    encoder.encode(JSON.stringify(header)),
  );
  const encodedPayload = base64UrlEncode(
    encoder.encode(JSON.stringify(payload)),
  );
  const unsignedJwt = `${encodedHeader}.${encodedPayload}`;

  const privateKey = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    encoder.encode(unsignedJwt),
  );
  const encodedSignature = base64UrlEncode(new Uint8Array(signature));

  const signedJwt = `${unsignedJwt}.${encodedSignature}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: signedJwt,
  });

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Error fetching Google access token:", res.status, text);
    throw new Error(
      `Failed to obtain Google access token: ${res.status} ${res.statusText}`,
    );
  }

  const json = await res.json() as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  cachedAccessToken = json.access_token;
  cachedExpiryEpochSeconds = nowSec + (json.expires_in ?? 3600);

  return cachedAccessToken!;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemClean = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  const binaryDerString = atob(pemClean);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) {
    binaryDer[i] = binaryDerString.charCodeAt(i);
  }

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

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
