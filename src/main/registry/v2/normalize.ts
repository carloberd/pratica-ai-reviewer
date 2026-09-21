/**
 * Classifier-v2 normalization.
 *
 * Differences from v1:
 * - folds accents;
 * - splits letter↔digit boundaries: `UNICA2026` -> `unica 2026`;
 * - normalizes apostrophes/punctuation;
 * - preserves word boundaries.
 *
 * L'apostrofo conta solo fra due lettere, dove è un'elisione: `dell'iscrizione` resta
 * intero. A fine parola non è un apostrofo ma un accento scritto senza accento —
 * `IDENTITA'` è come si scrive `IDENTITÀ` su una tastiera italiana, ed è anche come l'OCR
 * rende più spesso un accento maiuscolo — e va tolto, o la parola non combacia più con
 * l'alias a confini di parola. Nell'export del 21/09/2026 sette carte d'identità
 * chiudevano `NO_SIGNAL`, senza nemmeno un candidato: il testo e il nome del file
 * scrivevano tutti e due `CARTA DI IDENTITA'`. Stesso trattamento a inizio parola, dove
 * arriva dalle virgolette curve: `“ALFA”` diventa `alfa`, non `'alfa'`.
 */
export function normalizeClassifierTextV2(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[‘’“”]/g, "'")
    .replace(/(?<!\p{L})'|'(?!\p{L})/gu, '')
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
