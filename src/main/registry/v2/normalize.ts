/**
 * Classifier-v2 normalization.
 *
 * Differences from v1:
 * - folds accents;
 * - splits letter↔digit boundaries: `UNICA2026` -> `unica 2026`;
 * - normalizes apostrophes/punctuation;
 * - preserves word boundaries.
 */
export function normalizeClassifierTextV2(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[‘’“”]/g, "'")
    .replace(/([\p{L}])([\p{N}])/gu, '$1 $2')
    .replace(/([\p{N}])([\p{L}])/gu, '$1 $2')
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function containsPhraseV2(haystack: string, phrase: string): boolean {
  const h = ` ${normalizeClassifierTextV2(haystack)} `
  const p = ` ${normalizeClassifierTextV2(phrase)} `
  return p.trim().length > 0 && h.includes(p)
}
