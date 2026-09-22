import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { bandOf } from '@shared/confidence'
import { appliesRules, LEARNER_VERSION, type LearningMode } from '@shared/local-learning'
import {
  firstPageLines,
  normalizedTemplateSignature,
  templateFingerprint
} from '@shared/template-fingerprint'
import type { EvidenceInput } from './db/dao/evidence'
import type { ExtractionRunInput } from './db/dao/extraction-runs'
import type { FieldInput } from './db/dao/fields'
import type { PageInput } from './db/dao/pages'
import type { Repository } from './db/repository'
import { LEGACY_FIELD_MAP } from './extract/legacy-field-map'
import type { OcrService } from './extract/ocr'
import { extractText } from './extract/text'
import type { ExtractedText } from './extract/types'
import { extractFactsV2, type LearnedLabel } from './extract/v2/fact-reader'
import type { ExtractionRegistry } from './extract/v2/profile-loader'
import { learnedLabelsFor } from './learning-anchors'
import { templateMemoryFor } from './learning-templates'

/**
 * Quanto vale un tipo proposto dalla memoria di un modulo. È il punteggio che il vecchio
 * classificatore dava a quella stessa prova: una proposta da confermare, non una certezza.
 */
const TEMPLATE_TYPE_SCORE = 0.74

/** Versione del motore registrata in `extraction_runs.engine_version`. */
export const EXTRACTION_ENGINE_V2_VERSION = 'extraction-brain/3.0.0'

export interface ProcessDocumentInput {
  documentId: string
  cachedPath: string
  mime: string
  filename: string
}

export interface ProcessorDeps {
  repo: Repository
  ocr?: OcrService | undefined
  extractionRegistry: ExtractionRegistry
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
 * Precompilazione di un documento.
 *
 * Tutte le scritture (campi, evidenze, righe FTS, eventi) stanno in una sola transazione:
 * un'estrazione interrotta a metà lascerebbe un documento con evidenze che non
 * corrispondono ai campi, ed è lo stato peggiore possibile per chi revisiona.
 *
 * Il tipo non si indovina: lo sceglie il revisore. Il registry è la mappa «tipo → campi»
 * e non ha più i segnali con cui un classificatore tirava a indovinare; finché il tipo
 * non c'è, non c'è una mappa, e non si precompila niente.
 */
export function createDocumentProcessor(deps: ProcessorDeps) {
  const { repo } = deps
  const registry = deps.extractionRegistry
  const correctionAliases = aliasesFromLegacyMap(LEGACY_FIELD_MAP)

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

    const fingerprint = firstPageFingerprint(extracted)
    const templateSignature = firstPageTemplateSignature(extracted)
    // Le regole apprese valgono in LEARNING e FROZEN; in BASELINE decide solo il registry.
    const learningMode = repo.learning.mode()
    const rules = appliesRules(learningMode) ? repo.learning.activeRules() : []
    const templateMemory = templateMemoryFor(rules, fingerprint, templateSignature)

    // Il tipo lo sceglie il revisore, e niente lo sovrascrive. L'unica eccezione è la
    // memoria dei moduli: quando lo stesso stampato è già stato chiuso più volte con lo
    // stesso tipo, quel tipo è una decisione dei revisori, non un'ipotesi sul testo. Si
    // propone con la sua somiglianza, così la scheda distingue una proposta dalla scelta.
    const existing = repo.documents.get(input.documentId)
    const manualType =
      existing?.document_type && existing.type_confidence === null ? existing.document_type : null
    const fromTemplate = manualType ? null : (templateMemory[0] ?? null)
    const documentType = manualType ?? fromTemplate?.documentType ?? null
    const typeConfidence = fromTemplate
      ? round(fromTemplate.similarity * TEMPLATE_TYPE_SCORE)
      : null

    const learnedLabels = documentType
      ? learnedLabelsFor(rules, documentType, fingerprint, templateSignature)
      : []

    const prepared = prepareV2({
      registry,
      documentType,
      extracted,
      startedAt,
      learning: {
        mode: learningMode,
        labels: learnedLabels,
        templateRuleIds: templateMemory.map((memory) => memory.ruleId)
      }
    })

    const band = bandOf(prepared.confidence)

    repo.transaction(() => {
      repo.documents.setContentIdentity(input.documentId, {
        contentSha256,
        templateFingerprint: fingerprint,
        templateSignature
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
      // L'ordine conta: le evidenze prima, perché i campi ci puntano.
      repo.evidence.replaceForDocument(input.documentId, prepared.evidence)
      repo.fields.replaceForDocument(input.documentId, prepared.fields, {
        correctionAliases,
        keepUnmatchedCorrections: true
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

      if (extracted.ocrFailedPages.length > 0) {
        repo.events.add(
          input.documentId,
          'OCR non riuscito',
          `${pagesLabel(extracted.ocrFailedPages)} senza text layer che l’OCR non ha letto: i campi sono incompleti e il documento va ripassato.${extracted.ocrError ? ` Motivo: ${extracted.ocrError}` : ''}`
        )
      }

      if (manualType) {
        repo.events.add(
          input.documentId,
          'Tipo confermato',
          `Mantenuto il tipo «${manualType}» assegnato dal revisore.`
        )
      } else if (fromTemplate) {
        repo.events.add(
          input.documentId,
          'Tipo proposto',
          `${fromTemplate.documentType} dalla memoria del modulo, già revisionato con questo tipo` +
            `${fromTemplate.similarity < 1 ? ` (testata simile al ${percent(fromTemplate.similarity)})` : ''}.`
        )
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

/** «una pagina» / «3 pagine»: gli eventi parlano al revisore, non in numeri di pagina. */
function pagesLabel(pages: number[]): string {
  return pages.length === 1 ? 'Una pagina' : `${pages.length} pagine`
}

/** Le pagine da salvare, ognuna con la sorgente del suo testo. */
export function pagesOf(extracted: ExtractedText): PageInput[] {
  const ocr = new Set(extracted.ocrPages)
  const failed = new Set(extracted.ocrFailedPages)
  return extracted.pages.map((page) => ({
    page: page.page,
    textSource:
      extracted.source === 'DOCX'
        ? 'DOCX'
        : ocr.has(page.page)
          ? 'OCR'
          : failed.has(page.page)
            ? 'OCR_FAILED'
            : 'NATIVE_TEXT',
    lines: page.lines
  }))
}

/**
 * L'impronta del layout della prima pagina, dalle stesse righe che l'export legge quando
 * la calcola da sé. Una prima pagina letta con OCR ha righe diverse da quelle del text
 * layer che l'export rilegge senza OCR: resta `null`, e ci pensa l'export come per i
 * documenti elaborati prima. Anche una prima pagina che l'OCR non ha letto resta senza
 * impronta: non è un layout, è una pagina vuota, e tutte le scansioni non lette
 * finirebbero sotto la stessa impronta.
 */
export function firstPageFingerprint(extracted: ExtractedText): string | null {
  const first = extracted.pages[0]
  if (!first || extracted.ocrPages.includes(first.page)) return null
  if (extracted.ocrFailedPages.includes(first.page)) return null
  return templateFingerprint(firstPageLines(first))
}

/**
 * La firma della prima pagina, con la stessa disciplina dell'impronta: niente da una
 * pagina letta con OCR, che non è il modulo ma come si è riusciti a leggerlo.
 */
export function firstPageTemplateSignature(extracted: ExtractedText) {
  const first = extracted.pages[0]
  if (!first || extracted.ocrPages.includes(first.page)) return null
  if (extracted.ocrFailedPages.includes(first.page)) return null
  return normalizedTemplateSignature(firstPageLines(first))
}

// ---------------------------------------------------------------------------
// La mappa del tipo: niente campi senza tipo
// ---------------------------------------------------------------------------

function prepareV2(input: {
  registry: ExtractionRegistry
  documentType: string | null
  extracted: ExtractedText
  startedAt: string
  /** Modalità del learner, etichette e memorie dei moduli attive per questo documento. */
  learning: { mode: LearningMode; labels: LearnedLabel[]; templateRuleIds: string[] }
}): PreparedExtraction {
  const { registry, documentType, extracted } = input
  // Pagine scansionate che l'OCR non ha letto: qualunque sia l'esito dell'estrazione, il
  // testo era incompleto. Il run lo dichiara, così `needsV2Extraction` lo ripassa invece
  // di prenderlo per un documento già visto da questa versione del motore.
  const ocrFailed = extracted.ocrFailedPages.length > 0
  const run = (
    status: ExtractionRunInput['status'],
    extra: Partial<ExtractionRunInput> & { metrics?: Record<string, unknown> } = {}
  ): ExtractionRunInput => ({
    engineVersion: EXTRACTION_ENGINE_V2_VERSION,
    schemaVersion: registry.schemaVersion(),
    documentType: documentType ?? '',
    startedAt: input.startedAt,
    completedAt: new Date().toISOString(),
    status: ocrFailed ? 'FAILED_OCR' : status,
    missingRequired: extra.missingRequired ?? [],
    conflicts: extra.conflicts ?? [],
    metrics: {
      textSource: extracted.source,
      ...(ocrFailed ? { ocrFailedPages: extracted.ocrFailedPages } : {}),
      // Le memorie dei moduli che hanno proposto il tipo di questo documento, anche
      // quando il revisore ne aveva già scelto un altro: un benchmark dichiara così su
      // cosa ha lavorato.
      templateRuleIds: input.learning.templateRuleIds,
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
      'Senza tipo non c’è una mappa di campi da cercare. I campi si precompilano quando il revisore assegna il tipo.',
      'SKIPPED_UNKNOWN_TYPE'
    )
  }

  const profileSource = registry.profileSource(documentType)
  if (profileSource === 'MISSING') {
    return skipped(
      `Il registry non dice quali campi vuole «${documentType}»: il tipo è fuori dalle 171 classi della mappa.`,
      'SKIPPED_NO_PROFILE'
    )
  }

  const result = extractFactsV2({
    documentType,
    pages: extracted.pages,
    registry,
    ocrPages: extracted.ocrPages,
    learnedLabels: input.learning.labels
  })

  const evidence: EvidenceInput[] = []
  const fields: FieldInput[] = []
  const addEvidence = (
    item: (typeof result.facts)[number]['evidence'][number],
    confidence: number
  ) => {
    const id = randomUUID()
    evidence.push({
      id,
      page: item.page,
      text: item.text,
      bbox: item.bbox ?? null,
      confidence,
      ruleId: item.ruleId ?? null,
      strategy: item.strategy ?? null,
      ruleScope: item.ruleScope ?? null
    })
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
      validationErrors: fact.validationErrors,
      ...(fact.computed ? { computed: true } : {})
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
    // Un valore dedotto non ha evidenza — nel documento quella data non c'è — ma è
    // comunque una proposta da scrivere: senza questa riga tornerebbe vuoto.
    if (fact.value === null || (!source && !fact.computed)) {
      fields.push({ ...common, value: null })
      continue
    }
    fields.push({
      ...common,
      value: String(fact.value),
      ...(source ? { evidenceId: addEvidence(source, fact.confidence) } : {})
    })
  }

  const filled = result.facts.filter((fact) => fact.value !== null).length
  const deduced = result.facts.filter((fact) => fact.computed === true)
  const labelOf = (fieldId: string) => registry.field(fieldId)?.label_it ?? fieldId
  const parts = [
    `${filled - deduced.length} campi su ${result.facts.length} con evidenza verbatim, mappa ${result.schemaState}.`
  ]
  if (deduced.length > 0) {
    // Dedotto non è letto: va detto qui, o il conto qui sopra sembrerebbe sbagliato.
    parts.push(
      `Dedotti dalla normativa, da confermare: ${deduced.map((fact) => labelOf(fact.fieldId)).join(', ')}.`
    )
  }
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
        reviewStatus: countBy(result.facts.map((fact) => fact.reviewStatus)),
        // Con quale apprendimento è uscito questo run: le regole disponibili e quelle che
        // hanno davvero dato un valore. Un benchmark dichiara così cosa ha misurato.
        learning: {
          mode: input.learning.mode,
          learnerVersion: LEARNER_VERSION,
          activeRules: [...new Set(input.learning.labels.map((label) => label.ruleId))].length,
          appliedRuleIds: [
            ...new Set(
              result.facts.flatMap((fact) =>
                fact.evidence.flatMap((item) => (item.ruleId ? [item.ruleId] : []))
              )
            )
          ].sort()
        }
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Due decimali: la confidenza si legge, non si stampa con sedici cifre. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
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
