import assert from "node:assert/strict";

function normalizeFactsTopLevel(outRaw) {
  const tryParseJsonLoose = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const normalizeTopLevel = (obj) => {
    if (!obj || typeof obj !== "object") return obj;

    if (Array.isArray(obj.fact_candidates)) {
      const { facts, ...rest } = obj;
      return rest;
    }

    if (Array.isArray(obj.facts)) {
      const { facts, ...rest } = obj;
      return { ...rest, fact_candidates: facts };
    }

    return obj;
  };

  const parsed = typeof outRaw === "string" ? (tryParseJsonLoose(outRaw) ?? null) : outRaw;
  const normalized = normalizeTopLevel(parsed) ?? { fact_candidates: [] };
  return {
    fact_candidates: Array.isArray(normalized.fact_candidates) ? normalized.fact_candidates : [],
  };
}

// ---- tests ----

{
  const out = normalizeFactsTopLevel({ facts: [{ fact_key: "identity.full_name", value_json: "X" }] });
  assert.equal(out.fact_candidates.length, 1);
  assert.equal(out.fact_candidates[0].fact_key, "identity.full_name");
}

{
  const out = normalizeFactsTopLevel({
    facts: [{ fact_key: "identity.full_name", value_json: "WRONG" }],
    fact_candidates: [{ fact_key: "identity.full_name", value_json: "RIGHT" }],
  });
  assert.equal(out.fact_candidates.length, 1);
  assert.equal(out.fact_candidates[0].value_json, "RIGHT");
}

{
  const out = normalizeFactsTopLevel(
    JSON.stringify({ facts: [{ fact_key: "preferences.food", value_json: "thai" }] }),
  );
  assert.equal(out.fact_candidates.length, 1);
  assert.equal(out.fact_candidates[0].fact_key, "preferences.food");
}

console.log("✅ end_session fact_candidates normalization tests passed");
