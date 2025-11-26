// supabase/functions/language-tutor/index.ts
//
// Language tutoring engine:
// - Reads user profile (preferred/target language, level, gender)
// - Looks up or creates a language_sessions row
// - Loads lesson_plans.json_plan for current skill/lesson
// - Builds a structured system prompt for the current phase
// - Calls Gemini and returns the reply + updated session snapshot

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const geminiApiKey = Deno.env.get("GEMINI_API_KEY")!;

// Basic Gemini call using the public Generative Language API.
// Adjust model name as needed.
async function callGemini(systemPrompt: string, userMessage: string): Promise<string> {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: systemPrompt },
          { text: `\n\nUser message:\n${userMessage}` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 600
    }
  };

  const resp = await fetch(`${url}?key=${geminiApiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error("Gemini error:", resp.status, text);
    throw new Error(`Gemini error ${resp.status}`);
  }

  const data = await resp.json();
  const candidates = data.candidates ?? [];
  const first = candidates[0];
  const parts = first?.content?.parts ?? [];
  const combined = parts.map((p: { text?: string }) => p.text ?? "").join("\n");
  return combined.trim();
}

type LessonPlanJson = {
  language_code: string;
  skill_code: string;
  lesson_code: string;
  learner_level: string;
  title: string;
  description?: string;
  phases: Array<{
    id: number;
    label: string;
    system_goal: string;
    steps: Array<{
      id: string;
      type: string;
      language: string;
      tts_channel?: "native" | "target" | "mixed";
      ai_instruction: string;
      expected_user_response?: string;
    }>;
  }>;
  vocabulary_refs?: any;
  constraints?: {
    max_new_words?: number;
    max_review_words?: number;
  };
};

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const client = createClient(supabaseUrl, supabaseServiceRoleKey);

  try {
    const body = await req.json();
    const userId = body.user_id as string | undefined;
    const userMessage = (body.message as string | undefined) ?? "";

    if (!userId || !userMessage) {
      return new Response(
        JSON.stringify({ error: "user_id and message are required." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 1) Load profile
    const { data: profile, error: profileError } = await client
      .from("profiles")
      .select(
        "preferred_language, target_language, learning_level, learner_gender"
      )
      .eq("id", userId)
      .maybeSingle();

    if (profileError) {
      console.error("Profile error:", profileError);
    }

    const preferredLanguage =
      (profile?.preferred_language as string | null) ?? "en-US";
    const targetLanguage =
      (profile?.target_language as string | null) ?? preferredLanguage;
    const learnerLevel =
      (profile?.learning_level as string | null) ?? "beginner";
    const learnerGender =
      (profile?.learner_gender as string | null) ?? "male"; // default

    // 2) Load or create language session
    const { data: sessions, error: sessionError } = await client
      .from("language_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("target_language", targetLanguage)
      .eq("learner_level", learnerLevel)
      .order("last_interaction_at", { ascending: false })
      .limit(1);

    if (sessionError) {
      console.error("language_sessions query error:", sessionError);
    }

    let session = sessions?.[0] ?? null;

    if (!session) {
      const defaultSkill = "S1_GREETINGS";
      const defaultLesson = "S1_L1";

      const { data: inserted, error: insertError } = await client
        .from("language_sessions")
        .insert({
          user_id: userId,
          target_language: targetLanguage,
          learner_level: learnerLevel,
          current_skill_code: defaultSkill,
          current_lesson_code: defaultLesson,
          current_phase: 1
        })
        .select("*")
        .single();

      if (insertError) {
        console.error("language_sessions insert error:", insertError);
        throw insertError;
      }
      session = inserted;
    }

    const currentSkill = session.current_skill_code as string;
    const currentLesson = session.current_lesson_code as string;
    const currentPhase = session.current_phase as number;

    // 3) Load lesson plan JSON
    const { data: lessonRow, error: lessonError } = await client
      .from("lesson_plans")
      .select("json_plan, title, skill_code, lesson_code, language_code")
      .eq("language_code", targetLanguage)
      .eq("skill_code", currentSkill)
      .eq("lesson_code", currentLesson)
      .eq("learner_level", learnerLevel)
      .eq("is_active", true)
      .maybeSingle();

    if (lessonError) {
      console.error("lesson_plans error:", lessonError);
      throw lessonError;
    }

    if (!lessonRow) {
      return new Response(
        JSON.stringify({
          error: "No lesson plan configured for this language/skill/lesson."
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const plan = lessonRow.json_plan as LessonPlanJson;

    // Find the current phase config
    const phaseConfig = plan.phases.find((p) => p.id === currentPhase);
    if (!phaseConfig) {
      return new Response(
        JSON.stringify({
          error: `No phase ${currentPhase} in lesson plan.`,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // ------------------------------------------------------------------------------------------------
    // 4) Build system prompt for the current phase using the plan + learner profile + user message.
    // ------------------------------------------------------------------------------------------------

    const phaseLabel = phaseConfig.label;
    const stepsDescription = phaseConfig.steps
      .map((s, idx) => {
        return `${idx + 1}. Step "${s.id}" (${s.type}, language=${s.language}, tts_channel=${s.tts_channel ?? "target"}): ${s.ai_instruction}`;
      })
      .join("\n");

    const systemPrompt = `
You are a structured language tutor.

USER PROFILE:
- Native / preferred language: "${preferredLanguage}"
- Target language: "${targetLanguage}"
- Learner level: "${learnerLevel}"
- Learner gender: "${learnerGender}" (use this for politeness or gendered forms, if relevant)

LESSON CONTEXT:
- Skill: ${plan.skill_code}
- Lesson: ${plan.lesson_code} – ${plan.title}
- Current phase: ${currentPhase} – "${phaseLabel}"
- Phase goal: ${phaseConfig.system_goal}

LESSON PLAN STEPS FOR THIS PHASE:
${stepsDescription}

GENERAL RULES:
- Follow the intent of the listed steps, but keep your reply to the learner as a single coherent message.
- Keep sentences short and clear. Avoid academic grammar explanations unless asked.
- Use the target language "${targetLanguage}" for practice segments.
- Use the learner's native language "${preferredLanguage}" only for brief explanations and instructions.
- If you need politeness particles or gendered endings (for languages like Thai), choose ONLY the correct form for "${learnerGender}" and never say both (for example, do NOT say 'krub/ka').
- Do NOT read or pronounce symbols like "*", "/", or other non-language characters when speaking the target language.
- If the learner's message is meta (such as 'I'm tired' or 'let's change topic'), acknowledge it but keep the conversation within this lesson's scope unless they clearly ask to switch.

RESPONSE SHAPE:
- Produce one helpful message that clearly continues the current phase of the lesson.
- If this is phase 1, set the scene and ask one simple question.
- If this is phase 2, focus on teaching and mini-drills.
- If this is phase 3, keep the role-play short, realistic, and doable for a beginner.
- If this is phase 4, review key phrases and offer ONE clear suggestion for what they can do next (practice idea or next skill).
`.trim();

    // 5) Call Gemini
    const aiText = await callGemini(systemPrompt, userMessage);

    // 6) Update session timestamp (and simple phase advance rule if desired)
    let nextPhase = currentPhase;

    // Simple rule: if user types "next" + we are not yet in phase 4 → advance a phase.
    const lower = userMessage.trim().toLowerCase();
    if (lower === "next" && currentPhase < 4) {
      nextPhase = currentPhase + 1;
    }

    const { error: updateError } = await client
      .from("language_sessions")
      .update({
        current_phase: nextPhase,
        last_interaction_at: new Date().toISOString()
      })
      .eq("id", session.id);

    if (updateError) {
      console.error("language_sessions update error:", updateError);
    }

    const responsePayload = {
      reply: aiText,
      session: {
        id: session.id,
        target_language: targetLanguage,
        learner_level: learnerLevel,
        current_skill_code: currentSkill,
        current_lesson_code: currentLesson,
        current_phase: nextPhase
      }
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    console.error("language-tutor exception:", e);
    return new Response(
      JSON.stringify({ error: "language-tutor failed", details: `${e}` }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
