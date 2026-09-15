/**
 * Unisce classi CSS scartando i valori assenti.
 *
 * Serve perché `tsconfig.web.json` usa `noUncheckedIndexedAccess`: l'accesso a un
 * CSS module restituisce `string | undefined`, e interpolarlo in un template literal
 * scriverebbe la stringa "undefined" nel DOM.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(' ')
}
