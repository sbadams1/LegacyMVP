// pipelines/themes/cluster_match.ts

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccard(a: string, b: string): number {
  const A = new Set(normalize(a).split(" ").filter(Boolean));
  const B = new Set(normalize(b).split(" ").filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function themeSimilarity(a: string, b: string): number {
  const jac = jaccard(a, b);
  const na = normalize(a);
  const nb = normalize(b);
  const prefixBonus = (na.startsWith(nb) || nb.startsWith(na)) ? 0.15 : 0;
  return Math.min(1, jac + prefixBonus);
}
