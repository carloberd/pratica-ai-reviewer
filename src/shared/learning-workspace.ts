import {
  isAnchorPattern,
  type LearningAction,
  type LearningActionKind,
  type LearningCounts,
  type LearningEvent,
  type LearningMode,
  type LearningPolicy,
  type LearningRule,
  type LearningRuleStatus,
  rulePrecision,
  ruleSupport
} from './local-learning'
import { praticaaiTypeId, praticaaiTypeIdOrNull } from './registry-alignment'

/**
 * La scheda «Apprendimento» e l'export delle regole: quello che il revisore vede di quanto
 * il motore ha imparato, e cosa può farne. Modulo puro, come `profile-workspace`: nessun
 * database, nessun file.
 */

/** I cambi di stato che una persona può fare su una regola, dalla scheda. */
export type ManualRuleStatus = 'ACTIVE' | 'SUSPENDED' | 'REJECTED'

/**
 * Cosa si può fare a mano, per stato. Una candidata non si attiva a mano: vale quando le
 * revisioni lo dicono, e saltarle è proprio quello che il learner esiste per evitare. Si
 * può scartare, però, se è chiaramente sbagliata. Una regola scartata non torna.
 */
export function manualTransitions(status: LearningRuleStatus): ManualRuleStatus[] {
  switch (status) {
    case 'ACTIVE':
      return ['SUSPENDED', 'REJECTED']
    case 'SUSPENDED':
      return ['ACTIVE', 'REJECTED']
    case 'CANDIDATE':
      return ['REJECTED']
    case 'REJECTED':
      return []
  }
}

export const LEARNING_STATUS_LABELS: Record<LearningRuleStatus, string> = {
  CANDIDATE: 'candidata',
  ACTIVE: 'attiva',
  SUSPENDED: 'sospesa',
  REJECTED: 'scartata'
}

export const MANUAL_ACTION_LABELS: Record<ManualRuleStatus, string> = {
  ACTIVE: 'Riattiva',
  SUSPENDED: 'Sospendi',
  REJECTED: 'Scarta'
}

export const LEARNING_ACTION_TITLES: Record<LearningActionKind, string> = {
  MODE_CHANGED: 'Modalità cambiata',
  RULE_PROMOTED: 'Regola attivata',
  RULE_SUSPENDED: 'Regola sospesa',
  RULE_REACTIVATED: 'Regola riattivata',
  RULE_REJECTED: 'Regola scartata',
  REVERT: 'Azione annullata'
}

/** Cosa fa ogni modalità, per chi deve sceglierla. */
export const LEARNING_MODE_HINTS: Record<LearningMode, string> = {
  LEARNING: 'Registra le revisioni salvate, impara etichette e moduli, e applica le regole attive.',
  FROZEN:
    'Applica le regole già attive, ma non registra niente: le revisioni non cambiano quello che il motore sa.',
  BASELINE:
    'Solo il registry: nessuna regola applicata, niente registrato. Per misurare il motore di base, o annotare un holdout.'
}

/** Una regola come la mostra la scheda: i numeri già calcolati, i nomi già risolti. */
export interface LearningRuleView {
  id: string
  kind: LearningRule['kind']
  scope: LearningRule['scope']
  status: LearningRuleStatus
  documentType: string
  documentTypeLabel: string | null
  fieldId: string | null
  fieldLabel: string | null
  templateFingerprint: string | null
  /** L'etichetta imparata, per le regole d'estrazione. */
  label: string | null
  /** La frase che descrive la regola. */
  title: string
  support: number
  precision: number | null
  positiveCount: number
  negativeCount: number
  lastPositiveAt: string | null
  lastNegativeAt: string | null
  updatedAt: string
  manual: ManualRuleStatus[]
}

export interface LearningOverview {
  mode: LearningMode
  counts: LearningCounts
  rules: LearningRuleView[]
  /** La cronologia del learner, dalla più recente. */
  actions: LearningAction[]
}

export interface RuleNames {
  typeLabel: (documentType: string) => string | null
  fieldLabel: (fieldId: string) => string | null
}

/** La frase di una regola: cosa ha imparato, e dove vale. */
export function ruleTitle(
  rule: Pick<
    LearningRule,
    'kind' | 'scope' | 'documentType' | 'fieldId' | 'templateFingerprint' | 'pattern'
  >,
  names: RuleNames
): string {
  const type = names.typeLabel(rule.documentType) ?? rule.documentType
  if (rule.kind === 'TEMPLATE_TYPE') {
    return `Il modulo ${rule.templateFingerprint} è «${type}»`
  }
  if (rule.kind === 'EXTRACTION_ANCHOR' && isAnchorPattern(rule.pattern) && rule.fieldId) {
    const field = names.fieldLabel(rule.fieldId) ?? rule.fieldId
    const where =
      rule.scope === 'TEMPLATE' ? `sul modulo ${rule.templateFingerprint}` : `su ogni «${type}»`
    const relation = rule.pattern.relation === 'same-line' ? 'dopo' : 'sotto'
    return `«${field}» sta ${relation} «${rule.pattern.label}» ${where}`
  }
  return `${rule.kind} per «${type}»`
}

export function toRuleView(rule: LearningRule, names: RuleNames): LearningRuleView {
  return {
    id: rule.id,
    kind: rule.kind,
    scope: rule.scope,
    status: rule.status,
    documentType: rule.documentType,
    documentTypeLabel: names.typeLabel(rule.documentType),
    fieldId: rule.fieldId,
    fieldLabel: rule.fieldId ? names.fieldLabel(rule.fieldId) : null,
    templateFingerprint: rule.templateFingerprint,
    label: isAnchorPattern(rule.pattern) ? rule.pattern.label : null,
    title: ruleTitle(rule, names),
    support: ruleSupport(rule),
    precision: rulePrecision(rule),
    positiveCount: rule.positiveCount,
    negativeCount: rule.negativeCount,
    lastPositiveAt: rule.lastPositiveAt,
    lastNegativeAt: rule.lastNegativeAt,
    updatedAt: rule.updatedAt,
    manual: manualTransitions(rule.status)
  }
}

/** L'ordine della scheda: prima quelle che valgono, poi le sospese, le candidate, le scartate. */
const STATUS_ORDER: Record<LearningRuleStatus, number> = {
  ACTIVE: 0,
  SUSPENDED: 1,
  CANDIDATE: 2,
  REJECTED: 3
}

export function sortRuleViews(rules: LearningRuleView[]): LearningRuleView[] {
  return [...rules].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      b.support - a.support ||
      b.updatedAt.localeCompare(a.updatedAt)
  )
}

export interface LearningExportResult {
  saved: boolean
  path: string | null
  rules: number
  events: number
}

// ---------------------------------------------------------------------------
// Export delle regole
// ---------------------------------------------------------------------------

export const LEARNING_BUNDLE_FORMAT = 'praticaai-reviewer/learned-rules'
export const LEARNING_BUNDLE_VERSION = '1.2.0'

export interface LearningBundleManifest {
  format: typeof LEARNING_BUNDLE_FORMAT
  formatVersion: typeof LEARNING_BUNDLE_VERSION
  exportedAt: string
  app: { name: string; version: string }
  learnerVersion: string
  mode: LearningMode
  policy: LearningPolicy
  counts: LearningCounts
  /** Come sono calcolate le impronte dei moduli nelle regole di template. */
  templateFingerprintAlgorithm: string
  /** Come sono calcolate le firme confrontabili; assente negli export prima della 0016. */
  normalizedTemplateSignatureAlgorithm?: string
}

/** Una regola nel file: la forma del database, coi nomi di pratica-ai accanto. */
export interface LearningBundleRule extends Omit<LearningRule, 'pattern'> {
  pattern: Record<string, unknown>
  /** Il nome del campo nel registry V5.1 di pratica-ai, `null` se non ha un equivalente. */
  registryField: string | null
  /** Il tipo come lo chiama pratica-ai. */
  registryDocumentType: string
  support: number
  precision: number | null
}

export interface LearningBundle {
  manifest: LearningBundleManifest
  rules: LearningBundleRule[]
  /** Le decisioni del revisore: nessun valore, nessun testo del documento. */
  events: Array<
    LearningEvent & {
      registryField: string | null
      registryDocumentType: string | null
      registryPredictedType: string | null
    }
  >
  actions: LearningAction[]
}

/**
 * Il file delle regole apprese, per pratica-ai. I campi portano sia l'id dell'ontologia v2
 * sia il nome V5.1 dove la mappa legacy lo conosce: di là parlano quella lingua. Le regole
 * di template restano legate all'impronta del reviewer, che pratica-ai non calcola sulle
 * stesse righe: si esportano per completezza, e il manifest dice con quale algoritmo.
 *
 * Nessun valore esce: gli eventi non ne hanno, e le regole portano solo etichette. Ordinato
 * per chiave e momento, così due export dello stesso database differiscono solo nella data.
 */
export function buildLearningBundle(input: {
  manifest: Omit<LearningBundleManifest, 'format' | 'formatVersion'>
  rules: LearningRule[]
  events: LearningEvent[]
  actions: LearningAction[]
  /** Nome V5.1 per id dell'ontologia v2. */
  registryFieldOf: (fieldId: string) => string | null
}): LearningBundle {
  const registryField = (fieldId: string | null) =>
    fieldId ? input.registryFieldOf(fieldId) : null
  return {
    manifest: {
      format: LEARNING_BUNDLE_FORMAT,
      formatVersion: LEARNING_BUNDLE_VERSION,
      ...input.manifest
    },
    rules: [...input.rules]
      .sort((a, b) => a.ruleKey.localeCompare(b.ruleKey))
      .map((rule) => ({
        ...rule,
        registryField: registryField(rule.fieldId),
        registryDocumentType: praticaaiTypeId(rule.documentType),
        support: ruleSupport(rule),
        precision: rulePrecision(rule)
      })),
    events: [...input.events]
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
      .map((event) => ({
        ...event,
        registryField: registryField(event.fieldId),
        registryDocumentType: praticaaiTypeIdOrNull(event.documentType),
        registryPredictedType: praticaaiTypeIdOrNull(event.predictedType)
      })),
    actions: [...input.actions].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  }
}

export function learningBundleFileName(now: Date): string {
  return `praticaai-regole-apprese-${now.toISOString().slice(0, 10)}.json`
}
