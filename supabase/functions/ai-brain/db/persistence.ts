// AUTO-GENERATED extraction from pipelines/turn.ts
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

import { countWordsApprox } from "../../_shared/text_utils.ts";

// NOTE: This module intentionally preserves existing persistence behavior.
export async function persistLegacyAndLearningTurn(args: {
  supabase: SupabaseClient | null;
  // Context
  conversationMode: any;
  legacyState: any;
  message_text: any;
  replyText: any;
  user_id: any;
  effectiveConversationId: any;
  preferredLocale: any;
  hasTarget: any;
  targetLocale: any;
  learningLevel: any;
  isEndSession: any;
  // Helpers / deps
  deps: {
    getDefaultLegacyState: any;
    inferChapterKeysForLegacySummary: any;
    classifyCoverageFromStoryText: any;
    countWordsApprox: any;
    fetchLegacySessionTranscript: any;
    summarizeLegacySessionWithGemini: any;
    upsertStorySeedsForConversation: any;
    recomputeUserKnowledgeGraphs: any;
    invokeRebuildInsightsInternal: any;
    runEndSessionPipeline: any;
  };
}): Promise<void> {
  const {
    supabase,
    conversationMode,
    legacyState,
    message_text,
    replyText,
    user_id,
    effectiveConversationId,
    preferredLocale,
    hasTarget,
    targetLocale,
    learningLevel,
    isEndSession,
    deps,
  } = args;

  // 7) Persistence: legacy + language-learning logging
  // -----------------------------------------------------------------------
  if (supabase) {
    const client = supabase as SupabaseClient;
  
    // 7a) Legacy interview persistence (memory_raw + optional summary)
    if (conversationMode === "legacy") {
      try {
        const ls = legacyState ?? getDefaultLegacyState();
        let userText = (message_text ?? "").trim();
        if (userText === "__END_SESSION__") userText = "";
  
        const aiText = replyText.trim();
        const nowIso = new Date().toISOString();
  
        // Write user + AI turns into memory_raw
        const legacyRows: any[] = [];
  
        const coverageChapters: any[] = (() => {
          switch (ls.chapter_id) {
            case "childhood":
              return ["early_childhood", "family_relationships", "education"];
            case "early_career":
              return ["early_adulthood", "work_career", "major_events"];
            case "midlife":
              return ["midlife", "family_relationships", "health_wellbeing"];
            case "later_life":
              return ["later_life", "health_wellbeing", "major_events"];
            default:
              return ["major_events"];
          }
        })();
  
  
        // Content-based chapter assignment for this turn.
        // We prefer a fast deterministic inference from the actual text so we don't
        // accidentally stamp every row as "early_childhood" due to a default legacy chapter.
        const inferredTurnKeys = inferChapterKeysForLegacySummary(
          [userText, aiText].filter(Boolean).join("\n"),
          [],
        );
        const primaryTurnChapterKey: any =
          (inferredTurnKeys && inferredTurnKeys[0]) ||
          (coverageChapters && coverageChapters[0]) ||
          "major_events";
  
        const orderedTurnKeys: any[] = (
          (inferredTurnKeys && inferredTurnKeys.length ? inferredTurnKeys : coverageChapters) || ["major_events"]
        ).slice(0, 3) as any[];
  
        const turnChapterKey2: any | null = orderedTurnKeys[1] ?? null;
        const turnChapterKey3: any | null = orderedTurnKeys[2] ?? null;
  
        const userWordCount = userText.length > 0
          ? Math.max(1, Math.round(userText.split(/\s+/).length))
          : 0;
        const aiWordCount = aiText.length > 0
          ? Math.max(1, Math.round(aiText.split(/\s+/).length))
          : 0;
        const wordCountThisTurn = userWordCount + aiWordCount;
  
        if (userText) {
          legacyRows.push({
            user_id,
            content: userText,
            source: "legacy_user",
            conversation_id: effectiveConversationId,
            role: "user",
            context: {
              mode: "legacy",
              chapter_id: ls.chapter_id,
              chapter_title: ls.chapter_title,
            },
            tags: ["legacy"],
            created_at: nowIso,
            chapter_key: primaryTurnChapterKey,
            word_count_estimate: userWordCount,
            is_legacy_story: true,
            user_edited: false,
          });
        }
  
        if (aiText) {
          legacyRows.push({
            user_id,
            content: aiText,
            source: "legacy_ai",
            conversation_id: effectiveConversationId,
            role: "assistant",
            context: {
              mode: "legacy",
              chapter_id: ls.chapter_id,
              chapter_title: ls.chapter_title,
            },
            tags: ["legacy"],
            created_at: nowIso,
            chapter_key: primaryTurnChapterKey,
            word_count_estimate: aiWordCount,
            is_legacy_story: true,
            user_edited: false,
          });
        }
  
        let rawIdThisTurn: string | null = null;
        if (legacyRows.length > 0) {
          const { data: inserted, error: insertError } = await client
            .from("memory_raw")
            .insert(legacyRows)
            .select("id")
            .limit(1);
  
          if (insertError) {
            console.error(
              "Error inserting legacy rows into memory_raw:",
              insertError,
            );
          } else if (inserted && inserted.length > 0) {
            rawIdThisTurn = (inserted[0] as any).id as string;
          }
        }
  
        // Only do the expensive summarisation when this is an explicit end-session.
        if (isEndSession) {
          await runEndSessionPipeline({
            client,
            user_id,
            effectiveConversationId,
            rawIdThisTurn,
            conversationMode,
            preferredLocale,
            targetLocale: hasTarget ? targetLocale : null,
            hasTarget,
            learningLevel,
            legacyState,
            nowIso,
            deps: {
              fetchLegacySessionTranscript,
              summarizeLegacySessionWithGemini,
              inferChapterKeysForLegacySummary,
              classifyCoverageFromStoryText,
              upsertStorySeedsForConversation,
              recomputeUserKnowledgeGraphs,
              invokeRebuildInsightsInternal,
            },
          });
        }
      } catch (err) {
        console.error("Legacy persistence error:", err);
      }
    }
  
    // 7b) Language-learning logging into memory_raw (no summaries yet).
    if (conversationMode === "language_learning") {
      try {
        let userText = (message_text ?? "").trim();
  
        // If the client sent the hidden end-session token, treat it as no user text.
        if (userText === "__END_SESSION__") {
          userText = "";
        }
  
        const aiText = replyText.trim();
        const nowIso = new Date().toISOString();
  
        const rows: any[] = [];
  
        if (userText) {
          rows.push({
            user_id,
            content: userText,
            source: "language_learning_user",
            conversation_id: effectiveConversationId,
            role: "user",
            context: {
              mode: "language_learning",
              target_locale: targetLocale,
              learning_level: learningLevel,
            },
            tags: ["language_learning"],
            created_at: nowIso,
        });
        }
  
        if (aiText) {
          rows.push({
            user_id,
            content: aiText,
            source: "language_learning_ai",
            conversation_id: effectiveConversationId,
            role: "assistant",
            context: {
              mode: "language_learning",
              target_locale: targetLocale,
              learning_level: learningLevel,
            },
            tags: ["language_learning"],
            created_at: nowIso,
          });
        }
  
        if (rows.length > 0) {
          const { error } = await client.from("memory_raw").insert(rows);
          if (error) {
            console.error(
              "Error inserting language-learning rows into memory_raw:",
              error,
            );
          }
        }
      } catch (err) {
        console.error(
          "Exception inserting language-learning rows into memory_raw:",
          err,
        );
      }
    }
  }
  
  // -----------------------------------------------------------------------
}
