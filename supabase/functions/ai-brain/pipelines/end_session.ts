// supabase/functions/ai-brain/pipelines/end_session.ts
// Extracted from ai-brain/handler.ts to reduce brittleness.
// This pipeline runs ONLY during explicit end-session.

export type EndSessionDeps = {
  fetchLegacySessionTranscript: (...args: any[]) => Promise<any>;
  summarizeLegacySessionWithGemini: (...args: any[]) => Promise<any>;
  inferChapterKeysForLegacySummary: (...args: any[]) => any;
  classifyCoverageFromStoryText: (...args: any[]) => any;
  upsertStorySeedsForConversation: (...args: any[]) => Promise<any>;
  recomputeUserKnowledgeGraphs: (...args: any[]) => Promise<any>;
  invokeRebuildInsightsInternal: (...args: any[]) => Promise<any>;
};

export type EndSessionCtx = {
  client: any;
  user_id: string;
  effectiveConversationId: string;
  rawIdThisTurn: string | null;
  conversationMode: string;
  preferredLocale: string;
  targetLocale: string | null;
  hasTarget: boolean;
  learningLevel: string;
  legacyState: any;
  nowIso: string;
  deps: EndSessionDeps;
};

export async function runEndSessionPipeline(ctx: EndSessionCtx): Promise<void> {
  const {
    client,
    user_id,
    effectiveConversationId,
    rawIdThisTurn,
    conversationMode,
    preferredLocale,
    targetLocale,
    hasTarget,
    learningLevel,
    legacyState,
    nowIso,
    deps,
  } = ctx;

  // In the original monolithic handler.ts, the legacy-state helper variable
  // `ls` existed in the parent scope (typically: `const ls = legacyState ?? getDefaultLegacy()`)
  // before the end-session branch. After extracting this pipeline, we must
  // re-introduce a safe local `ls` so the summarizer receives chapter context.
  // We keep this permissive to avoid any behavior change and to prevent runtime
  // ReferenceErrors if legacyState is null/undefined.
  const ls: any = legacyState ?? {};
  if (ls.chapter_id === undefined && ls.chapterId !== undefined) ls.chapter_id = ls.chapterId;
  if (ls.chapter_title === undefined && ls.chapterTitle !== undefined) ls.chapter_title = ls.chapterTitle;
  if (ls.chapter_id === undefined) ls.chapter_id = null;
  if (ls.chapter_title === undefined) ls.chapter_title = null;

              console.log("END_SESSION SUMMARY ATTEMPT", {
                user_id,
                conversation_id: effectiveConversationId,
                rawIdThisTurn,
              });

              // 1) Find an anchor raw_id for this session (required: memory_summary.raw_id is NOT NULL)
              const { data: anchorRow, error: anchorErr } = await client
                .from("memory_raw")
                .select("id, created_at")
                .eq("user_id", user_id)
                .eq("conversation_id", effectiveConversationId)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

              if (anchorErr) {
                console.error("Error finding session anchor raw_id:", anchorErr);
              }

              const anchorRawId = (anchorRow as any)?.id as string | undefined;

              console.log("END_SESSION ANCHOR RESULT", {
                user_id,
                conversation_id: effectiveConversationId,
                anchorRawId,
              });

              if (!anchorRawId) {
                console.warn(
                  "No anchorRawId found for end_session; cannot write memory_summary.",
                );
              } else {
                // 2) Build transcript
                const transcript = await deps.fetchLegacySessionTranscript(
                  client,
                  user_id,
                  effectiveConversationId,
                );

                console.log("END_SESSION: transcript fetched", {
                  conversation_id: effectiveConversationId,
                  transcript_length: transcript?.length ?? 0,
                });

                // 3) Summarize with Gemini
                const summary = await deps.summarizeLegacySessionWithGemini(
                  transcript,
                  {
                    session_key: effectiveConversationId,
                    chapter_id: ls.chapter_id,
                    chapter_title: ls.chapter_title,
                    preferred_locale: preferredLocale,
                    target_locale: hasTarget ? targetLocale : null,
                    learning_level: learningLevel,
                  },
                );

                if (!summary) {
                  console.warn(
                    "END_SESSION: summarizeLegacySessionWithGemini returned null",
                    { conversation_id: effectiveConversationId },
                  );
                } else {
                  // ✅ include session_insights from the summarizer output
                  const { short_summary, full_summary, observations, session_insights } = summary;

                  // ------------------------------------------------------------------
                  // Quiet chapter classification (content-based)
                  //
                  // IMPORTANT BUGFIX:
                  //   deps.classifyCoverageFromStoryText() returns { chapterKeys, themes }
                  //   (camelCase), but older code read chapter_keys, which always
                  //   produced an empty list and caused chapter_key to stick to
                  //   the default (often "early_childhood").
                  // ------------------------------------------------------------------
                  let obsOut: any = observations ?? {};

                  try {
                    const classified = await deps.classifyCoverageFromStoryText(full_summary);

                    let keys: CoverageChapterKey[] =
                      Array.isArray(classified?.chapterKeys) ? classified!.chapterKeys : [];

                    let themes: string[] =
                      Array.isArray(classified?.themes) ? classified!.themes : [];

                    // Deterministic fallback (no extra Gemini call) if classification fails.
                    if (!keys.length) {
                      keys = deps.inferChapterKeysForLegacySummary(full_summary, themes);
                    }

                    if (keys.length) {
                      const existingThemes = Array.isArray(obsOut?.themes) ? obsOut.themes : [];
                      const mergedThemes = Array.from(
                        new Set(
                          [...existingThemes, ...themes]
                            .filter((t) => typeof t === "string")
                            .map((t) => t.trim())
                            .filter(Boolean),
                        ),
                      );

                      obsOut = {
                        ...obsOut,
                        chapter_keys: keys,
                        themes: mergedThemes,
                        coverage_classified_from: "full_summary",
                        coverage_classified_at: new Date().toISOString(),
                      };

                      // Primary chapter_key = first key
                      const primaryChapterKey = keys[0];

                      // Update all memory_raw rows for this session so Coverage Map reflects reality.
                      // Best-effort only.
                      const { error: mrUpdErr } = await client
                        .from("memory_raw")
                        .update({
                          chapter_key: primaryChapterKey,
                          chapter_key_2: (keys[1] ?? null),
                          chapter_key_3: (keys[2] ?? null),
                        })
                        .eq("user_id", user_id)
                        .eq("conversation_id", effectiveConversationId);

                      if (mrUpdErr) {
                        console.error(
                          "END_SESSION: memory_raw chapter_key update failed:",
                          mrUpdErr,
                        );
                      } else {
                        console.log("END_SESSION: memory_raw chapter_key updated", {
                          conversation_id: effectiveConversationId,
                          chapter_key: primaryChapterKey,
                        });
                      }
                    }
                  } catch (e) {
                    console.error("END_SESSION: coverage classification failed:", e);
                  }

                  console.log("END_SESSION: writing memory_summary", {
                    conversation_id: effectiveConversationId,
                    raw_id: anchorRawId,
                  });

                  // 4) Upsert by raw_id (since raw_id is NOT NULL and is the real anchor)
                  let summaryIdForSeeds: string | null = null;

                  const { data: existingSummary, error: summaryFetchError } =
                    await client
                      .from("memory_summary")
                      .select("id")
                      .eq("raw_id", anchorRawId)
                      .limit(1)
                      .maybeSingle();

                  if (summaryFetchError) {
                    console.error(
                      "Error reading existing memory_summary row:",
                      summaryFetchError,
                    );
                  } else if (existingSummary?.id) {
                    summaryIdForSeeds = existingSummary.id;

                    const { error: updateError } = await client
                      .from("memory_summary")
                      .update({
                        short_summary,
                        full_summary,
                        observations: obsOut,
                        chapter_key: summaryChapterKey1,
                        chapter_key_2: summaryChapterKey2,
                        chapter_key_3: summaryChapterKey3,
                        session_insights,
                        updated_at: new Date().toISOString(),
                      })
                      .eq("id", existingSummary.id);

                    if (updateError) {
                      console.error("Error updating memory_summary:", updateError);
                    }
                  } else {
                    const summaryChapterKeys: string[] = Array.isArray((obsOut as any)?.chapter_keys)
                      ? (obsOut as any).chapter_keys
                      : [];
                    const summaryChapterKey1 = summaryChapterKeys[0] ?? null;
                    const summaryChapterKey2 = summaryChapterKeys[1] ?? null;
                    const summaryChapterKey3 = summaryChapterKeys[2] ?? null;

                    const { data: insertedSummary, error: insertSummaryError } = await client
                      .from("memory_summary")
                      .insert({
                        user_id,
                        raw_id: anchorRawId,
                        short_summary,
                        full_summary,
                        observations: obsOut,
                        chapter_key: summaryChapterKey1,
                        chapter_key_2: summaryChapterKey2,
                        chapter_key_3: summaryChapterKey3,
                        session_insights,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                      })
                      .select("id")
                      .maybeSingle();

                    if (insertSummaryError) {
                      console.error(
                        "Error inserting into memory_summary:",
                        insertSummaryError,
                      );
                    } else {
                      summaryIdForSeeds = insertedSummary?.id ?? null;
                    }
                  }

                  // 5) Heavy stuff only on end_session only on end_session
                  try {
                    await deps.recomputeUserKnowledgeGraphs(client, user_id);

                    // Story seeds (avatar recall) – only on end_session
                    await deps.upsertStorySeedsForConversation(
                      client,
                      user_id,
                      effectiveConversationId,
                      summaryIdForSeeds,
                    );

                    try {
                      const enableRebuild =
                        (Deno.env.get("END_SESSION_RUN_REBUILD_INSIGHTS") ?? "false")
                          .toLowerCase() === "true";

                      if (enableRebuild) {
                        const rebuildText = await deps.invokeRebuildInsightsInternal({
                          user_id,
                          conversation_id: effectiveConversationId,
                          // Hint for the rebuild-insights function (safe even if ignored):
                          // prefer a single-pass / low-call strategy when possible.
                          lite: true,
                        });
                        console.log("rebuild-insights invoke OK:", rebuildText);
                      } else {
                        console.log(
                          "rebuild-insights skipped (set END_SESSION_RUN_REBUILD_INSIGHTS=true to enable)",
                        );
                      }
                    } catch (rebuildErr) {
                      console.error("rebuild-insights invoke FAILED:", rebuildErr);
                    }
                  } catch (err) {
                    console.error("Error recomputing coverage / insights:", err);
                  }
                }
              }
}
