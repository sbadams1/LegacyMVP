export function countWordsApprox(text: string | null | undefined): number {
  if (!text) return 0;
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}
