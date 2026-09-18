import {
  DEFAULT_TEMPLATE_SIMILARITY_THRESHOLD,
  type NormalizedTemplateSignature
} from './template-fingerprint'
import type { BoundingBox, PickLocation, PickMethod, TextSource } from './types'

/**
 * Il contratto del learner locale: quello che il motore impara dalle revisioni, come si
 * registra e con quale stato vale. Nessuna dipendenza da database o Electron: lo usano il
 * main per scrivere, e un giorno pratica-ai per leggere lo stesso formato.
 *
 * Il piano sta in `docs/local-learning-analisi.md`.
 */

/** Versione della logica del learner, scritta su ogni evento e ogni regola. */
export const LEARNER_VERSION = 'local-learner/0.1.0'

/**
 * - `LEARNING`: registra le revisioni, aggiorna le regole, applica quelle attive.
 * - `FROZEN`: applica le regole già attive, non registra e non cambia niente.
 * - `BASELINE`: solo registry, nessuna regola applicata né scritta. Per i benchmark e per
 *   annotare un holdout senza contaminarlo.
 */
export type LearningMode = 'LEARNING' | 'FROZEN' | 'BASELINE'

export const LEARNING_MODES: readonly LearningMode[] = ['LEARNING', 'FROZEN', 'BASELINE']

/** Come la modalità si legge in UI e in cronologia. */
export const LEARNING_MODE_LABELS: Record<LearningMode, string> = {
  LEARNING: 'Apprendimento attivo',
  FROZEN: 'Apprendimento congelato',
  BASELINE: 'Solo registry'
}

export function isLearningMode(value: string): value is LearningMode {
  return (LEARNING_MODES as readonly string[]).includes(value)
}

/** In quale modalità le regole attive valgono per l'estrazione. */
export function appliesRules(mode: LearningMode): boolean {
  return mode !== 'BASELINE'
}

/** Un evento per il tipo del documento, uno per ogni campo o riga. */
export type LearningEventKind = 'DOCUMENT_TYPE' | 'FIELD_VALUE'

/**
 * Com'è finita la proposta del motore. Stesso vocabolario delle correzioni del dataset, più
 * `CONFIRMED`: una proposta tenuta è un esempio positivo, e un registro fatto solo di
 * disaccordi insegnerebbe il contrario di quello che deve.
 */
export type LearningOutcome = 'CONFIRMED' | 'CHANGED' | 'FILLED' | 'CLEARED' | 'ADDED' | 'REMOVED'

/**
 * Come si è saputo dove stava un valore.
 *
 * I `PickMethod` sono i modi in cui il revisore lo prende dal documento, e sono quelli che
 * l'interfaccia conosce. `EXACT_VALUE_MATCH` invece è del learner e solo suo: nessuno ha
 * indicato niente, il punto è stato ritrovato cercando il valore digitato nel testo della
 * pagina, e solo dove compariva una volta sola (`src/main/inferred-pick.ts`). Sta qui e non
 * fra i `PickMethod` perché un'inferenza non è una selezione, e chi legge un'evidenza del
 * revisore non deve poterle confondere.
 */
export type LearningPickMethod = PickMethod | 'EXACT_VALUE_MATCH'

/** Da dove il revisore ha preso un valore, senza il testo: basta la posizione. */
export interface LearningPick {
  method: LearningPickMethod
  page: number
  bbox: BoundingBox | null
  location: PickLocation | null
}

export interface LearningEventInput {
  /** Il momento della revisione: gli eventi di una stessa chiusura lo condividono. */
  at: string
  actor: string
  documentId: string
  contentSha256: string | null
  templateFingerprint: string | null
  /** Firma confrontabile della testata; assente sugli eventi scritti prima della 0016. */
  templateSignature?: NormalizedTemplateSignature | null
  textSource: TextSource | null
  kind: LearningEventKind
  outcome: LearningOutcome
  /** Il tipo con cui il documento è stato chiuso. */
  documentType: string | null
  predictedType: string | null
  predictedConfidence: number | null
  fieldId: string | null
  itemIndex: number | null
  engineConfidence: number | null
  /** La regola appresa che aveva proposto il valore del motore, se ce n'era una. */
  engineRuleId: string | null
  pick: LearningPick | null
  /**
   * Quando l'evento è stato scritto, se non sul momento: `null` per una revisione
   * registrata mentre la si chiudeva, la data del replay per una ripassata dopo.
   *
   * `at` resta sempre il momento in cui il revisore ha deciso. Su un evento ripassato
   * `actor` è l'account che ha lanciato il replay, non chi aveva chiuso quella revisione:
   * chi ha chiuso non è mai stato salvato sul documento, e il registro non deve dire una
   * cosa che non sa.
   */
  replayedAt: string | null
}

/**
 * Il documento a cui si riferisce una prova: lo sha-256 del file, o l'id del documento
 * quando l'hash manca. Una regola ha al più una prova per documento.
 */
export function documentKey(event: Pick<LearningEventInput, 'contentSha256' | 'documentId'>) {
  return event.contentSha256 ?? `document:${event.documentId}`
}

export interface LearningEvent extends LearningEventInput {
  id: string
  learnerVersion: string
}

export type LearningRuleKind =
  /** Un'etichetta che annuncia il valore di un campo. */
  | 'EXTRACTION_ANCHOR'
  /** Un template che, finora, è sempre stato dello stesso tipo. */
  | 'TEMPLATE_TYPE'
  | 'CLASSIFIER_POSITIVE'
  | 'CLASSIFIER_NEGATIVE'

export type LearningRuleScope = 'TEMPLATE' | 'CLASS'

export type LearningRuleStatus = 'CANDIDATE' | 'ACTIVE' | 'SUSPENDED' | 'REJECTED'

export type LearningEffect = 'POSITIVE' | 'NEGATIVE'

export interface LearningRuleInput {
  kind: LearningRuleKind
  scope: LearningRuleScope
  documentType: string
  fieldId: string | null
  /** Solo per scope `TEMPLATE`. */
  templateFingerprint: string | null
  /** La forma della regola, che dipende dal tipo. */
  pattern: Record<string, unknown>
  /** Individua la regola: la stessa regola imparata due volte è una sola. */
  ruleKey: string
}

export interface LearningRule extends LearningRuleInput {
  id: string
  status: LearningRuleStatus
  positiveCount: number
  negativeCount: number
  lastPositiveAt: string | null
  lastNegativeAt: string | null
  createdAt: string
  updatedAt: string
  learnerVersion: string
}

/**
 * Dove sta il valore rispetto all'etichetta: sulla stessa riga, dopo; oppure in testa alla
 * riga successiva, con l'etichetta a fine riga. Le stesse due letture del motore.
 */
export type AnchorRelation = 'same-line' | 'next-line'

/** La forma di una regola `EXTRACTION_ANCHOR`. */
export interface AnchorPattern {
  /** Ripiegata come la ripiega il motore: minuscole, senza accenti né punteggiatura. */
  label: string
  relation: AnchorRelation
  /**
   * La testata del modulo da cui la regola viene, solo sulla variante `TEMPLATE`. È quella
   * che permette di riconoscere lo stesso modulo su un documento che l'impronta esatta
   * mancherebbe; assente sulle regole scritte prima della 0016, che valgono per impronta.
   */
  templateSignature?: NormalizedTemplateSignature
}

export function isAnchorPattern(
  pattern: Record<string, unknown>
): pattern is AnchorPattern & Record<string, unknown> {
  return (
    typeof pattern.label === 'string' &&
    (pattern.relation === 'same-line' || pattern.relation === 'next-line')
  )
}

/** La chiave di una regola d'etichetta: tipo, ambito, impronta, campo e forma. */
export function anchorRuleKey(input: {
  scope: LearningRuleScope
  documentType: string
  fieldId: string
  templateFingerprint: string | null
  pattern: AnchorPattern
}): string {
  return [
    'EXTRACTION_ANCHOR',
    input.scope,
    input.documentType,
    // Con la firma, la chiave è quella del cluster: due esemplari dello stesso modulo che
    // l'impronta esatta separava finiscono sulla stessa regola, e le loro prove si sommano.
    input.scope === 'TEMPLATE'
      ? (input.pattern.templateSignature?.fingerprint ?? input.templateFingerprint)
      : '*',
    input.fieldId,
    input.pattern.relation,
    input.pattern.label
  ].join('|')
}

/**
 * La chiave della memoria di un modulo: quel template, finora, è stato di quel tipo. Una
 * regola per coppia, così due tipi sullo stesso modulo sono due regole che si smentiscono.
 */
export function templateTypeRuleKey(documentType: string, templateFingerprint: string): string {
  return ['TEMPLATE_TYPE', 'TEMPLATE', documentType, templateFingerprint].join('|')
}

/** Quante revisioni sostengono la regola. */
export function ruleSupport(rule: Pick<LearningRule, 'positiveCount'>): number {
  return rule.positiveCount
}

/** Quante volte, fra quelle in cui è stata messa alla prova, la regola ci ha preso. */
export function rulePrecision(
  rule: Pick<LearningRule, 'positiveCount' | 'negativeCount'>
): number | null {
  const total = rule.positiveCount + rule.negativeCount
  return total === 0 ? null : rule.positiveCount / total
}

/**
 * Quando una regola comincia o smette di valere. Soglie iniziali della specifica, da
 * calibrare sui documenti veri.
 */
export interface LearningPolicy {
  /** Una regola di template vale dopo tante conferme, senza nessuna smentita. */
  minTemplateSupport: number
  minTemplatePrecision: number
  /** Una regola di tipo vale su tutti i moduli del tipo: chiede più conferme. */
  minClassSupport: number
  minClassPrecision: number
  /** Una regola attiva si sospende sotto questa precisione… */
  suspendBelowPrecision: number
  /**
   * …ma solo con abbastanza prove perché il rapporto dica qualcosa: dopo due conferme una
   * smentita fa il 67%, e non è una regola sbagliata. Prima di allora decidono le smentite
   * di fila.
   */
  minEvidenceForPrecision: number
  /** …o dopo tante smentite di fila, anche se la storia era buona. */
  suspendAfterNegatives: number
  /**
   * La memoria di un modulo vale dopo tante revisioni concordi. Più prudente di
   * un'etichetta: un tipo sbagliato cambia tutti i campi che si cercano.
   */
  minTemplateTypeSupport: number
  /**
   * Quante ancore in comune servono perché due testate siano lo stesso modulo, e quindi
   * perché le loro revisioni si sommino sulla stessa regola di scope `TEMPLATE`. Sotto
   * questa soglia sono due moduli diversi e non si insegnano niente a vicenda.
   */
  minTemplateSimilarity: number
}

export const DEFAULT_LEARNING_POLICY: LearningPolicy = {
  minTemplateSupport: 2,
  minTemplatePrecision: 1,
  minClassSupport: 3,
  minClassPrecision: 0.9,
  suspendBelowPrecision: 0.7,
  minEvidenceForPrecision: 5,
  suspendAfterNegatives: 2,
  minTemplateTypeSupport: 3,
  minTemplateSimilarity: DEFAULT_TEMPLATE_SIMILARITY_THRESHOLD
}

/**
 * Lo stato che una regola dovrebbe avere, date le sue prove.
 *
 * Il learner promuove e sospende da sé; non riattiva e non scarta. Una regola sospesa ha
 * smesso di valere per una ragione, e tornare a fidarsene è una decisione di una persona:
 * altrimenti una sospensione a mano durerebbe fino alla prossima conferma.
 *
 * La memoria di un modulo (`TEMPLATE_TYPE`) è più severa: nessun conflitto per attivarsi, e
 * un conflitto la sospende. Se lo stesso modulo è stato chiuso con due tipi diversi, il
 * modulo non basta a dire il tipo.
 *
 * `sinceActive` sono gli effetti delle prove arrivate dopo l'ultima volta che la regola è
 * diventata attiva, dalla più recente. Una regola attiva si giudica solo su quelle: chi la
 * riattiva a mano ha già visto le smentite di prima, e la prima revisione dopo non deve
 * risospenderla per quelle. È anche una precisione mobile: una regola buona per mesi che
 * comincia a sbagliare si sospende sugli errori recenti, non sulla sua storia.
 */
export function nextRuleStatus(
  rule: Pick<LearningRule, 'status' | 'scope' | 'positiveCount' | 'negativeCount'> & {
    kind?: LearningRuleKind
  },
  sinceActive: LearningEffect[],
  policy: LearningPolicy = DEFAULT_LEARNING_POLICY
): LearningRuleStatus {
  if (rule.kind === 'TEMPLATE_TYPE') {
    if (rule.status === 'CANDIDATE') {
      return ruleSupport(rule) >= policy.minTemplateTypeSupport && rule.negativeCount === 0
        ? 'ACTIVE'
        : 'CANDIDATE'
    }
    if (rule.status === 'ACTIVE') return sinceActive.includes('NEGATIVE') ? 'SUSPENDED' : 'ACTIVE'
    return rule.status
  }
  const precision = rulePrecision(rule)
  if (rule.status === 'CANDIDATE') {
    const template = rule.scope === 'TEMPLATE'
    const support = template ? policy.minTemplateSupport : policy.minClassSupport
    const minimum = template ? policy.minTemplatePrecision : policy.minClassPrecision
    return ruleSupport(rule) >= support && precision !== null && precision >= minimum
      ? 'ACTIVE'
      : 'CANDIDATE'
  }
  if (rule.status === 'ACTIVE') {
    const streak = sinceActive.slice(0, policy.suspendAfterNegatives)
    const contradicted =
      streak.length === policy.suspendAfterNegatives &&
      streak.every((effect) => effect === 'NEGATIVE')
    const confirmed = sinceActive.filter((effect) => effect === 'POSITIVE').length
    const imprecise =
      sinceActive.length >= policy.minEvidenceForPrecision &&
      confirmed / sinceActive.length < policy.suspendBelowPrecision
    return contradicted || imprecise ? 'SUSPENDED' : 'ACTIVE'
  }
  return rule.status
}

export type LearningActionKind =
  | 'MODE_CHANGED'
  | 'RULE_PROMOTED'
  | 'RULE_SUSPENDED'
  | 'RULE_REACTIVATED'
  | 'RULE_REJECTED'
  | 'REVERT'

/** Supporto e precisione di una regola al momento di un'azione. */
export interface LearningActionNumbers {
  support: number
  precision: number | null
}

export interface LearningAction {
  id: string
  at: string
  kind: LearningActionKind
  ruleId: string | null
  /** Modalità, o stato della regola, prima e dopo. */
  before: string | null
  after: string | null
  detail: string
  numbers: LearningActionNumbers | null
  revertsId: string | null
  revertedAt: string | null
}

/** Quanto il learner ha raccolto: i contatori della UI. */
export interface LearningCounts {
  events: number
  rules: Record<LearningRuleStatus, number>
}
