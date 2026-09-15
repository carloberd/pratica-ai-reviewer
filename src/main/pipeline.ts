import { randomUUID } from 'node:crypto'
import { averageConfidence, bandOf } from '@shared/confidence'
import type { RegistryFieldName } from '@shared/fields'
import { fieldLabel, sortFieldNames, UNIVERSAL_FIELDS } from '@shared/fields'
import type { EvidenceInput } from './db/dao/evidence'
import type { FieldInput } from './db/dao/fields'
import type { Repository } from './db/repository'
import { prefillFields } from './extract/heuristics'
import type { OcrService } from './extract/ocr'
import { extractText } from './extract/text'
import type { ExtractedText } from './extract/types'
import type { Registry } from './registry'
import { matchDocumentType } from './registry/classify'

export interface ProcessDocumentInput {
  documentId: string
  cachedPath: string
  mime: string
  filename: string
}

export interface ProcessorDeps {
  repo: Repository
  registry: Registry
  ocr?: OcrService | undefined
}

export interface ProcessOutcome {
  documentType: string | null
  typeConfidence: number | null
  confidence: number
  filledFields: number
  totalFields: number
  textSource: ExtractedText['source']
  ocrPages: number[]
}

/**
 * Classificazione e precompilazione di un documento.
 *
 * Tutte le scritture (tipo, campi, evidenze, righe FTS, eventi) stanno in una sola
 * transazione: un'estrazione interrotta a metà lascerebbe un documento con evidenze
 * che non corrispondono ai campi, ed è lo stato peggiore possibile per chi revisiona.
 */
export function createDocumentProcessor(deps: ProcessorDeps) {
  const { repo, registry } = deps

  return async function processDocument(input: ProcessDocumentInput): Promise<ProcessOutcome> {
    const extracted = await extractText({
      filePath: input.cachedPath,
      mime: input.mime,
      ocr: deps.ocr
    })

    const firstPageText = extracted.pages[0]?.text ?? ''
    const match = matchDocumentType(registry.aliases(), firstPageText, input.filename)

    // Un tipo assegnato a mano dal revisore non va sovrascritto da un match automatico.
    const existing = repo.documents.get(input.documentId)
    const manualType =
      existing?.document_type && existing.type_confidence === null ? existing.document_type : null

    const documentType = manualType ?? match?.documentType ?? null
    const typeConfidence = manualType ? null : (match?.confidence ?? null)

    // Solo i campi dichiarati dallo schema del tipo. Senza tipo restano i 4 universali,
    // dichiarati da tutti e 511 gli schemi del registry.
    const declared = documentType ? registry.fieldsFor(documentType) : []
    const names = (declared.length > 0 ? declared : UNIVERSAL_FIELDS) as RegistryFieldName[]
    const ordered = sortFieldNames(names) as RegistryFieldName[]

    const candidates = prefillFields({
      fields: ordered,
      pages: extracted.pages,
      fromOcr: extracted.source === 'OCR'
    })
    const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]))

    const evidenceInputs: EvidenceInput[] = []
    const fieldInputs: FieldInput[] = []

    for (const name of ordered) {
      const candidate = byName.get(name)
      if (!candidate) {
        fieldInputs.push({ name, label: fieldLabel(name), value: null, confidence: 0 })
        continue
      }
      const evidenceId = randomUUID()
      evidenceInputs.push({
        id: evidenceId,
        page: candidate.evidence.page,
        text: candidate.evidence.text,
        bbox: candidate.evidence.bbox ?? null,
        confidence: candidate.confidence
      })
      fieldInputs.push({
        name,
        label: fieldLabel(name),
        value: candidate.value,
        confidence: candidate.confidence,
        evidenceId
      })
    }

    const confidence = averageConfidence(candidates.map((candidate) => candidate.confidence))
    const band = bandOf(confidence)

    repo.transaction(() => {
      repo.documents.setExtraction(input.documentId, {
        documentType,
        typeConfidence,
        confidence,
        confidenceBand: band,
        textSource: extracted.source
      })
      // L'ordine conta: le evidenze prima, perché i campi ci puntano.
      repo.evidence.replaceForDocument(input.documentId, evidenceInputs)
      repo.fields.replaceForDocument(input.documentId, fieldInputs)
      repo.search.replaceForDocument(
        input.documentId,
        input.filename,
        extracted.pages.map((page) => ({ page: page.page, text: page.text }))
      )

      if (extracted.ocrPages.length > 0) {
        repo.events.add(
          input.documentId,
          'OCR eseguito',
          `Nessun text layer su ${extracted.ocrPages.length === 1 ? 'una pagina' : `${extracted.ocrPages.length} pagine`}: testo ricavato con tesseract (ita+eng).`
        )
      }

      if (manualType) {
        repo.events.add(
          input.documentId,
          'Tipo confermato',
          `Mantenuto il tipo «${manualType}» assegnato a mano dal revisore.`
        )
      } else if (match) {
        repo.events.add(
          input.documentId,
          'Tipo riconosciuto',
          `${match.documentType} al ${Math.round(match.confidence * 100)}% da «${match.phrase}» ${
            match.source === 'first-page' ? 'in prima pagina' : 'nel nome del file'
          }.`
        )
      } else {
        repo.events.add(
          input.documentId,
          'Tipo non riconosciuto',
          'Nessun alias del registry supera la soglia di 0,75: il tipo va assegnato a mano.'
        )
      }

      repo.events.add(
        input.documentId,
        'Campi precompilati',
        `${candidates.length} campi su ${ordered.length} con evidenza verbatim.`
      )
    })

    return {
      documentType,
      typeConfidence,
      confidence,
      filledFields: candidates.length,
      totalFields: ordered.length,
      textSource: extracted.source,
      ocrPages: extracted.ocrPages
    }
  }
}
