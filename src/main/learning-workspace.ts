import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { DatasetLearningSnapshot } from '@shared/dataset'
import {
  buildLearningBundle,
  LEARNING_STATUS_LABELS,
  type LearningExportResult,
  type LearningOverview,
  type ManualRuleStatus,
  manualTransitions,
  type RuleNames,
  sortRuleViews,
  toRuleView
} from '@shared/learning-workspace'
import {
  DEFAULT_LEARNING_POLICY,
  LEARNER_VERSION,
  type LearningAction,
  type LearningRule
} from '@shared/local-learning'
import {
  NORMALIZED_TEMPLATE_SIGNATURE_ALGORITHM,
  TEMPLATE_FINGERPRINT_ALGORITHM
} from '@shared/template-fingerprint'
import type { Repository } from './db/repository'
import { ReviewerError } from './errors'
import { describeRule, type RulesChange } from './review-learning'

/**
 * La scheda «Apprendimento» lato main: cosa il learner sa, i cambi di stato decisi da una
 * persona, e i file che ne escono. Nessuna dipendenza da Electron: i canali IPC chiamano
 * queste funzioni e basta.
 */

export interface LearningWorkspaceDeps {
  repo: Repository
  names: RuleNames
}

/** Modalità, contatori, regole in ordine di importanza e cronologia. */
export function learningOverview(deps: LearningWorkspaceDeps): LearningOverview {
  const { learning } = deps.repo
  return {
    mode: learning.mode(),
    counts: learning.counts(),
    rules: sortRuleViews(
      learning
        .listRules()
        .map((rule) =>
          toRuleView(rule, deps.names, learning.revertableRuleAction(rule.id) !== undefined)
        )
    ),
    actions: learning.listActions()
  }
}

/**
 * Sospende, riattiva o scarta una regola a mano. Vale in ogni modalità. Se la regola
 * comincia o smette di valere, `change` dice cosa rielaborare.
 */
export function setRuleStatusByHand(
  deps: LearningWorkspaceDeps,
  ruleId: string,
  status: ManualRuleStatus,
  at: string = new Date().toISOString()
): { action: LearningAction; change: RulesChange } {
  const rule = deps.repo.learning.getRule(ruleId)
  if (!rule) throw new ReviewerError('NOT_FOUND', 'Regola non trovata.')
  if (!manualTransitions(rule.status).includes(status)) {
    throw new ReviewerError(
      'INVALID_INPUT',
      `Una regola ${LEARNING_STATUS_LABELS[rule.status]} non può diventare ${LEARNING_STATUS_LABELS[status]}.`
    )
  }
  const action = deps.repo.learning.setRuleStatus(ruleId, status, {
    at,
    detail: describeRule(rule, status, true)
  })

  return { action, change: rulesChange(rule, rule.status, status) }
}

/**
 * Annulla l'ultimo cambio di stato ancora in vigore su una regola, e dice cosa rielaborare.
 *
 * Il pulsante «Annulla ultima modifica» esiste perché oggi, in fase di annotazione, chi usa
 * il tool è una persona sola e sotto un clic sbagliato non c'è niente: uno scarto per errore
 * porta via anche le prove che avevano costruito la regola, che sono la cosa cara — vengono
 * da revisioni vere, e rifarle vuol dire riaprire i documenti.
 *
 * Il ripristino cambia quello che la coda si vedrà applicare addosso, esattamente come un
 * cambio di stato a mano: `change` lo dice al chiamante, che rielabora. Lo stato di partenza
 * si legge prima e quello di arrivo dopo, perché quale dei due sia ACTIVE lo sa solo il
 * deposito.
 */
export function rollbackRuleByHand(
  deps: LearningWorkspaceDeps,
  ruleId: string,
  at: string = new Date().toISOString()
): { action: LearningAction; change: RulesChange } {
  const { learning } = deps.repo
  const before = learning.getRule(ruleId)
  if (!before) throw new ReviewerError('NOT_FOUND', 'Regola non trovata.')
  if (!learning.revertableRuleAction(ruleId)) {
    throw new ReviewerError(
      'INVALID_INPUT',
      'Nessun cambio di stato annullabile per questa regola.'
    )
  }
  const action = learning.rollbackRule(ruleId, at)
  const after = learning.getRule(ruleId)
  if (!after) throw new ReviewerError('NOT_FOUND', 'Regola non trovata.')
  return { action, change: rulesChange(after, before.status, after.status) }
}

/**
 * Cosa rielaborare quando una regola passa da uno stato all'altro: niente, se non stava
 * valendo prima e non vale dopo; la coda del modulo per la memoria dei moduli, quella del
 * tipo per le etichette.
 */
function rulesChange(rule: LearningRule, before: string, after: string): RulesChange {
  const change: RulesChange = { documentTypes: [], templateFingerprints: [] }
  if (before !== 'ACTIVE' && after !== 'ACTIVE') return change
  if (rule.kind === 'TEMPLATE_TYPE' && rule.templateFingerprint) {
    change.templateFingerprints.push(rule.templateFingerprint)
  } else {
    change.documentTypes.push(rule.documentType)
  }
  return change
}

/**
 * Con quale apprendimento sta lavorando il motore: la modalità e un'impronta delle regole
 * attive. Due export con la stessa impronta sono stati precompilati dalle stesse regole; un
 * benchmark la dichiara accanto ai suoi numeri.
 */
export function learningSnapshot(repo: Repository): DatasetLearningSnapshot {
  const active = repo.learning.listRules({ status: 'ACTIVE' })
  const keys = active.map((rule) => rule.ruleKey).sort()
  return {
    mode: repo.learning.mode(),
    learnerVersion: LEARNER_VERSION,
    activeRules: active.length,
    rulesFingerprint:
      keys.length === 0
        ? null
        : createHash('sha256').update(keys.join('\n'), 'utf8').digest('hex').slice(0, 16)
  }
}

/**
 * Da id dell'ontologia v2 a nome del registry V5.1, rovesciando la mappa legacy. Due nomi
 * sullo stesso id (`amount` e `customs_value` su `money.amount`) danno il primo in ordine
 * alfabetico: un nome stabile vale più di una scelta che nessuno può verificare.
 */
export function registryFieldResolver(
  legacyFieldMap: Record<string, string>
): (fieldId: string) => string | null {
  const byField = new Map<string, string>()
  for (const legacy of Object.keys(legacyFieldMap).sort()) {
    const fieldId = legacyFieldMap[legacy]!
    if (!byField.has(fieldId)) byField.set(fieldId, legacy)
  }
  return (fieldId) => byField.get(fieldId) ?? null
}

/** Scrive il file delle regole apprese: regole, eventi e cronologia, senza valori. */
export async function exportLearnedRules(
  deps: LearningWorkspaceDeps & {
    legacyFieldMap: Record<string, string>
    app: { name: string; version: string }
  },
  path: string,
  now: Date = new Date()
): Promise<LearningExportResult> {
  const { learning } = deps.repo
  const rules = learning.listRules()
  const events = learning.listEvents()
  const bundle = buildLearningBundle({
    manifest: {
      exportedAt: now.toISOString(),
      app: deps.app,
      learnerVersion: LEARNER_VERSION,
      mode: learning.mode(),
      policy: DEFAULT_LEARNING_POLICY,
      counts: learning.counts(),
      templateFingerprintAlgorithm: TEMPLATE_FINGERPRINT_ALGORITHM,
      normalizedTemplateSignatureAlgorithm: NORMALIZED_TEMPLATE_SIGNATURE_ALGORITHM
    },
    rules,
    events,
    actions: learning.listActions(),
    registryFieldOf: registryFieldResolver(deps.legacyFieldMap)
  })
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
  return { saved: true, path, rules: rules.length, events: events.length }
}
