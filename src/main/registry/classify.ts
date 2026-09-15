import { TYPE_MATCH_THRESHOLD } from '@shared/confidence'
import { normalize, type RegistryAlias } from './index'

export interface TypeMatch {
  documentType: string
  confidence: number
  /** Alias del registry che ha prodotto il match, per la timeline. */
  phrase: string
  source: 'first-page' | 'filename'
}

/** Punteggi della v1: un titolo in prima pagina vale più di un nome di file. */
const SCORE_FIRST_PAGE = 0.9
const SCORE_FILENAME = 0.7

/**
 * Classificazione deterministica, senza LLM.
 *
 * 1. Normalizza testo della prima pagina e filename (minuscole, spazi collassati).
 * 2. Cerca `canonical_name`, `aliases` e `synonyms` come phrase match: 0,9 in prima
 *    pagina, 0,7 nel filename, vince il massimo fra i due; a parità vince l'alias
 *    più lungo, perché «certificato di agibilità» è più informativo di «certificato».
 * 3. Sotto 0,75 nessun tipo viene assegnato: il documento resta da classificare a mano.
 *
 * Conseguenza dei numeri scelti: 0,70 del nome del file sta sotto la soglia di 0,75,
 * quindi un match solo nel filename non basta mai da solo. È voluto: il nome di un
 * file è un indizio, non una prova. Per renderlo sufficiente basta abbassare
 * `TYPE_MATCH_THRESHOLD` a 0,70, ed è la prima manopola da girare in calibrazione.
 *
 * Il phrase match è su testo normalizzato con separatori di parola, così «fattura»
 * non corrisponde dentro «fatturato».
 */
export function matchDocumentType(
  aliases: RegistryAlias[],
  firstPageText: string,
  filename: string
): TypeMatch | null {
  const haystackPage = ` ${normalize(firstPageText)} `
  const haystackName = ` ${normalize(filename)} `

  let best: TypeMatch | null = null

  for (const alias of aliases) {
    const needle = ` ${alias.phrase} `
    const inPage = haystackPage.includes(needle)
    const inName = haystackName.includes(needle)
    if (!inPage && !inName) continue

    const confidence = inPage ? SCORE_FIRST_PAGE : SCORE_FILENAME
    const source: TypeMatch['source'] = inPage ? 'first-page' : 'filename'

    if (
      !best ||
      confidence > best.confidence ||
      (confidence === best.confidence && alias.phrase.length > best.phrase.length)
    ) {
      best = { documentType: alias.documentType, confidence, phrase: alias.phrase, source }
    }
  }

  if (!best || best.confidence < TYPE_MATCH_THRESHOLD) return null
  return best
}
