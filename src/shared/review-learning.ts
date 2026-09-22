import { fieldCorrections } from './field-edits'
import type {
  LearningEventInput,
  LearningEventKind,
  LearningOutcome,
  LearningPick
} from './local-learning'
import type { NormalizedTemplateSignature } from './template-fingerprint'
import type { EvidenceItem, ExtractedField, FieldItem, ReviewDocument } from './types'

/**
 * Le decisioni che una revisione salvata insegna: una per il tipo, una per ogni campo o riga
 * che il motore aveva proposto o che il revisore ha toccato.
 *
 * Nessun database: entra il documento così com'era al momento del salvataggio, escono gli
 * eventi da registrare. È la parte del learner che pratica-ai potrà riusare così com'è.
 *
 * Cosa non diventa un evento, e perché:
 * - un campo vuoto che nessuno ha toccato: non si sa se il revisore l'abbia cercato;
 * - il tipo di un documento senza classificazione salvata e assegnato a mano: non si sa
 *   cosa il motore avesse proposto, quindi non c'è niente da confrontare.
 */

/** Quello che non dipende dal documento: chi ha deciso, quando, e l'impronta del modulo. */
export interface ReviewLearningContext {
  at: string
  actor: string
  templateFingerprint: string | null
  /** La firma della testata, per le regole di modulo; assente prima della 0016. */
  templateSignature?: NormalizedTemplateSignature | null
  /** La data del replay, quando la revisione si ripassa invece di chiuderla adesso. */
  replayedAt?: string | null
}

function pickOf(evidence: EvidenceItem | undefined): LearningPick | null {
  if (evidence?.origin !== 'REVIEWER' || !evidence.method) return null
  return {
    method: evidence.method,
    page: evidence.page,
    bbox: evidence.bbox ?? null,
    location: evidence.location ?? null
  }
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === ''
}

type Decision = Pick<
  LearningEventInput,
  | 'kind'
  | 'outcome'
  | 'predictedType'
  | 'predictedConfidence'
  | 'fieldId'
  | 'itemIndex'
  | 'engineConfidence'
  | 'engineRuleId'
  | 'pick'
>

const decision = (
  kind: LearningEventKind,
  outcome: LearningOutcome,
  rest: Partial<Omit<Decision, 'kind' | 'outcome'>>
): Decision => ({
  kind,
  outcome,
  predictedType: null,
  predictedConfidence: null,
  fieldId: null,
  itemIndex: null,
  engineConfidence: null,
  engineRuleId: null,
  pick: null,
  ...rest
})

/**
 * Il tipo: confermato, cambiato, scelto dove il motore non ne aveva, o tolto.
 *
 * La proposta del motore è quella della memoria dei moduli, che si riconosce dalla
 * confidenza: un tipo con `typeConfidence` è stato proposto, uno senza l'ha scelto il
 * revisore. Sui documenti chiusi prima c'è ancora la classificazione salvata, e lì la
 * proposta si legge da quella. Un tipo scelto a mano vale come decisione anche senza
 * nessuna proposta prima: è quello che insegna alla memoria del modulo.
 */
function typeDecision(document: ReviewDocument): Decision | null {
  const { classification, documentType } = document
  const proposed = classification
    ? classification.proposedType
    : document.typeConfidence !== null
      ? documentType
      : null
  const confidence = classification ? classification.confidence : document.typeConfidence
  if (proposed === null && documentType === null) return null

  const outcome: LearningOutcome =
    proposed === null
      ? 'FILLED'
      : documentType === null
        ? 'CLEARED'
        : proposed === documentType
          ? 'CONFIRMED'
          : 'CHANGED'
  return decision('DOCUMENT_TYPE', outcome, {
    predictedType: proposed,
    predictedConfidence: proposed === null ? null : confidence
  })
}

function fieldDecisions(field: ExtractedField, evidence: Map<string, EvidenceItem>): Decision[] {
  const itemsById = new Map(field.items.map((item) => [item.id, item]))
  const confidenceOf = (item: FieldItem | undefined) => item?.confidence ?? field.confidence
  /** La regola appresa dietro la proposta del motore, dalla sua evidenza. */
  const ruleOf = (source: { evidenceId?: string }) =>
    (source.evidenceId ? evidence.get(source.evidenceId)?.ruleId : undefined) ?? null
  const corrected = fieldCorrections(field).map((correction) => {
    const item = correction.itemId === null ? undefined : itemsById.get(correction.itemId)
    const source = item ?? field
    const proposed = correction.before !== null
    return decision('FIELD_VALUE', correction.kind, {
      fieldId: field.name,
      itemIndex: correction.itemIndex,
      engineConfidence: proposed ? confidenceOf(item) : null,
      engineRuleId: proposed ? ruleOf(source) : null,
      pick:
        correction.after === null
          ? null
          : pickOf(
              source.correctedEvidenceId ? evidence.get(source.correctedEvidenceId) : undefined
            )
    })
  })

  if (field.cardinality === 'many') {
    const touched = new Set(corrected.map((entry) => entry.itemIndex))
    const confirmed = field.items
      .filter(
        (item) =>
          item.origin === 'ENGINE' &&
          !item.removed &&
          !blank(item.value) &&
          !touched.has(item.index)
      )
      .map((item) =>
        decision('FIELD_VALUE', 'CONFIRMED', {
          fieldId: field.name,
          itemIndex: item.index,
          engineConfidence: item.confidence,
          engineRuleId: ruleOf(item)
        })
      )
    return [...corrected, ...confirmed].sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0))
  }

  if (corrected.length > 0) return corrected
  if (blank(field.value)) return []
  return [
    decision('FIELD_VALUE', 'CONFIRMED', {
      fieldId: field.name,
      engineConfidence: field.confidence,
      engineRuleId: ruleOf(field)
    })
  ]
}

/** Gli eventi di una revisione salvata, nell'ordine in cui il revisore li vede. */
export function reviewLearningEvents(
  document: ReviewDocument,
  context: ReviewLearningContext
): LearningEventInput[] {
  const evidence = new Map(document.evidence.map((item) => [item.id, item]))
  const decisions = [
    typeDecision(document),
    ...document.fields.flatMap((field) => fieldDecisions(field, evidence))
  ].filter((entry): entry is Decision => entry !== null)

  return decisions.map((entry) => ({
    at: context.at,
    actor: context.actor,
    replayedAt: context.replayedAt ?? null,
    documentId: document.id,
    contentSha256: document.contentSha256,
    templateFingerprint: context.templateFingerprint,
    templateSignature: context.templateSignature ?? null,
    textSource: document.textSource,
    documentType: document.documentType,
    ...entry
  }))
}

/** La frase che la timeline aggiunge alla revisione: quanto ne ha imparato il learner. */
export function describeLearnedReview(events: LearningEventInput[]): string {
  if (events.length === 0) return 'Apprendimento: nessuna decisione da registrare.'
  const confirmed = events.filter((event) => event.outcome === 'CONFIRMED').length
  const corrections = events.length - confirmed
  const picked = events.filter((event) => event.pick !== null).length
  const parts = [
    confirmed === 1 ? '1 conferma' : `${confirmed} conferme`,
    corrections === 1 ? '1 correzione' : `${corrections} correzioni`
  ]
  const recorded =
    events.length === 1 ? '1 decisione registrata' : `${events.length} decisioni registrate`
  const selection =
    picked === 0 ? '' : picked === 1 ? ', 1 presa dal documento' : `, ${picked} prese dal documento`
  return `Apprendimento: ${recorded} (${parts.join(', ')}${selection}).`
}
