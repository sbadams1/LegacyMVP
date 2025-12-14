// Base concept in L1 (English)
export interface ConceptMaster {
  id: string;
  concept_key: string;
  l1_language_code: string;
  l1_headword: string;
  l1_gloss_short: string;
  l1_gloss_long?: string | null;
  part_of_speech?: string | null;
  semantic_domain?: string | null;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
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

export interface VocabularyExpansion {
  id: string;
  concept_id: string;
  language_code: string;
  script: string;
  lemma: string;
  ipa?: string | null;
  romanization?: string | null;
  part_of_speech?: string | null;
  register?: string | null;
  politeness_level?: string | null;
  sense_label?: string | null;
  example_l2?: string | null;
  example_l1?: string | null;
  syllable_breakdown?: string | null;
  pitch_pattern?: string | null;
  articulation_notes?: string | null;
  drill_steps: DrillStep[];
  audio_asset_url?: string | null;
  tags: string[];
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

// Convenient joined shape for your lesson builder
export interface ConceptWithExpansion {
  concept: ConceptMaster;
  expansion: VocabularyExpansion;
}
