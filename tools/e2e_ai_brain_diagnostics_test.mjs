import assert from "node:assert/strict";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SB_SECRET_KEY;
const AUTH = process.env.SUPABASE_AUTH_BEARER || "";

assert.ok(SUPABASE_URL, "Missing SUPABASE_URL env var");
assert.ok(ANON_KEY, "Missing SUPABASE_ANON_KEY env var");

const url = `${SUPABASE_URL}/functions/v1/ai-brain`;

const headers = {
  "Content-Type": "application/json",
  apikey: ANON_KEY,
  // Optional: if you have a real user JWT, set SUPABASE_AUTH_BEARER="Bearer <jwt>"
  ...(AUTH ? { Authorization: AUTH } : {}),
};

const user_id = process.env.E2E_USER_ID || null;
const resp = await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify({ diagnostic: true, user_id }),
});
const text = await resp.text();

assert.equal(resp.ok, true, `Diagnostics HTTP failed: ${resp.status} ${text}`);

let payload;
try {
  payload = JSON.parse(text);
} catch {
  throw new Error(`Diagnostics did not return JSON: ${text.slice(0, 800)}`);
}

console.log("BUILD STAMP:", payload.build_stamp);

// Accept multiple known shapes.
const results =
  (payload && Array.isArray(payload.results) && payload.results) ||
  (payload && Array.isArray(payload.checks) && payload.checks) ||
  (Array.isArray(payload) ? payload : null);

assert.ok(Array.isArray(results), `Unexpected diagnostics shape: ${text.slice(0, 800)}`);

const failed = results.filter((c) => c && c.ok === false);

if (failed.length) {
  console.error("❌ FAILED CHECKS:");
  for (const f of failed) {
    console.error(`- ${f.name ?? "(no name)"}: ${f.error ?? f.message ?? JSON.stringify(f)}`);
  }
}

assert.equal(failed.length, 0, `One or more diagnostics failed (${failed.length}). Top-level ok=${payload?.ok}`);

console.log("✅ ai-brain diagnostics all passed");
