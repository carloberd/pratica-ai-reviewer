import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { averageConfidence, bandOf } from '@shared/confidence'
import type { RegistryFieldName } from '@shared/fields'
import { fieldLabel, sortFieldNames, UNIVERSAL_FIELDS } from '@shared/fields'
import { TYPE_MATCH_REASON_LABELS } from '@shared/review-workspace'
import { firstPageLines, templateFingerprint } from '@shared/template-fingerprint'
import type { EngineSelection } from './config'
import type { EvidenceInput } from './db/dao/evidence'
import type { ExtractionRunInput } from './db/dao/extraction-runs'
import type { FieldInput } from './db/dao/fields'
import type { PageInput } from './db/dao/pages'
import type { Repository } from './db/repository'
import { prefillFields } from './extract/heuristics'
import type { OcrService } from './extract/ocr'
import { extractText } from './extract/text'
import type { ExtractedText } from './extract/types'
import { extractFactsV2 } from './extract/v2/fact-reader'
import type { ExtractionRegistryV2 } from './extract/v2/profile-loader'
import type { Registry } from './registry'
import type { TypeMatchV2 } from './registry/v2/classify-v2'
import type { ClassifierConfigV2 } from './registry/v2/config'
import { type Classification, classifyWithSelectedEngine } from './registry/v2/engine'
import { toTypeClassification } from './registry/v2/type-classification'

/** Versione del motore v2 registrata in `extraction_runs.engine_version`. */
export const EXTRACTION_ENGINE_V2_VERSION = 'extraction-brain-v2/2.1.0-draft.1'

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
  engines: EngineSelection
  /** Obbligatoria con `CLASSIFIER_ENGINE=v2`. */
  classifierConfigV2?: ClassifierConfigV2 | undefined
  /** Obbligatorio con `EXTRACTION_ENGINE=v2`. */
  extractionRegistryV2?: ExtractionRegistryV2 | undefined
  /** Nomi campo v1 -> id dell'ontologia: le correzioni si ritrovano cambiando motore. */
  legacyFieldMap?: Record<string, string> | undefined
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

interface PreparedExtraction {
  evidence: EvidenceInput[]
  fields: FieldInput[]
  confidence: number
  filled: number
  total: number
  event: { title: string; detail: string }
  /** Solo col motore v2. */
  run?: ExtractionRunInput
}

/**
 * Classificazione e precompilazione di un documento.
 *
 * Tutte le scritture (tipo, campi, evidenze, righe FTS, eventi) stanno in una sola
 * transazione: un'estrazione interrotta a metà lascerebbe un documento con evidenze
 * che non corrispondono ai campi, ed è lo stato peggiore possibile per chi revisiona.
 *
 * Il motore di classificazione e quello di estrazione si scelgono separatamente. Col v2
 * un tipo non riconosciuto non produce campi: senza tipo non c'è un profilo, e i 4
 * campi universali della v1 chiedevano valori che molti tipi non hanno.
 */
export function createDocumentProcessor(deps: ProcessorDeps) {
  const { repo, registry, engines } = deps

  if (engines.classifier === 'v2' && !deps.classifierConfigV2) {
    throw new Error('CLASSIFIER_ENGINE=v2 richiede classifier_signals_v2.json.')
  }
  if (engines.extraction === 'v2' && !deps.extractionRegistryV2) {
    throw new Error('EXTRACTION_ENGINE=v2 richiede i profili di estrazione v2.')
  }
  const correctionAliases = aliasesFromLegacyMap(deps.legacyFieldMap ?? {})

  return async function processDocument(input: ProcessDocumentInput): Promise<ProcessOutcome> {
    const startedAt = new Date().toISOString()
    const extracted = await extractText({
      filePath: input.cachedPath,
      mime: input.mime,
      ocr: deps.ocr
    })
    const contentSha256 = createHash('sha256')
      .update(await readFile(input.cachedPath))
      .digest('hex')

    const classification = classifyWithSelectedEngine({
      engine: engines.classifier,
      aliases: registry.aliases(),
      pages: extracted.pages.map((page) => page.text),
      filename: input.filename,
      configV2: deps.classifierConfigV2
    })

    // Un tipo assegnato a mano dal revisore non va sovrascritto da un match automatico.
    const existing = repo.documents.get(input.documentId)
    const manualType =
      existing?.document_type && existing.type_confidence === null ? existing.document_type : null

    const documentType = manualType ?? classification.documentType
    const typeConfidence = manualType ? null : classification.confidence

    const prepared =
      engines.extraction === 'v2'
        ? prepareV2({
            registry: deps.extractionRegistryV2!,
            documentType,
            extracted,
            classification,
            manualType: manualType !== null,
            startedAt
          })
        : prepareV1(registry, documentType, extracted)

    const band = bandOf(prepared.confidence)

    repo.transaction(() => {
      repo.documents.setContentIdentity(input.documentId, {
        contentSha256,
        templateFingerprint: firstPageFingerprint(extracted)
      })
      // Le righe su cui si ritroveranno le selezioni del revisore: le stesse del motore.
      repo.pages.replaceForDocument(input.documentId, pagesOf(extracted))
      repo.documents.setExtraction(input.documentId, {
        documentType,
        typeConfidence,
        confidence: prepared.confidence,
        confidenceBand: band,
        textSource: extracted.source
      })
      // Anche con un tipo scelto a mano: è la proposta del motore, e l'export la mette
      // accanto alla scelta del revisore.
      repo.documents.setClassification(
        input.documentId,
        toTypeClassification({
          classification,
          pages: extracted.pages,
          config: deps.classifierConfigV2
        })
      )
      // L'ordine conta: le evidenze prima, perché i campi ci puntano.
      repo.evidence.replaceForDocument(input.documentId, prepared.evidence)
      repo.fields.replaceForDocument(input.documentId, prepared.fields, {
        correctionAliases,
        keepUnmatchedCorrections: engines.extraction === 'v2'
      })
      // Una correzione che il nuovo run ha assorbito si porta via la sua selezione.
      repo.evidence.pruneReviewer(input.documentId)
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
      } else {
        const { title, detail } = describeClassification(classification, deps.classifierConfigV2)
        repo.events.add(input.documentId, title, detail)
      }

      repo.events.add(input.documentId, prepared.event.title, prepared.event.detail)

      if (prepared.run) repo.extractionRuns.add(input.documentId, prepared.run)
    })

    return {
      documentType,
      typeConfidence,
      confidence: prepared.confidence,
      filledFields: prepared.filled,
      totalFields: prepared.total,
      textSource: extracted.source,
      ocrPages: extracted.ocrPages
    }
  }
}

// ---------------------------------------------------------------------------
// Il testo come l'ha letto l'elaborazione
// ---------------------------------------------------------------------------

/** Le pagine da salvare, ognuna con la sorgente del suo testo. */
export function pagesOf(extracted: ExtractedText): PageInput[] {
  const ocr = new Set(extracted.ocrPages)
  return extracted.pages.map((page) => ({
    page: page.page,
    textSource: extracted.source === 'DOCX' ? 'DOCX' : ocr.has(page.page) ? 'OCR' : 'NATIVE_TEXT',
    lines: page.lines
  }))
}

/**
 * L'impronta del layout della prima pagina, dalle stesse righe che l'export legge quando
 * la calcola da sé. Una prima pagina letta con OCR ha righe diverse da quelle del text
 * layer che l'export rilegge senza OCR: resta `null`, e ci pensa l'export come per i
 * documenti elaborati prima.
 */
export function firstPageFingerprint(extracted: ExtractedText): string | null {
  const first = extracted.pages[0]
  if (!first || extracted.ocrPages.includes(first.page)) return null
  return templateFingerprint(firstPageLines(first))
}

// ---------------------------------------------------------------------------
// v1: i campi dello schema del registry, i 4 universali senza tipo
// ---------------------------------------------------------------------------

function prepareV1(
  registry: Registry,
  documentType: string | null,
  extracted: ExtractedText
): PreparedExtraction {
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

  const evidence: EvidenceInput[] = []
  const fields: FieldInput[] = []

  for (const name of ordered) {
    const candidate = byName.get(name)
    if (!candidate) {
      fields.push({ name, label: fieldLabel(name), value: null, confidence: 0 })
      continue
    }
    const evidenceId = randomUUID()
    evidence.push({
      id: evidenceId,
      page: candidate.evidence.page,
      text: candidate.evidence.text,
      bbox: candidate.evidence.bbox ?? null,
      confidence: candidate.confidence
    })
    fields.push({
      name,
      label: fieldLabel(name),
      value: candidate.value,
      confidence: candidate.confidence,
      evidenceId
    })
  }

  return {
    evidence,
    fields,
    confidence: averageConfidence(candidates.map((candidate) => candidate.confidence)),
    filled: candidates.length,
    total: ordered.length,
    event: {
      title: 'Campi precompilati',
      detail: `${candidates.length} campi su ${ordered.length} con evidenza verbatim.`
    }
  }
}

// ---------------------------------------------------------------------------
// v2: il profilo del tipo, niente campi senza tipo
// ---------------------------------------------------------------------------

function prepareV2(input: {
  registry: ExtractionRegistryV2
  documentType: string | null
  extracted: ExtractedText
  classification: Classification
  manualType: boolean
  startedAt: string
}): PreparedExtraction {
  const { registry, documentType, extracted } = input
  const run = (
    status: ExtractionRunInput['status'],
    extra: Partial<ExtractionRunInput> & { metrics?: Record<string, unknown> } = {}
  ): ExtractionRunInput => ({
    engineVersion: EXTRACTION_ENGINE_V2_VERSION,
    schemaVersion: registry.schemaVersion(),
    documentType: documentType ?? '',
    startedAt: input.startedAt,
    completedAt: new Date().toISOString(),
    status,
    missingRequired: extra.missingRequired ?? [],
    conflicts: extra.conflicts ?? [],
    metrics: {
      textSource: extracted.source,
      classifier: classifierAudit(input.classification, input.manualType),
      ...extra.metrics
    }
  })
  const skipped = (detail: string, status: ExtractionRunInput['status']): PreparedExtraction => ({
    evidence: [],
    fields: [],
    confidence: 0,
    filled: 0,
    total: 0,
    event: { title: 'Campi non estratti', detail },
    run: run(status)
  })

  if (!documentType) {
    return skipped(
      'Tipo non riconosciuto: senza tipo non c’è un profilo di campi da cercare. I campi si precompilano quando il tipo viene assegnato a mano.',
      'SKIPPED_UNKNOWN_TYPE'
    )
  }

  const profileSource = registry.profileSource(documentType)
  if (profileSource === 'MISSING') {
    return skipped(
      `Nessun profilo di estrazione per «${documentType}»: il tipo non ha un profilo v2 né uno schema nel registry.`,
      'SKIPPED_NO_PROFILE'
    )
  }

  const result = extractFactsV2({
    documentType,
    pages: extracted.pages,
    registry,
    fromOcr: extracted.source === 'OCR'
  })

  const evidence: EvidenceInput[] = []
  const fields: FieldInput[] = []
  const addEvidence = (
    item: (typeof result.facts)[number]['evidence'][number],
    confidence: number
  ) => {
    const id = randomUUID()
    evidence.push({ id, page: item.page, text: item.text, bbox: item.bbox ?? null, confidence })
    return id
  }

  for (const fact of result.facts) {
    const spec = registry.field(fact.fieldId)
    const common = {
      name: fact.fieldId,
      label: spec?.label_it ?? fact.fieldId,
      confidence: fact.confidence,
      semanticType: spec?.type ?? null,
      role: fact.role,
      cardinality: fact.cardinality,
      reviewStatus: fact.reviewStatus,
      validationErrors: fact.validationErrors
    }

    if (fact.cardinality === 'many') {
      const values = Array.isArray(fact.value) ? (fact.value as string[]) : []
      const items = values.map((value, itemIndex) => {
        const source = fact.evidence[itemIndex]
        return {
          itemIndex,
          value,
          confidence: fact.confidence,
          evidenceId: source ? addEvidence(source, fact.confidence) : null
        }
      })
      fields.push({ ...common, value: null, evidenceId: items[0]?.evidenceId ?? null, items })
      continue
    }

    const source = fact.evidence[0]
    if (fact.value === null || !source) {
      fields.push({ ...common, value: null })
      continue
    }
    fields.push({
      ...common,
      value: String(fact.value),
      evidenceId: addEvidence(source, fact.confidence)
    })
  }

  const filled = result.facts.filter((fact) => fact.value !== null).length
  const labelOf = (fieldId: string) => registry.field(fieldId)?.label_it ?? fieldId
  const profile =
    profileSource === 'LEGACY_FALLBACK'
      ? 'profilo ricavato dallo schema v1 (LEGACY_FALLBACK)'
      : `profilo v2 ${result.schemaState}`
  const parts = [`${filled} campi su ${result.facts.length} con evidenza verbatim, ${profile}.`]
  if (result.missingRequired.length > 0) {
    parts.push(`Obbligatori senza evidenza: ${result.missingRequired.map(labelOf).join(', ')}.`)
  }
  if (result.conflicts.length > 0) {
    parts.push(
      result.conflicts.length === 1
        ? 'Un conflitto fra candidati da verificare.'
        : `${result.conflicts.length} conflitti fra candidati da verificare.`
    )
  }

  return {
    evidence,
    fields,
    confidence: result.confidence,
    filled,
    total: result.facts.length,
    event: { title: 'Campi precompilati', detail: parts.join(' ') },
    run: run('COMPLETED', {
      missingRequired: result.missingRequired,
      conflicts: result.conflicts,
      metrics: {
        profileSource,
        schemaState: result.schemaState,
        coverage: result.coverage,
        confidence: result.confidence,
        filledFields: filled,
        totalFields: result.facts.length,
        reviewStatus: countBy(result.facts.map((fact) => fact.reviewStatus))
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Timeline e audit
// ---------------------------------------------------------------------------

const REASONS = TYPE_MATCH_REASON_LABELS

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function decimal(value: number): string {
  return value.toFixed(2).replace('.', ',')
}

export function describeClassification(
  classification: Classification,
  config?: ClassifierConfigV2
): { title: string; detail: string } {
  if (classification.engine === 'v1') {
    const match = classification.match
    if (!match) {
      return {
        title: 'Tipo non riconosciuto',
        detail: 'Nessun alias del registry supera la soglia di 0,75: il tipo va assegnato a mano.'
      }
    }
    return {
      title: 'Tipo riconosciuto',
      detail: `${match.documentType} al ${Math.round(match.confidence * 100)}% da «${match.phrase}» ${
        match.source === 'first-page' ? 'in prima pagina' : 'nel nome del file'
      }.`
    }
  }

  const match = classification.match
  const top = match.candidates[0]
  const runnerUp = match.runnerUp
    ? `secondo candidato ${match.runnerUp.documentType} al ${percent(match.runnerUp.confidence)}`
    : 'nessun altro candidato'

  if (match.decision === 'ASSIGN') {
    const phrases = match.evidence
      .filter((item) => item.delta > 0 && item.phrase !== '__corroboration__')
      .map((item) => `«${item.phrase}»`)
    const unique = [...new Set(phrases)].slice(0, 3).join(', ')
    return {
      title: 'Tipo riconosciuto',
      detail: `${match.documentType} al ${percent(match.confidence)} col classificatore v2 da ${unique}; ${runnerUp}, margine ${decimal(match.margin)}.`
    }
  }

  const reason = match.reason as Exclude<TypeMatchV2['reason'], 'OK'>
  const thresholds = config
    ? ` Soglia ${decimal(config.defaults.auto_assign_threshold)}, margine minimo ${decimal(config.defaults.minimum_margin)}.`
    : ''
  const candidates = top
    ? ` Miglior candidato ${top.documentType} al ${percent(top.score)}; ${runnerUp}, margine ${decimal(match.margin)}.`
    : ''
  return {
    title: 'Tipo non riconosciuto',
    detail: `Classificatore v2: ${REASONS[reason]} (${reason}).${candidates}${top ? thresholds : ''} Il tipo va assegnato a mano.`
  }
}

function classifierAudit(
  classification: Classification,
  manualType: boolean
): Record<string, unknown> {
  if (classification.engine === 'v1') {
    return {
      engine: 'v1',
      manualType,
      documentType: classification.match?.documentType ?? null,
      confidence: classification.match?.confidence ?? null,
      phrase: classification.match?.phrase ?? null,
      source: classification.match?.source ?? null
    }
  }
  const match = classification.match
  return {
    engine: 'v2',
    manualType,
    decision: match.decision,
    reason: match.reason,
    top: match.candidates[0]
      ? { documentType: match.candidates[0].documentType, score: match.candidates[0].score }
      : null,
    runnerUp: match.runnerUp,
    margin: match.margin
  }
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

/**
 * Per un nome campo, gli altri nomi con cui la stessa correzione può essere stata
 * salvata: l'id dell'ontologia per un nome v1, i nomi v1 per un id dell'ontologia.
 */
export function aliasesFromLegacyMap(map: Record<string, string>): (name: string) => string[] {
  const legacyByField = new Map<string, string[]>()
  for (const [legacy, fieldId] of Object.entries(map)) {
    legacyByField.set(fieldId, [...(legacyByField.get(fieldId) ?? []), legacy])
  }
  return (name) => {
    const fieldId = map[name]
    return [...(fieldId ? [fieldId] : []), ...(legacyByField.get(name) ?? [])]
  }
}
