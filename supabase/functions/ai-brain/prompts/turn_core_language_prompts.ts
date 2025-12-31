// Extracted prompt contracts from turn_core.ts to reduce brittleness.
// Keep this file small, pure, and easy to unit-test.

export const TAGGING_CONTRACT = `
You MUST format your reply using explicit line tags:
[L1] for the learner's main language (preferred_locale)
[L2] for the target language (target_locale)
[ROM] for romanization / IPA (ONLY if the learner asked)
[META] for brief system notes if necessary

RULES:
- Every non-empty line MUST start with one of these tags: [L1], [L2], [ROM], [META].
- Never output untagged text.
- Never output standalone punctuation lines (e.g., just ".", "-", "•", "1.", "2.").
- Never start a tagged line with punctuation. Start with a word.
- Do NOT put explanations on [L2] lines. [L2] is examples only.
- Do NOT include romanization/IPA unless the learner asked. If included, put it ONLY on a single [ROM] line.
`.trim();

export function buildBeginnerModeAddon(): string {
  return `
BEGINNER MODE OUTPUT RULES (HARD):
- Respond MOSTLY in the learner's L1 (preferred_locale).
- Do NOT mirror the user's last message language. If the user wrote in L2, treat it as practice input but still explain in L1.
- Keep L2 short: single phrases/sentences only. Do NOT write long paragraphs in L2.
- Every [L2] line must be immediately followed by an [L1] meaning/explanation line.
- Do NOT add romanization unless the learner asked.
- Do NOT output standalone punctuation lines or lines that start with punctuation.

REQUIRED FORMAT (Beginner):
[L1] Guidance (1–2 short sentences)
[L2] One short example sentence/phrase
[L1] Meaning + tiny next-step question
Repeat at most 2 cycles per reply.
`.trim();
}

export function buildBeginnerRewritePrompt(args: {
  systemPrompt: string;
  contextBlock: string;
  replyText: string;
}): string {
  const { systemPrompt, contextBlock, replyText } = args;

  return `
${systemPrompt}

${contextBlock}

Rewrite the assistant reply below to follow BEGINNER MODE:
- Mostly [L1] (preferred_locale), short [L2] examples only.
- Use the REQUIRED FORMAT (repeat max 2 cycles).
- Do NOT add romanization unless the learner asked.
- Do NOT output standalone punctuation lines.
Keep the meaning the same. Only rewrite the format and balance.

Assistant reply to rewrite:
"""${replyText}"""
`.trim();
}
