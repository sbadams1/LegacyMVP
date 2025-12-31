// supabase/functions/_shared/text_utils.ts
export function countWordsApprox(text: string | null | undefined): number {
  if (!text) return 0;
  const t = String(text).trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}
