import { normalizeDateValue } from '@shared/date-value'
import type { ExtractionResultV2, FieldOntologyEntry } from '@shared/extraction-v2'
import { LEARNING_BUNDLE_FORMAT } from '@shared/learning-workspace'
import type { LearningRule } from '@shared/local-learning'
import { z } from 'zod'
import { parseDecimal } from '../../src/main/extract/v2/fact-reader'

/**
 * Il conto del benchmark su corpus reale (`tests/pilot-corpus-benchmark.test.ts`): la forma
 * del manifest, il confronto dei valori, il punteggio dei campi e dei tipi.
 *
 * Tutto puro, senza file né motore. L'harness gira solo con un corpus in mano, quindi quasi
 * mai; la parte che decide cosa è giusto e cosa è sbagliato la provano invece i test
 * ordinari (`tests/pilot-benchmark-scoring.test.ts`) su dati scritti a mano, così non resta
 * codice che nessuno esegue.
 */

// ---------------------------------------------------------------------------
// Il manifest
// ---------------------------------------------------------------------------

const expectedScalar = z.union([z.string().trim().min(1), z.number(), z.boolean()])

/** Un valore atteso: uno solo, o la lista delle righe di un campo `many`. */
const expectedValue = z.union([expectedScalar, z.array(expectedScalar).min(1)])

// Rigido apposta: una chiave scritta male («expectedAbsents») sparirebbe in silenzio, e
// con lei i campi che doveva dichiarare.
const manifestDocument = z.strictObject({
  file: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, 'serve lo sha-256 in esadecimale'),
  documentType: z.string().min(1).nullable(),
  fields: z.record(z.string().min(1), expectedValue),
  expectedAbsent: z.array(z.string().min(1)).optional()
})

const manifestSchema = z.strictObject({
  version: z.string().min(1),
  documents: z.array(manifestDocument).min(1)
})

export type PilotManifest = z.infer<typeof manifestSchema>
export type PilotDocument = PilotManifest['documents'][number]
export type ExpectedValue = z.infer<typeof expectedValue>

/**
 * Il manifest letto e controllato. Oltre alla forma, tre cose che la forma non dice: un
 * file compare una volta sola, un documento atteso `UNKNOWN` non ha campi (senza tipo non
 * c'è un profilo da cui leggerli), e un campo non è insieme atteso e atteso assente.
 */
export function parseManifest(raw: unknown): PilotManifest {
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? issue.path.join('.') : 'radice'
    throw new Error(
      `Manifest del benchmark: struttura inattesa in «${where}»: ${issue?.message ?? 'non valido'}.`
    )
  }

  const seen = new Set<string>()
  for (const document of parsed.data.documents) {
    if (seen.has(document.file)) {
      throw new Error(`Manifest del benchmark: «${document.file}» compare due volte.`)
    }
    seen.add(document.file)
    if (document.documentType === null && Object.keys(document.fields).length > 0) {
      throw new Error(
        `Manifest del benchmark: «${document.file}» è atteso senza tipo, quindi senza campi.`
      )
    }
    const both = (document.expectedAbsent ?? []).filter((fieldId) => fieldId in document.fields)
    if (both.length > 0) {
      throw new Error(
        `Manifest del benchmark: in «${document.file}» ${both.join(', ')} è sia atteso sia atteso assente.`
      )
    }
  }
  return parsed.data
}

// ---------------------------------------------------------------------------
// Il confronto dei valori
// ---------------------------------------------------------------------------

/** Quello che serve dell'ontologia per confrontare un valore: il suo tipo. */
export type ValueSpec = Pick<FieldOntologyEntry, 'type' | 'format'>

/**
 * Un valore nella forma in cui si confronta.
 *
 * La base è quella della revisione (`normalizeFieldValue`): spazi in testa e in coda via,
 * e una data scritta per intero diventa `yyyy-mm-dd`, come la scrive il motore. In più,
 * perché chi annota scrive come legge sul documento: gli spazi interni si comprimono, un
 * importo o un numero si confronta come numero («1.234,56» e `1234.56` sono lo stesso;
 * «1.250» vale milleduecentocinquanta, come in italiano), un identificativo senza spazi e
 * in maiuscolo (l'IBAN a gruppi di quattro è lo stesso IBAN). Il testo libero resta
 * com'è, maiuscole comprese: «ROSSI MARIO» e «Rossi Mario» non sono la stessa lettura.
 */
export function normalizeValue(value: unknown, spec?: ValueSpec | null): string | null {
  if (value === null || value === undefined) return null
  // Un numero del JSON è già canonico: rileggerlo all'italiana farebbe di 1.125 un 1125.
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null

  const text = String(value).trim().replace(/\s+/g, ' ')
  if (text === '') return null

  switch (spec?.type) {
    case 'date':
      return normalizeDateValue(text) ?? text
    case 'money':
      return parseDecimal(text.replace(/€|\beur(?:o)?\b/gi, '')) ?? text
    case 'number':
    case 'integer':
      return parseDecimal(text) ?? text
    case 'identifier':
      return text.replace(/\s/g, '').toUpperCase()
    case 'boolean':
      return text.toLowerCase()
    default:
      return text
  }
}

/** I valori di un campo come lista: uno per un campo `one`, le righe per un campo `many`. */
function normalizedList(value: unknown, spec?: ValueSpec | null): string[] {
  return (Array.isArray(value) ? value : [value])
    .map((item) => normalizeValue(item, spec))
    .filter((item): item is string => item !== null)
}

/** Il motore ha dato un valore: né `null`, né stringa vuota, né lista vuota. */
export function isFilled(value: unknown): boolean {
  return normalizedList(value).length > 0
}

/**
 * Lo stesso valore, dopo la normalizzazione.
 *
 * Un campo `many` è giusto se le righe lette sono **esattamente** quelle attese, in
 * qualunque ordine: una riga in più o in meno lo fa sbagliato, perché chi annota dovrebbe
 * comunque toglierla o aggiungerla. L'ordine non conta perché il motore legge in ordine
 * di pagina e chi annota può averle scritte in un altro. Un valore singolo contro una
 * lista di una riga vale come la stessa riga.
 */
export function sameValue(actual: unknown, expected: unknown, spec?: ValueSpec | null): boolean {
  const left = normalizedList(actual, spec).sort()
  const right = normalizedList(expected, spec).sort()
  return left.length > 0 && left.length === right.length && left.every((v, i) => v === right[i])
}

// ---------------------------------------------------------------------------
// Il punteggio dei campi
// ---------------------------------------------------------------------------

export type FieldOutcome = 'CORRECT' | 'WRONG' | 'MISSING'

export interface FieldScore {
  correct: number
  wrong: number
  missing: number
  total: number
}

export function emptyScore(): FieldScore {
  return { correct: 0, wrong: 0, missing: 0, total: 0 }
}

/** I valori che il motore ha dato, per campo; i campi rimasti vuoti non ci sono. */
export function valuesOf(result: ExtractionResultV2 | null): Record<string, unknown> {
  if (!result) return {}
  return Object.fromEntries(
    result.facts.filter((fact) => isFilled(fact.value)).map((fact) => [fact.fieldId, fact.value])
  )
}

/**
 * L'esito di ogni campo atteso: giusto, sbagliato (il motore ha dato un altro valore) o
 * mancante (non ne ha dato nessuno). Sbagliato è il caso che pesa: è il valore plausibile
 * che finisce davanti a chi annota.
 */
export function fieldOutcomes(
  expected: Record<string, ExpectedValue>,
  actual: Record<string, unknown>,
  specOf: (fieldId: string) => ValueSpec | null | undefined
): Record<string, FieldOutcome> {
  return Object.fromEntries(
    Object.entries(expected).map(([fieldId, value]) => {
      const got = actual[fieldId]
      const outcome: FieldOutcome = !isFilled(got)
        ? 'MISSING'
        : sameValue(got, value, specOf(fieldId))
          ? 'CORRECT'
          : 'WRONG'
      return [fieldId, outcome]
    })
  )
}

export function tally(outcomes: Record<string, FieldOutcome>): FieldScore {
  const score = emptyScore()
  for (const outcome of Object.values(outcomes)) {
    score.total += 1
    if (outcome === 'CORRECT') score.correct += 1
    else if (outcome === 'WRONG') score.wrong += 1
    else score.missing += 1
  }
  return score
}

export function addScore(total: FieldScore, score: FieldScore): void {
  total.correct += score.correct
  total.wrong += score.wrong
  total.missing += score.missing
  total.total += score.total
}

/** I campi che il manifest dichiara assenti e il motore ha compilato lo stesso. */
export function filledDespiteAbsent(
  expectedAbsent: string[] | undefined,
  actual: Record<string, unknown>
): string[] {
  return (expectedAbsent ?? []).filter((fieldId) => isFilled(actual[fieldId]))
}

/**
 * I campi attesi che il profilo del tipo non chiede: il motore non li ha nemmeno cercati.
 * Contano come mancanti, ma dirlo separa «non trovato» da «mai cercato».
 */
export function outsideProfile(
  expected: Record<string, ExpectedValue>,
  result: ExtractionResultV2 | null
): string[] {
  if (!result) return []
  const searched = new Set(result.facts.map((fact) => fact.fieldId))
  return Object.keys(expected).filter((fieldId) => !searched.has(fieldId))
}

export interface ReviewCounts {
  autoAccepted: number
  needsReview: number
  conflicts: number
}

export function emptyReviewCounts(): ReviewCounts {
  return { autoAccepted: 0, needsReview: 0, conflicts: 0 }
}

/** Come arrivano davanti a chi annota i valori che il motore ha dato. */
export function reviewCounts(result: ExtractionResultV2 | null): ReviewCounts {
  const counts = emptyReviewCounts()
  for (const fact of result?.facts ?? []) {
    if (!isFilled(fact.value)) continue
    if (fact.reviewStatus === 'AUTO_ACCEPTED') counts.autoAccepted += 1
    else if (fact.reviewStatus === 'NEEDS_REVIEW') counts.needsReview += 1
    else if (fact.reviewStatus === 'CONFLICT') counts.conflicts += 1
  }
  return counts
}

export function addReviewCounts(total: ReviewCounts, counts: ReviewCounts): void {
  total.autoAccepted += counts.autoAccepted
  total.needsReview += counts.needsReview
  total.conflicts += counts.conflicts
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1e4) / 1e4
}

export function summarizeScore(score: FieldScore) {
  return {
    ...score,
    accuracy: rate(score.correct, score.total),
    errorRate: rate(score.wrong, score.total),
    missingRate: rate(score.missing, score.total)
  }
}

// ---------------------------------------------------------------------------
// Il punteggio dei tipi
// ---------------------------------------------------------------------------

export interface ClassificationTally {
  total: number
  /** Tipo assegnato uguale a quello atteso, compresa l'astensione su un atteso `UNKNOWN`. */
  correct: number
  incorrect: number
  /** Il classificatore non ha assegnato niente. */
  abstained: number
  /**
   * Ha assegnato un tipo, e non era quello: il tipo plausibile e sbagliato, che si porta
   * dietro un profilo di campi sbagliato. È il caso che il criterio esclude.
   */
  wrongType: number
  /** Documenti che il manifest vuole `UNKNOWN`. */
  expectedUnknown: number
  /** Documenti con un tipo atteso: il denominatore del top-1. */
  expectedKnown: number
  /** Il tipo atteso era il primo candidato, assegnato o no. */
  top1Correct: number
}

export function emptyClassificationTally(): ClassificationTally {
  return {
    total: 0,
    correct: 0,
    incorrect: 0,
    abstained: 0,
    wrongType: 0,
    expectedUnknown: 0,
    expectedKnown: 0,
    top1Correct: 0
  }
}

export function addClassification(
  total: ClassificationTally,
  document: { expected: string | null; assigned: string | null; top: string | null }
): void {
  total.total += 1
  if (document.assigned === document.expected) total.correct += 1
  else total.incorrect += 1
  if (document.assigned === null) total.abstained += 1
  else if (document.assigned !== document.expected) total.wrongType += 1
  if (document.expected === null) {
    total.expectedUnknown += 1
    return
  }
  total.expectedKnown += 1
  if (document.top === document.expected) total.top1Correct += 1
}

export function summarizeClassification(total: ClassificationTally) {
  return {
    ...total,
    accuracy: rate(total.correct, total.total),
    top1Accuracy: rate(total.top1Correct, total.expectedKnown)
  }
}

// ---------------------------------------------------------------------------
// Le regole apprese, per la misura FROZEN
// ---------------------------------------------------------------------------

const bundleRule = z.object({
  id: z.string(),
  kind: z.enum([
    'EXTRACTION_ANCHOR',
    'TEMPLATE_TYPE',
    'CLASSIFIER_POSITIVE',
    'CLASSIFIER_NEGATIVE'
  ]),
  scope: z.enum(['TEMPLATE', 'CLASS']),
  status: z.enum(['CANDIDATE', 'ACTIVE', 'SUSPENDED', 'REJECTED']),
  documentType: z.string(),
  fieldId: z.string().nullable(),
  templateFingerprint: z.string().nullable(),
  pattern: z.record(z.string(), z.unknown()),
  ruleKey: z.string(),
  positiveCount: z.number(),
  negativeCount: z.number(),
  lastPositiveAt: z.string().nullable(),
  lastNegativeAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  learnerVersion: z.string()
})

const bundleSchema = z.object({
  manifest: z.object({
    format: z.literal(LEARNING_BUNDLE_FORMAT),
    formatVersion: z.string(),
    exportedAt: z.string(),
    learnerVersion: z.string(),
    templateFingerprintAlgorithm: z.string(),
    normalizedTemplateSignatureAlgorithm: z.string().optional()
  }),
  rules: z.array(bundleRule)
})

export interface LearnedRuleSet {
  /** Da dove vengono: quello che la misura dichiara accanto ai suoi numeri. */
  manifest: z.infer<typeof bundleSchema>['manifest']
  /** Solo le attive: sono le sole che il motore applica, in `FROZEN` come in `LEARNING`. */
  rules: LearningRule[]
}

/**
 * Le regole di un file «Esporta le regole» (`praticaai-reviewer/learned-rules`), pronte
 * per il motore. Il file porta anche eventi e cronologia, che qui non servono; delle regole
 * restano le attive, nella forma del database.
 */
export function learnedRulesFromBundle(raw: unknown): LearnedRuleSet {
  const parsed = bundleSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? issue.path.join('.') : 'radice'
    throw new Error(
      `Regole apprese: non è un export delle regole, o è scritto male, in «${where}»: ${issue?.message ?? 'non valido'}.`
    )
  }
  return {
    manifest: parsed.data.manifest,
    rules: parsed.data.rules.filter((rule) => rule.status === 'ACTIVE')
  }
}
