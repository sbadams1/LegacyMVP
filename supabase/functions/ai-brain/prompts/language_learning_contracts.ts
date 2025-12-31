// supabase/functions/ai-brain/prompts/language_learning_contracts.ts
//
// Centralized language-learning format contracts used by turn_core.
// Keep this file small and pure (no Supabase / fetch logic).

export const TAGGING_CONTRACT = `
You MUST format your reply using explicit line tags:
[L1] for learner guidance in the native language (L1).
[L2] for target-language output only (L2). Keep it clean.
[ROM] for optional romanization/transliteration (optional; omit if not helpful).

Rules:
- Each non-empty line must start with exactly one tag: [L1], [L2], [ROM], or [META] when needed.
- Do NOT mix tags on the same line.
- Do NOT put explanations on [L2] lines.
- If you provide romanization, put it ONLY on [ROM] lines.
- NEVER put romanization/IPA inside [L1] lines.

Your reply MUST include at least one [L2] line.
`.trim();

/** Formats the recent conversation context block injected into the system prompt. */
export function formatRecentLanguageLearningConversation(lines: string[]): string {
  if (!lines?.length) return "";
  return [
    "Recent language-learning conversation (most recent last):",
    ...lines,
  ].join("\n").trim();
}
