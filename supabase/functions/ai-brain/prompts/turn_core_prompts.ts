// supabase/functions/ai-brain/prompts/turn_core_prompts.ts
// Prompt builders extracted from pipelines/turn/turn_core.ts to keep turn_core.ts smaller and less brittle.

export function buildLegacySessionSummaryPrompt(args: {
  transcriptText: string;
  sessionKey?: string | null;
  chapterId?: string | null;
  chapterTitle?: string | null;
  allowedChapterKeys: string[];
}): string {
  const {
    transcriptText,
    sessionKey = null,
    chapterId = null,
    chapterTitle = null,
    allowedChapterKeys,
  } = args;

  const keys = (allowedChapterKeys ?? []).map((k) => `- "${k}"`).join("\n");

  return `
You are an expert autobiographical editor summarizing a *legacy preservation* interview.

You will receive a transcript of a single session between a PERSON (USER) and an AI assistant (AI).
Ignore technical chatter (apps, STT/TTS, Supabase, Gemini, debugging, coverage maps, code, deploy issues).
Focus on the person's life experiences, memories, feelings, and concrete events.

Context (may be null):
- session_key: ${sessionKey ?? "null"}
- chapter_id: ${chapterId ?? "null"}
- chapter_title: ${chapterTitle ?? "null"}

ALLOWED chapter_keys (choose 1–3 that best fit, or [] only if truly no biographical content):
${keys}

Return ONLY a valid JSON object with this exact shape (NO extra keys, NO prose):

{
  "short_summary": "1–3 sentences, plain text",
  "full_summary": "1–4 short paragraphs, plain text",
  "observations": {
    "chapter_keys": ["...1-3 from allowed keys..."],
    "themes": ["1-5 short phrases"],
    "word_count_estimate": 123
  },
  "session_insights": {
    "items": [
      {
        "type": "trait|pattern|value|tension|lesson|relationship|career|health|hobby|identity|theme",
        "text": "specific insight grounded in this session",
        "evidence": ["optional short supporting phrases"]
      }
    ]
  }
}

Rules:
- Always return valid JSON. No markdown. No backticks. No code fences.
- short_summary and full_summary must be non-empty strings.
- observations.chapter_keys may be [] only if the transcript has no real biographical content.
- word_count_estimate should estimate USER-spoken words (not AI).
- session_insights.items may be [] if nothing substantial is present.
- Do NOT invent facts not supported by the transcript.

Transcript:
${transcriptText}
`.trim();
}

export function buildStorySeedsPrompt(args: { transcriptText: string }): string {
  return `
You are extracting "story seeds" from a legacy interview transcript.

A story seed is a named, reusable mini-story that an avatar can recall later.
Extract 1 to 6 story seeds MAX.

Return ONLY valid JSON (no markdown, no code fences).

Return this exact JSON shape:
{
  "seeds": [
    {
      "title": "Short, specific title (2–8 words)",
      "seed_text": "2–6 sentences summarizing what happened with concrete details (who/what/where/why). Third person.",
      "canonical_facts": { "facts": ["..."], "quotes": [], "numbers": [] },
      "entities": ["people", "places", "organizations", "foods", "objects"],
      "tags": ["family", "food", "career"],
      "time_span": { "start": null, "end": null, "label": "optional human hint" },
      "confidence": 0.0
    }
  ]
}

Rules:
- seed_text should be biography-focused; ignore app/debugging chatter.
- confidence must be between 0.0 and 1.0
- tags must be short lowercase-ish words.
- If you cannot find real stories, return {"seeds": []}.

TRANSCRIPT:
${args.transcriptText}
`.trim();
}

 export function buildExtractStoriesPrompt(args: { transcriptText: string }): string {
  return `
You are an expert autobiographical editor.
You will be given a transcript of a conversation that may contain personal anecdotes.

Your job: identify DISTINCT STORIES worth saving.

Core rule: a story must meet ALL of these:
- Has a clear scene (where/with whom/what situation)
- Has time anchoring (e.g., "When I was 16…", "One time in Thailand…", a year, a life period)
- Has a sequence of actions (things that happened, in order)
- Has an outcome OR emotional resolution (what happened / how it ended / how it felt)
- Is NOT a belief statement
- Is NOT a system instruction (save this / deploy / code / app debugging)
- Is NOT a question

If it doesn’t satisfy ALL of the above, it is NOT a story and must be excluded.

Return ONLY valid JSON of this exact shape:
{
  "stories": [
    {
      "title": "Short title (2–8 words)",
      "body": "3–12 sentences narrating the event (third person).",
      "tags": ["short", "tags"],
      "confidence": 0.0
    }
  ]
}

Rules:
- Always return valid JSON. No markdown. No backticks. No code fences.
- stories may be [].
- confidence is 0.0–1.0.
- Make body suitable to be saved as a standalone story for a memory library.
- Do not invent new events that aren’t implied by the transcript.

Transcript:
${args.transcriptText}
`.trim();
 }

export function buildSessionInsightsPrompt(args: { fullSummary: string }): string {
  return `
You are an expert biographer and personality analyst.

You will be given a narrative description of ONE conversation session.
Extract insights that are:
- personally specific (use concrete phrases from the session when possible),
- non-generic,
- and useful for understanding enduring traits/patterns.

Return ONLY valid JSON of this exact shape (no extra keys, no prose):
{
  "items": [
    {
      "type": "trait|behavior|value|tension|lesson|relationship|theme",
      "text": "specific insight",
      "strength": 0.55,
      "evidence": ["optional short supporting phrases"]
    }
  ]
}

Rules:
- strength: 0.55–0.95; use higher only when strongly supported.
- Prefer trait/behavior when a pattern is shown (humor, teasing, discipline, risk-taking, etc.).
- If the session contains a named anecdote (e.g., “murder crabs”), include it as type "theme".
- If nothing substantial is present, return {"items": []}.
- Always return valid JSON. No markdown. No backticks. No code fences.

Session summary:
${args.fullSummary}
`.trim();
}

export function buildCoverageClassificationPrompt(args: {
  storyText: string;
  allowedChapterKeys: string[];
}): string {
  const keys = (args.allowedChapterKeys ?? []).map((k) => `- "${k}"`).join("\n");
  return `You are helping to organise someone's life stories into high-level life chapters.

Allowed chapter keys (use 1–3 that best match):
${keys}

Return ONLY valid JSON like:
{
  "chapter_keys": ["early_childhood", "family_relationships"],
  "themes": ["1–5 short phrases"]
}

Rules:
- Always return valid JSON. No markdown. No backticks. No code fences.
- chapter_keys must be 1–3 keys from the allowed list.
- themes should be 1–5 short phrases, not sentences.

STORY:
${args.storyText}`.trim();
}
