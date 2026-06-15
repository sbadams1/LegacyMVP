// supabase/functions/ai-brain/pipelines/shared_facts_extractor.ts

export type SharedFactsExtractorArgs = {
  transcriptText?: string;
  receipt_id?: string;
  preferred_locale?: string;

  // legacy-compatible inputs
  transcript?: Array<{ role: string; content: string; id?: string }>;
  anchorRawId?: string;
  userId?: string;

  invokeModel: (args: {
    system: string;
    user: string;
    temperature: number;
    maxOutputTokens: number;
    responseMimeType?: string | null;
  }) => Promise<string>;
};

function buildFactsSystemPrompt(): string {
  return [
    "You extract durable user facts stated explicitly by the USER in THIS session.",
    "Do NOT guess or infer. If it's not explicitly stated, omit it.",
    "Return ONLY valid JSON (no markdown fences, no prose, no commentary).",
    "Return MINIFIED JSON on a single line (no newlines, no indentation).",

    "Top-level JSON must be exactly: { \"fact_candidates\": [ ... ] }",
    "Return at most 16 fact_candidates total.",
    "Each candidate must include exactly these fields: subject, attribute_path, value_json, value_type, stability, change_policy, confidence, evidence, context.",
    "Do not include any additional top-level keys or candidate fields.",

    "subject must be an object: { \"type\": \"user|person\", \"name\": \"<optional>\" }.",
    "Use subject.type=\"user\" for the USER.",
    "Use subject.type=\"person\" for any other person mentioned (daughter/son/spouse/partner/parent/sibling/friend/colleague).",
    "If subject.type=\"person\", include subject.name when explicitly stated (e.g., \"Alicia\"). Otherwise omit name.",

    "attribute_path must be a short lowercase dot-path using these namespaces only: identity.*, location.*, health.*, preferences.*, work.*, projects.*, relationships.*, beliefs.*, views.*",
    "Subject rule: identity.*, location.*, health.*, preferences.*, work.*, projects.* MUST be used only when subject.type=\"user\".",
    "If the statement is about another person, use relationships.* (and subject.type=\"person\").",
    "Do NOT store someone else's education, job, or health under the user namespaces. Example: a daughter's doctorate goes under relationships.education.*, not health.*.",
    "health.* is only for the USER's health/fitness/medical/metrics.",

    "attribute_path must describe a durable fact (not a momentary feeling, not a question, not a one-off plan unless it's committed/ongoing).",
    "IMPORTANT: If the USER explicitly says they are building/creating/developing an app or working on an ongoing project, treat that as committed/ongoing and extract it under projects.*.",
    "If an app/project name is explicitly stated, store it as projects.current_app_name (string).",
    "IMPORTANT: Personal organization habits, commonly used items, and consistent object properties are durable user facts and MUST be extracted under preferences.*.",
    "Example: if the user says 'my passport folder is burnt orange', extract it as preferences.objects.passport_folder.color with value_json 'burnt orange'.",
    "Example: if the user says they use that folder for travel documents, extract preferences.objects.passport_folder.purpose with value_json 'travel documents' when explicitly stated.",
    "Do NOT omit explicit object-property facts just because they are not identity/work/health facts.",
    "Returning zero fact_candidates when explicit durable object facts are present is incorrect.",
    "If the USER explicitly states the purpose/reason, store it as projects.current_app_purpose (string).",
    "If projects.* is explicitly present in the session, include at least ONE projects.* fact even if you must omit lower-value details (e.g., job grade).",
    "Use views.* for durable stances/opinions/values about ANY topic (including politics).",
    "A strongly stated view the user affirms as deeply held is NOT a momentary feeling; treat it as durable.",
    "External-world facts (e.g., court outcomes) MUST NOT be stored as objective truth. If the user references a public fact, store only that the USER referenced it under beliefs.public_fact_refs.* with receipts.",
    "If the user explicitly distinguishes 'my view' vs 'a public fact I referenced', you may store BOTH (views.* and beliefs.public_fact_refs.*).",
    "If a fact is redundant (e.g., age implied by date_of_birth), keep the more durable one and omit duplicates unless both are explicitly stated.",

    "value_json must be valid JSON and must not be empty (no empty string, {}, or []).",
    "value_type must be exactly one of: string | number | boolean | array | object, and must match value_json.",
    "Prefer simple scalar values when possible (string/number/boolean). Use object only when it materially adds structure.",

    "stability must be exactly one of: sticky | semi_sticky | mutable.",
    "change_policy must be exactly one of: overwrite_if_explicit_or_newer | overwrite_if_explicit | append_only | never_overwrite.",

    "evidence must be an array with exactly 1 item: { receipt_id, quote }.",
    "If SESSION_USER_TEXT includes markers like [RID:<id>], set evidence[0].receipt_id to the RID of the exact line you quoted.",
    "If no [RID:...] marker is present for your quote, use RECEIPT_ID_FOR_EVIDENCE as evidence[0].receipt_id.",
    "evidence.quote must be a direct short quote from SESSION_USER_TEXT, max 120 characters, no ellipses.",
    "context must be read-aloud safe and neutral, max 80 characters (1 short sentence).",

    "confidence must be a number from 0 to 1.",
    "Use 0.90+ only for clear explicit statements with unambiguous wording.",
    "If any required field cannot be filled from explicit text, omit that candidate entirely.",

    "If there are no valid facts, return: {\"fact_candidates\":[]}",
  ].join(" ");
}

function sanitizeFactsTranscriptText(raw: string): string {
  const lines = String(raw ?? "").split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const s = String(line ?? "").trim();
    if (!s) continue;
    const lower = s.toLowerCase();
    if (lower.startsWith("ai:")) continue;
    if (lower.startsWith("assistant:")) continue;
    if (lower.startsWith("legacy_ai:")) continue;
    if (lower.startsWith("user:")) {
      kept.push(s.slice(5).trim());
      continue;
    }
    if (lower.startsWith("legacy_user:")) {
      kept.push(s.slice("legacy_user:".length).trim());
      continue;
    }
    kept.push(s);
  }
  return kept.join("\n").trim();
}

function tryParseJsonLoose(text: string): any | null {
  if (!text) return null;

  const sanitize = (s: string): string => {
    let out = String(s ?? "");
    const fenceMatch = out.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch && fenceMatch[1]) out = fenceMatch[1];
    out = out.replace(/^\uFEFF/, "").trim();
    out = out.replace(/,\s*([}\]])/g, "$1");
    return out;
  };

  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  const cleaned = sanitize(text);

  try {
    return JSON.parse(cleaned);
  } catch {
    // continue
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = sanitize(cleaned.slice(start, end + 1));
    try {
      return JSON.parse(slice);
    } catch {
      return null;
    }
  }

  return null;
}

function detectType(v: any): "string" | "number" | "boolean" | "array" | "object" {
  if (Array.isArray(v)) return "array";
  if (v === null) return "object";
  switch (typeof v) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

function isEmptyValue(v: any): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

function normPath(p: string): string {
  return String(p ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normKey(k: string): string {
  return String(k ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeSubject(s: any): { type: "user" | "person"; name?: string } | null {
  if (!s || typeof s !== "object") return null;
  const t = String((s as any)?.type ?? "").trim().toLowerCase();
  const type = t === "person" ? "person" : (t === "user" ? "user" : "");
  if (!type) return null;
  const nameRaw = String((s as any)?.name ?? "").trim();
  const name = nameRaw ? nameRaw.slice(0, 80) : "";
  return name ? { type: type as any, name } : { type: type as any };
}

export async function extractUserFactsWithGeminiShared(
  args: SharedFactsExtractorArgs,
): Promise<any> {
  try {
    const userText =
      typeof args.transcriptText === "string" && args.transcriptText.trim().length > 0
        ? sanitizeFactsTranscriptText(args.transcriptText)
        : (args.transcript || [])
            .filter((t) => {
              const r = String((t as any)?.role ?? "");
              return r === "user" || r === "legacy_user";
            })
            .map((t) => t?.content ?? "")
            .join("\n");

    const receiptId =
      (typeof args.receipt_id === "string" && args.receipt_id.trim()) ||
      (typeof args.anchorRawId === "string" && args.anchorRawId.trim()) ||
      "unknown_receipt";

    const preferredLocale =
      (typeof args.preferred_locale === "string" && args.preferred_locale.trim()) || "en";

    const userPrompt = [
      "SESSION_USER_TEXT:",
      userText,
      "",
      "RECEIPT_ID_FOR_EVIDENCE (use only if no [RID:...] marker is available):",
      receiptId,
      "",
      "preferred_locale:",
      preferredLocale,
      "",
      "Return only JSON.",
    ].join("\n");

    const rawStr = String(
      await args.invokeModel({
        system: buildFactsSystemPrompt(),
        user: userPrompt,
        temperature: 0.2,
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
      }),
    );

    const parsed: any = tryParseJsonLoose(rawStr) ?? {};
    const candidatesRaw: any[] = Array.isArray(parsed?.fact_candidates)
      ? parsed.fact_candidates
      : (Array.isArray(parsed?.facts) ? parsed.facts : []);

    const out: any[] = [];
    const seen = new Set<string>();

    for (const c of candidatesRaw) {
      const fact_key_raw = typeof c?.fact_key === "string" ? normKey(c.fact_key) : "";
      const subject = normalizeSubject(c?.subject);
      const attribute_path = normPath(c?.attribute_path ?? c?.attributePath ?? c?.path);

      if (!fact_key_raw && (!subject || !attribute_path)) continue;

      const dedupeKey = fact_key_raw || `${subject?.type ?? ""}:${subject?.name ?? ""}:${attribute_path}`;
      if (!dedupeKey || seen.has(dedupeKey)) continue;

      const value_json = c?.value_json;
      if (isEmptyValue(value_json)) continue;

      const value_type = (String(c?.value_type || detectType(value_json)).toLowerCase() as any) || "object";

      const stabilityRaw = String(c?.stability ?? "").toLowerCase();
      const stability =
        stabilityRaw === "sticky" || stabilityRaw === "mutable" || stabilityRaw === "semi_sticky"
          ? stabilityRaw
          : "semi_sticky";

      const policyRaw = String(c?.change_policy ?? "").toLowerCase();
      const change_policy =
        policyRaw === "overwrite_if_explicit_or_newer" ||
        policyRaw === "overwrite_if_explicit" ||
        policyRaw === "append_only" ||
        policyRaw === "never_overwrite"
          ? policyRaw
          : "overwrite_if_explicit_or_newer";

      const confidenceNum = Number(c?.confidence);
      const confidence = Number.isFinite(confidenceNum) ? Math.max(0, Math.min(1, confidenceNum)) : 0.75;

      const context = String(c?.context ?? "").trim();

      let evidence: any[] = Array.isArray(c?.evidence) ? c.evidence : [];
      if (evidence.length === 0) {
        const quote = String(c?.receipt_quote ?? c?.quote ?? "").trim();
        evidence = [{ receipt_id: receiptId, quote }];
      }
      evidence = evidence
        .map((e) => ({
          receipt_id: String(e?.receipt_id ?? receiptId).trim() || receiptId,
          quote: String(e?.quote ?? "").trim(),
        }))
        .filter((e) => e.receipt_id && e.quote)
        .slice(0, 1);

      if (evidence.length === 0) continue;

      out.push({
        ...(fact_key_raw ? { fact_key: fact_key_raw } : {}),
        ...(subject ? { subject } : {}),
        ...(attribute_path ? { attribute_path } : {}),
        value_json,
        value_type,
        stability,
        change_policy,
        confidence,
        evidence,
        context,
      });

      seen.add(dedupeKey);
      if (out.length >= 15) break;
    }

    return { fact_candidates: out, facts: out, raw_text: rawStr };
  } catch (e) {
    console.error("extractUserFactsWithGeminiShared: unexpected error", e);
    return { fact_candidates: [], facts: [], raw_text: "" };
  }
}