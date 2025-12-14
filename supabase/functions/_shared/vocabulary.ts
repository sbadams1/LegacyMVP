// supabase/functions/_shared/vocabulary.ts

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

// =========
// DB TYPES
// =========

export interface ConceptMasterRow {
  concept_key: string;
  l1_language_code: string;
  l1_headword: string;
  l1_gloss_short: string;
  l1_gloss_long: string | null;
  part_of_speech: string | null;
  semantic_domain: string | null;
  metadata: any;
}

export type DrillStepType =
  | "listen"
  | "shadow"
  | "speak"
  | "sentence"
  | "chunk";

export interface DrillStep {
  type: DrillStepType;
  reps?: number;
  mode?: string;   // e.g. "record", "record-and-compare"
  notes?: string;
}

export interface VocabularyExpansionRow {
  id: string;
  concept_id: string;
  concept_key: string;           // <-- now present in DB
  language_code: string;
  script: string;
  lemma: string;
  ipa: string | null;
  romanization: string | null;
  part_of_speech: string | null;
  register: string | null;
  politeness_level: string | null;
  sense_label: string | null;
  example_l2: string | null;
  example_l1: string | null;
  syllable_breakdown: string | null;
  pitch_pattern: string | null;
  articulation_notes: string | null;
  drill_steps: unknown | null;
  audio_asset_url: string | null;
  tags: string[] | null;
  is_default: boolean;
  notes: string | null;          // <-- new column, optional
}

export interface ConceptWithExpansion {
  concept: ConceptMaster;
  expansion: VocabularyExpansion;
}

// ================================
// FETCH CONCEPT + EXPANSION (L2)
// ================================

export async function getConceptWithExpansion(
  supabase: SupabaseClient,
  conceptKey: string,
  languageCode: string,
  opts?: {
    register?: string;        // "formal" / "casual"
    politeness_level?: string;
    sense_label?: string;
  }
): Promise<ConceptWithExpansion | null> {
  // 1) Find the concept by key
  const { data: concept, error: conceptError } = await supabase
    .from<ConceptMaster>("concept_master")
    .select("*")
    .eq("concept_key", conceptKey)
    .single();

  if (conceptError || !concept) {
    console.warn("Concept not found for key:", conceptKey, conceptError);
    return null;
  }

  // 2) Find expansions for that concept + language
  let query = supabase
    .from<VocabularyExpansion>("vocabulary_expansions")
    .select("*")
    .eq("concept_id", concept.id)
    .eq("language_code", languageCode);

  if (opts?.register) {
    query = query.eq("register", opts.register);
  }
  if (opts?.politeness_level) {
    query = query.eq("politeness_level", opts.politeness_level);
  }
  if (opts?.sense_label) {
    query = query.eq("sense_label", opts.sense_label);
  }

  const { data: expansions, error: expError } = await query;

  if (expError || !expansions || expansions.length === 0) {
    console.warn("No expansions found for concept/language", {
      conceptKey,
      languageCode,
      expError,
    });
    return null;
  }

  // 3) Choose best expansion: default first, else first row
  const expansion =
    expansions.find((e) => e.is_default) ?? expansions[0];

  const normalizedExpansion: VocabularyExpansion = {
    ...expansion,
    drill_steps: (expansion.drill_steps as any) ?? [],
  };

  return { concept, expansion: normalizedExpansion };
}

// ======================
// PRONUNCIATION DRILL
// ======================

export interface PronunciationDrill {
  script: string;             // e.g. "วิ่ง"
  ipa?: string;
  syllable_breakdown?: string;
  pitch_pattern?: string;
  articulation_notes?: string;
  steps: DrillStep[];
  example_l2?: string;
  example_l1?: string;
  audio_asset_url?: string;
}

/**
 * Convert a VocabularyExpansion into a drill payload that
 * your language-learning system prompt / state can consume.
 */
export function buildPronunciationDrill(
  expansion: VocabularyExpansion
): PronunciationDrill {
  return {
    script: expansion.script,
    ipa: expansion.ipa ?? undefined,
    syllable_breakdown: expansion.syllable_breakdown ?? undefined,
    pitch_pattern: expansion.pitch_pattern ?? undefined,
    articulation_notes: expansion.articulation_notes ?? undefined,
    steps: expansion.drill_steps ?? [],
    example_l2: expansion.example_l2 ?? undefined,
    example_l1: expansion.example_l1 ?? undefined,
    audio_asset_url: expansion.audio_asset_url ?? undefined,
  };
}
