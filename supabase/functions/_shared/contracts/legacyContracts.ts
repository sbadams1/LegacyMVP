export type EditUseFor = "summarization" | "avatar" | "search" | "export";

export type MemoryRawEditStatus = "active" | "superseded" | "deleted";

export interface MemoryRawEditRow {
  id: string;
  user_id: string;
  raw_id: string;
  conversation_id: string | null;
  edited_content: string;
  edit_reason?: string | null;
  use_for: EditUseFor[];          // stored as jsonb array
  status: MemoryRawEditStatus;
  created_at: string;
  updated_at: string;
}

export interface StorySeedEntity {
  type: "person" | "place" | "organization" | "event" | "object" | "other";
  name: string;
  aliases?: string[];
}

export interface StorySeedRow {
  id: string;
  user_id: string;
  summary_id: string | null;
  conversation_id: string | null;

  title: string;
  seed_text: string;

  canonical_facts: Record<string, unknown>;
  entities: StorySeedEntity[];
  tags: string[];
  time_span?: { start_year?: number; end_year?: number; approx?: boolean } | null;
  confidence: number;

  source_raw_ids: string[];
  source_edit_ids: string[];

  created_at: string;
  updated_at: string;
}

/**
 * Effective transcript turn: preserves original content + optional overlay.
 * This is what downstream processors should use.
 */
export interface EffectiveTranscriptTurn {
  raw_id: string;
  role: "user" | "assistant";
  original_text: string;
  effective_text: string;

  has_edit: boolean;
  edit_id?: string;
  edit_reason?: string | null;
}
