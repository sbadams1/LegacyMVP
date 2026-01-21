// supabase/functions/ai-brain/types/themes.ts
// Shared contracts for longitudinal theme extraction + clustering.
// Keep this file type-only (no runtime deps).

export type AttractorDomain =
  | "identity"
  | "agency"
  | "meaning"
  | "time"
  | "relationships"
  | "institutions_power"
  | "health_body"
  | "creation_work"
  | "emotion_regulation"
  | "values_morality"
  | "change_transition";

export type ThemeReceipt = {
  snippet: string; // <= ~200 chars
  source?: "short_summary" | "full_summary" | "session_insights";
};

export type EmergentTheme = {
  label: string; // phrase-level, <= ~8 words
  weight: number; // 0..1
  receipts: ThemeReceipt[]; // 0..3
  domains?: AttractorDomain[]; // optional metadata, never gating
};

export type ExtractSummaryThemesArgs = {
  short_summary: string;
  full_summary?: string | null;
  max_themes?: number;
};

export type ExtractSummaryThemesResult = {
  themes: EmergentTheme[];
};
