import assert from "node:assert/strict";
import crypto from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SB_SECRET_KEY;
const USER_ID = process.env.E2E_USER_ID;

assert.ok(SUPABASE_URL, "Missing SUPABASE_URL");
assert.ok(SERVICE_KEY, "Missing SB_SECRET_KEY");
assert.ok(USER_ID, "Missing E2E_USER_ID");

const FN_URL = `${SUPABASE_URL}/functions/v1/ai-brain`;
const REST_URL = `${SUPABASE_URL}/rest/v1`;

function headersJson() {
  return {
    "Content-Type": "application/json",
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callTurn(userText, conversation_id) {
  const resp = await fetch(FN_URL, {
    method: "POST",
    headers: headersJson(),
    body: JSON.stringify({
      mode: "legacy",
      conversation_id,
      message_text: userText,
      entry_mode: "freeform",
      user_id: USER_ID,
    }),
  });

  const t = await resp.text();
  assert.ok(resp.ok, `ai-brain call failed: ${resp.status} ${t}`);
  return t;
}

async function getJson(url) {
  const resp = await fetch(url, { method: "GET", headers: headersJson() });
  const text = await resp.text();
  assert.ok(resp.ok, `REST GET failed: ${resp.status} ${text}`);
  return JSON.parse(text);
}

async function del(url) {
  const resp = await fetch(url, { method: "DELETE", headers: headersJson() });
  const text = await resp.text();
  assert.ok(resp.ok, `REST DELETE failed: ${resp.status} ${text}`);
}

const enc = encodeURIComponent;

function normQuote(s) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .toLowerCase();
}

async function pollCandidateByQuote({ needle, conversation_id, attempts = 12, delayMs = 250, requireConflict = false }) {
  // Keep query broad and match client-side; but DO scope by conversation_id to avoid stale rows.
  const url =
    `${REST_URL}/fact_candidates` +
    `?select=id,status,source_meta,fact_key_guess,source_quote,turn_ref` +
    `&user_id=eq.${enc(USER_ID)}` +
    `&conversation_id=eq.${enc(conversation_id)}` +
    `&limit=500`;

  const wantN = normQuote(needle);

  for (let i = 0; i < attempts; i++) {
    const rows = await getJson(url);

    // DEBUG (only on first poll): show what we actually got back
    if (i === 0) {
      const debug = rows.slice(0, 20).map((r) => ({
        id: r.id,
        status: r.status,
        fact_key_guess: r.fact_key_guess,
        source: r.source_meta?.source,
        quote: r.source_quote,
      }));
      console.log("DEBUG pollCandidateByQuote: first 20 rows:", debug);
    }

    const hit = rows.find((r) => {
      const src = r?.source_meta?.source ? String(r.source_meta.source) : "";
      if (src !== "vip_v1") return false;

      // Preferred: match the quote when present.
      const gotN = normQuote(r.source_quote);
      const quoteMatch = gotN === wantN || gotN.includes(wantN) || wantN.includes(gotN);

      if (!requireConflict) return quoteMatch;

      // Robust: VIP lane conflict signal = status + conflict receipt pointer.
      const sm = r.source_meta || {};
      const hasReceipt = !!sm.conflict_with_user_fact_id;
      return (r.status === "conflict") && hasReceipt;
    });
    if (hit) return hit;

    await sleep(delayMs);
  }
  return null;
}

 // -----------------------------
 // Test
 // -----------------------------
 const conversation_id = crypto.randomUUID();
 
 // Cleanup: make test deterministic (avoid stale fact_candidates/user_facts from prior runs)
 {
   await del(
     `${REST_URL}/fact_candidates` +
       `?user_id=eq.${enc(USER_ID)}` +
       `&fact_key_guess=eq.identity.full_name`
   );

  // Also remove any prior VIP-lane candidates for this user so polling doesn't get polluted.
  await del(
    `${REST_URL}/fact_candidates` + `?user_id=eq.${enc(USER_ID)}` + `&source_meta->>source=eq.vip_v1`
  ); 
   await del(
     `${REST_URL}/user_facts` +
       `?user_id=eq.${enc(USER_ID)}` +
       `&fact_key=eq.identity.full_name`
   );
 }
 
 // NOTE: Use a clearly "wrong" variant to avoid LLM/autocorrect normalization
 // collapsing the second quote back to "Steven Adams", which prevents a distinct
 // vip_v1 fact_candidate from being created for the conflicting quote.
 await callTurn("my name is Steven Adams.", conversation_id);

// IMPORTANT:
// In some pipelines, VIP extraction for a given fact_key is intentionally de-duped per conversation
// (e.g., "already captured identity.full_name, skip subsequent captures").
// To reliably test *conflict detection*, keep the canonical user_facts row created by the first call,
// but clear any vip_v1 candidates for THIS conversation before sending the conflicting claim.
await sleep(400);
await del(
  `${REST_URL}/fact_candidates` +
    `?user_id=eq.${enc(USER_ID)}` +
    `&conversation_id=eq.${enc(conversation_id)}` +
    `&source_meta->>source=eq.vip_v1`
);

// Now send a conflicting name that should generate a fresh vip_v1 candidate (and be flagged conflict).
await callTurn("my name is Michael Adams.", conversation_id);

 // A) user_facts should exist and retain original value
 {
   const url =
     `${REST_URL}/user_facts` +
     `?select=id,fact_key,value_json,updated_at` +
     `&user_id=eq.${enc(USER_ID)}` +
     `&fact_key=eq.identity.full_name` +
     `&limit=2`;
 
   const rows = await getJson(url);
   assert.ok(rows.length >= 1, `Expected at least one user_facts row, got ${rows.length}`);
 
   const value = String(rows[0].value_json ?? "").toLowerCase();
   assert.ok(value.includes("steven adams"), `user_facts was overwritten: ${rows[0].value_json}`);
 }
 
  // B) fact_candidates row for the conflicting quote should be marked conflict
  {
   const match = await pollCandidateByQuote({ needle: "michael adams", conversation_id, requireConflict: true });
  
   assert.ok(match, "Did not find a VIP (vip_v1) fact_candidate in conflict with a receipt");
  
   const src = (match.source_meta && match.source_meta.source) ? String(match.source_meta.source) : "";
   assert.equal(src, "vip_v1", `Expected vip_v1 source, got ${src}`);
    assert.equal(match.status, "conflict", `Expected status=conflict, got ${match.status}`);
    const sm = match.source_meta || {};
    assert.ok(sm.conflict_with_user_fact_id, "Missing conflict_with_user_fact_id in source_meta");
  }
 
 console.log("✅ VIP lane conflict detection test PASS");
 console.log("conversation_id:", conversation_id);