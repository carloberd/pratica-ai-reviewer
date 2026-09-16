import type { EngineVersion } from '../../config'
import { matchDocumentType, type TypeMatch } from '../classify'
import type { RegistryAlias } from '../index'
import { matchDocumentTypeV2, type TypeMatchV2 } from './classify-v2'
import type { ClassifierConfigV2 } from './config'

/**
 * Esito della classificazione con il motore scelto.
 *
 * Il match di ciascun motore resta intero: la pipeline ne racconta i dettagli nella
 * timeline (frase e posizione per il v1; candidati, margine e motivo per il v2).
 */
export type Classification =
  | {
      engine: 'v1'
      documentType: string | null
      confidence: number | null
      match: TypeMatch | null
    }
  | { engine: 'v2'; documentType: string | null; confidence: number | null; match: TypeMatchV2 }

export function classifyWithSelectedEngine(input: {
  engine: EngineVersion
  aliases: RegistryAlias[]
  /** Testo di tutte le pagine: il v1 legge solo la prima, il v2 fino a `max_pages`. */
  pages: string[]
  filename: string
  configV2: ClassifierConfigV2 | undefined
}): Classification {
  if (input.engine === 'v1') {
    const match = matchDocumentType(input.aliases, input.pages[0] ?? '', input.filename)
    return {
      engine: 'v1',
      documentType: match?.documentType ?? null,
      confidence: match?.confidence ?? null,
      match
    }
  }

  if (!input.configV2) {
    throw new Error('Classificatore v2 selezionato senza la configurazione dei segnali.')
  }

  const match = matchDocumentTypeV2({
    aliases: input.aliases,
    pages: input.pages,
    filename: input.filename,
    config: input.configV2
  })

  // Un UNKNOWN non ha confidence di tipo: una confidence non nulla con tipo nullo
  // verrebbe scambiata dalla pipeline per un'assegnazione a mano.
  const assigned = match.decision === 'ASSIGN'
  return {
    engine: 'v2',
    documentType: assigned ? match.documentType : null,
    confidence: assigned ? match.confidence : null,
    match
  }
}
