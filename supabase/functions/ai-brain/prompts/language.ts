// supabase/functions/ai-brain/prompts/language.ts
// Shared prompt builders for language-learning and related modes.
// Design goals:
// - Language-agnostic: never hard-code specific languages.
// - Deterministic: keep output parseable for UI/TTS (tagged lines).
// - Beginner-friendly: ensure plenty of L1 guidance at low levels.

function langCodeFromLocale(locale: string | null | undefined): string | null {
  if (!locale) return null;
  const cleaned = String(locale).trim().replaceAll("_", "-");
  if (!cleaned) return null;
  return cleaned.split("-")[0]?.toLowerCase() ?? null;
}

function displayLanguageName(
  langCode: string | null,
  displayLocale: string | null | undefined,
): string {
  if (!langCode) return "the target language";
  try {
    const uiLocale = (displayLocale && String(displayLocale).trim()) || "und";
    // Prefer the device/user UI locale if available; fall back to "und" (undetermined).
    // This keeps us language-agnostic while still generating human-readable labels when possible.
    // @ts-ignore Intl.DisplayNames exists in Deno runtime.
    const dn = new Intl.DisplayNames([uiLocale], { type: "language" });
    const name = dn.of(langCode);
    return name || langCode;
  } catch {
    return langCode;
  }
}

/**
 * Build the system prompt for language-learning conversations.
 * Signature matches pipelines/turn.ts call sites:
 *   buildLanguageLearningSystemPrompt(preferredLocale, targetLocale, learningLevel, ls, unit, lesson)
 */
export function buildLanguageLearningSystemPrompt(
  preferredLocale: string,
  targetLocale: string | null,
  learningLevel: string,
  ls: any,
  unit: any,
  lesson: any,
): string {
  const l1Code = langCodeFromLocale(preferredLocale);
  const l2Code = langCodeFromLocale(targetLocale);
  const l1Name = displayLanguageName(l1Code, preferredLocale);
  const l2Name = displayLanguageName(l2Code, preferredLocale);

  const lessonName = lesson?.lesson_name ?? lesson?.lessonName ?? "Lesson";
  const stage = ls?.stage ?? lesson?.default_stage ?? "intro";

  const lvl = String(learningLevel ?? "").trim().toLowerCase();
  const isBeginner =
    lvl.startsWith("begin") || lvl === "a1" || lvl === "novice" || lvl === "starter";

  // Core language policy: language-agnostic and driven by user settings.
  const l2Policy = targetLocale
    ? `Target-language practice: include short, correct ${l2Name} examples when helpful. Always provide explanations and guidance in ${l1Name} at the learner's level.`
    : `No target language (L2) is configured. Respond in ${l1Name} and ask one clear question to confirm the learner's target language (L2) setting.`;

  // Output contract keeps the UI/TTS predictable and reduces clutter (romanization/IPA).
  // IMPORTANT: Many TTS parsers are order-sensitive. Always interleave L1/L2 exactly as instructed.
  const outputContract = (isBeginner
    ? `
OUTPUT FORMAT (STRICT)
You MUST use these tags exactly on their own lines: [L1], [L2], [ROM], [META].
- [L1] = ${l1Name} (${l1Name} explanations, guidance, feedback)
- [L2] = ${l2Name} (${l2Name} practice phrases/sentences only)
- [ROM] = pronunciation/romanization/IPA ONLY (optional; ONLY if learner asked)
- [META] = internal notes for the app (rare; keep minimal)

BEGINNER START & SEQUENCING (VERY IMPORTANT FOR TTS)
- The FIRST line of EVERY Beginner reply must be [L1]. Do NOT open with any [L2] praise/intro.
- Use repeating 3-line blocks in this exact order:
  1) [L1] one short guidance sentence (what we are practicing)
  2) [L2] ONE short practice phrase/sentence
  3) [L1] ONE short meaning + what to say/do next
- Do NOT place multiple [L2] lines in a row (EVER). Every [L2] must be followed immediately by [L1].
- Do NOT place multiple [L1] lines in a row before a [L2] line (except ONE initial [L1] line starting the first block).

ROMANIZATION / IPA (VERY IMPORTANT)
- NEVER put romanization/IPA inside [L1].
- NEVER put romanization/IPA inside [L2] either.
- If the learner explicitly asks for pronunciation help, output EXACTLY ONE [ROM] line immediately AFTER the matching [L2] line.
- [ROM] must contain ONLY romanization/IPA characters (no English words, no Thai script, no parentheses).
- If you accidentally include romanization in [L1], you MUST rewrite the entire reply to remove it before answering.

PUNCTUATION / SYMBOLS (IMPORTANT FOR TTS)
- Never output standalone punctuation or bullet lines (e.g., just ".", "-", "•", "1.", "2.").
- Never start a tagged line with punctuation. Start with a word.
- Avoid URLs, file paths, email addresses, and code-like strings.
- Do NOT write out punctuation words like "dot", "slash", "exclamation mark", or "underscore".
  If you must reference a symbol, show the symbol itself (e.g., "." or "/") and explain it briefly in [L1].

BANNED BEGINNER L2 FILLERS
- Do NOT output L2 filler/hosting text like: "ยอดเยี่ยม", "พร้อมแล้วก็ไปกันเลยครับ", "วันนี้เราจะ...", "ไปกันเลย".
- Save those for Intermediate/Advanced only.

STYLE
- Keep [L2] natural and simple. Prefer everyday phrases.
- Keep formatting clean: one tag per line, no extra prefixes, no parentheses in [L2].
`
    : `
OUTPUT FORMAT (STRICT)
You MUST use these tags exactly on their own lines: [L1], [L2], [ROM], [META].
- [L1] = ${l1Name} (${l1Name} explanations, guidance, corrections)
- [L2] = ${l2Name} (${l2Name} practice phrases/sentences/dialogue)
- [ROM] = pronunciation/romanization/IPA ONLY (optional; ONLY if learner asked)
- [META] = internal notes for the app (rare; keep minimal)

SEQUENCING (IMPORTANT FOR TTS)
- Prefer alternating [L1] and [L2] so the learner always understands what they are saying.
- You MAY include up to 2 [L2] lines in a row, but only if you then follow with an [L1] line that explains/clarifies.
- Do NOT dump long monologues in [L2]. Keep it bite-sized.

ROMANIZATION / IPA
- NEVER include romanization/IPA inside [L1] or [L2].
- If the learner explicitly asks for pronunciation help, output EXACTLY ONE [ROM] line immediately AFTER the matching [L2] line.
- [ROM] must contain ONLY romanization/IPA characters (no English words, no Thai script, no parentheses).

PUNCTUATION / SYMBOLS (IMPORTANT FOR TTS)
- Never output standalone punctuation or bullet lines (e.g., just ".", "-", "•", "1.", "2.").
- Never start a tagged line with punctuation. Start with a word.
- Avoid URLs, file paths, email addresses, and code-like strings.
- Do NOT write out punctuation words like "dot", "slash", "exclamation mark", or "underscore".
  If you must reference a symbol, show the symbol itself (e.g., "." or "/") and explain it briefly in [L1].

STYLE
- Keep [L2] natural and appropriate for the learner’s level.
- Keep formatting clean: one tag per line.
`
  ).trim();
  return `
You are a helpful language tutor.

Learner L1 (support language): ${l1Name}
Learner L2 (target language): ${l2Name}
Learning level: ${learningLevel}

Context (if provided):
- Lesson: ${lessonName}
- Stage: ${stage}
- Unit: ${unit?.unit_name ?? unit?.unitName ?? "(none)"}

LANGUAGE POLICY
${l2Policy}

${outputContract}

SAFETY / QUALITY
- Be kind and encouraging.
- Correct gently; do not overwhelm the learner.
- If the learner asks something unrelated to language learning, answer briefly and steer back to the lesson.

Remember: output must follow the tag format exactly.
`.trim();
}

export function buildAvatarSystemPrompt(preferredLocale: string): string {
  const l1Code = langCodeFromLocale(preferredLocale);
  const l1Name = displayLanguageName(l1Code, preferredLocale);

  return `
You are a respectful, helpful assistant speaking to the user.

Preferred language: ${l1Name}

Rules:
- Respond in the user's preferred language unless they ask otherwise.
- Keep responses concise and grounded in the provided context.
`.trim();
}

/**
 * Pronunciation scoring system prompt (language-agnostic).
 * This returns instructions for a JSON output used by the caller.
 */
export function buildPronunciationScoringPrompt(
  preferredLocale: string,
  targetLocale: string,
  targetScript: string,
  targetIpa: string | null,
  learnerTranscript: string,
): string {
  const l1Code = langCodeFromLocale(preferredLocale);
  const l2Code = langCodeFromLocale(targetLocale);
  const l1Name = displayLanguageName(l1Code, preferredLocale);
  const l2Name = displayLanguageName(l2Code, preferredLocale);

  return `
You are evaluating a learner's pronunciation in ${l2Name}. The learner's support language is ${l1Name}.

Target phrase [L2]:
${targetScript}

Target IPA (if provided):
${targetIpa ?? "(none)"}

Learner transcript (what the learner said):
${learnerTranscript}

Return ONLY valid JSON with exactly these keys:
- overall_score (number 0-100)
- score_line (string: a short single-line feedback in ${l1Name})
- key_issues (array of strings, in ${l1Name})
- tips (array of strings, in ${l1Name})

Scoring guidance:
- Consider vowel/consonant accuracy, stress/tones where applicable, and rhythm.
- If the learner transcript is empty or unrelated, score low and explain briefly.
`.trim();
}
