import type {
  BoundingBox,
  DocumentLocation,
  StoredTypeClassification,
  TypeSignal
} from '@shared/types'
import type { ClassifierConfigV2 } from './config'
import type { Classification } from './engine'
import { normalizeClassifierTextV2 } from './normalize'

/** Il minimo di una pagina estratta che serve a ritrovare una frase: righe con coordinate. */
export interface LocatablePage {
  page: number
  lines: Array<{ text: string; bbox?: BoundingBox }>
}

/** Segnaposto del bonus di corroborazione: non è una frase del documento. */
const CORROBORATION = '__corroboration__'

/**
 * La prima riga del documento che contiene la frase, confrontata con la stessa
 * normalizzazione del classificatore. Una frase spezzata su due righe non si ritrova:
 * il candidato resta, senza un punto del documento da raggiungere.
 */
export function locatePhrase(pages: LocatablePage[], phrase: string): DocumentLocation | undefined {
  const needle = normalizeClassifierTextV2(phrase)
  if (!needle) return undefined
  for (const page of pages) {
    for (const line of page.lines) {
      if (!` ${normalizeClassifierTextV2(line.text)} `.includes(` ${needle} `)) continue
      return { page: page.page, text: line.text, ...(line.bbox ? { bbox: line.bbox } : {}) }
    }
  }
  return undefined
}

/**
 * Quello che il classificatore ha proposto, nella forma che la revisione e l'export
 * leggono: i candidati col punteggio e, per ogni indizio trovato nel testo, la riga del
 * documento da cui viene. Il nome del file non ha una riga: resta senza posizione.
 */
export function toTypeClassification(input: {
  classification: Classification
  pages: LocatablePage[]
  config?: ClassifierConfigV2 | undefined
}): StoredTypeClassification {
  const { classification } = input

  if (classification.engine === 'v1') {
    const match = classification.match
    const firstPage = input.pages.slice(0, 1)
    return {
      engine: 'v1',
      version: null,
      decision: match ? 'ASSIGN' : 'UNKNOWN',
      reason: match ? 'OK' : 'BELOW_THRESHOLD',
      proposedType: match?.documentType ?? null,
      confidence: match?.confidence ?? 0,
      margin: null,
      threshold: null,
      minimumMargin: null,
      candidates: match
        ? [
            {
              documentType: match.documentType,
              score: match.confidence,
              signals: [
                signal(
                  match.source === 'first-page' ? 'page' : 'filename',
                  match.phrase,
                  match.confidence,
                  firstPage
                )
              ]
            }
          ]
        : []
    }
  }

  const match = classification.match
  const pages = input.config ? input.pages.slice(0, input.config.defaults.max_pages) : input.pages
  return {
    engine: 'v2',
    version: input.config?.version ?? null,
    decision: match.decision,
    reason: match.reason,
    proposedType: match.decision === 'ASSIGN' ? match.documentType : null,
    confidence: round(match.confidence),
    margin: round(match.margin),
    threshold: input.config?.defaults.auto_assign_threshold ?? null,
    minimumMargin: input.config?.defaults.minimum_margin ?? null,
    candidates: match.candidates.map((candidate) => ({
      documentType: candidate.documentType,
      score: round(candidate.score),
      signals: candidate.evidence
        .filter((item) => item.phrase !== CORROBORATION)
        .map((item) => signal(item.source, item.phrase, item.delta, pages))
    }))
  }
}

/** Quattro decimali bastano a un punteggio e rendono leggibile il JSON salvato. */
function round(value: number): number {
  return Math.round(value * 1e4) / 1e4
}

function signal(
  source: TypeSignal['source'],
  phrase: string,
  delta: number,
  pages: LocatablePage[]
): TypeSignal {
  // Il nome del file e la memoria del modulo non sono righe del documento.
  const location =
    source === 'filename' || source === 'template-memory' ? undefined : locatePhrase(pages, phrase)
  return {
    source,
    phrase,
    delta: round(delta),
    ...(location ? { location } : {})
  }
}
