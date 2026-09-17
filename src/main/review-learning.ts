import {
  DEFAULT_LEARNING_POLICY,
  documentKey,
  isAnchorPattern,
  LEARNING_MODE_LABELS,
  type LearningAction,
  type LearningEffect,
  type LearningEvent,
  type LearningPolicy,
  type LearningRule,
  nextRuleStatus,
  rulePrecision,
  ruleSupport
} from '@shared/local-learning'
import { describeLearnedReview, reviewLearningEvents } from '@shared/review-learning'
import type { ReviewAction, ReviewDocument } from '@shared/types'
import type { LearningWriter } from './db/dao/learning'
import type { Repository } from './db/repository'
import type { ExtractionRegistryV2 } from './extract/v2/profile-loader'
import { anchorRuleInputs, deriveAnchor } from './learning-anchors'
import { templateTypeRuleInput } from './learning-templates'

/**
 * La revisione chiusa, registrata per il learner, e quello che ne impara.
 *
 * Si impara qui e non a ogni modifica di un campo: mentre il revisore lavora i valori sono
 * provvisori, e il salvataggio è la decisione finale. Il documento è quello letto prima di
 * chiudere, con tipo, campi e selezioni come il revisore li ha lasciati.
 *
 * Va chiamata dentro la transazione che chiude il documento: una revisione salvata senza i
 * suoi eventi perderebbe l'unico dato che non si può ricostruire, e degli eventi senza la
 * revisione insegnerebbero qualcosa che non è successo.
 *
 * Da una revisione salvata:
 * - un valore selezionato sul documento insegna l'etichetta che lo annuncia, per il template
 *   e per il tipo (`learning-anchors.ts`);
 * - un valore proposto da una regola la mette alla prova: confermato la sostiene, corretto
 *   la smentisce — a meno che il revisore non abbia selezionato proprio quello che la regola
 *   legge, e la correzione sia solo di forma;
 * - il tipo con cui un documento con un'impronta viene chiuso sostiene la memoria di quel
 *   modulo per quel tipo, e smentisce quella per ogni altro tipo (`learning-templates.ts`);
 * - le regole toccate si promuovono o si sospendono con `nextRuleStatus`.
 *
 * Una prova vale per documento: chiudere di nuovo un documento sostituisce le sue prove,
 * scartarlo le toglie.
 */

export interface LearnFromReviewInput {
  document: ReviewDocument
  action: ReviewAction
  at: string
  /** Chi ha salvato: l'account collegato. `null` se non si sa, e allora non si registra. */
  actor: string | null
  /** Senza registry v2 non si ricavano etichette: gli eventi si registrano lo stesso. */
  registry?: ExtractionRegistryV2 | undefined
  policy?: LearningPolicy
}

/** Cosa rielaborare dopo che una regola ha cominciato o smesso di valere. */
export interface RulesChange {
  /** Tipi con un'etichetta cambiata: la coda di quel tipo. */
  documentTypes: string[]
  /** Moduli con una memoria cambiata: la coda con quell'impronta, qualunque tipo abbia. */
  templateFingerprints: string[]
}

export interface LearnedReview {
  /** La frase per la timeline, `null` quando non c'è niente da dire. */
  note: string | null
  changed: RulesChange
}

const NO_CHANGE: RulesChange = { documentTypes: [], templateFingerprints: [] }
const NOTHING: LearnedReview = { note: null, changed: NO_CHANGE }

/** Le correzioni che danno un valore: da lì si impara dove stava. */
const TEACHES = new Set(['CHANGED', 'FILLED', 'ADDED'])

export function learnFromReview(repo: Repository, input: LearnFromReviewInput): LearnedReview {
  const mode = repo.learning.mode()
  const policy = input.policy ?? DEFAULT_LEARNING_POLICY
  const key = documentKey({
    contentSha256: input.document.contentSha256,
    documentId: input.document.id
  })

  if (input.action !== 'SAVE') {
    // Uno scarto non insegna niente, e toglie quello che il documento aveva insegnato.
    if (mode !== 'LEARNING') return NOTHING
    const settled = repo.learning.acquire((writer) =>
      settle(writer, writer.retractDocument(key, input.at), input.at, policy)
    )
    if (!settled || settled.touched === 0) return NOTHING
    return {
      note: `Apprendimento: tolte le prove di questo documento da ${plural(settled.touched, 'regola', 'regole')}.${describeActions(settled.actions)}`,
      changed: settled.changed
    }
  }

  if (mode !== 'LEARNING') {
    return { note: `${LEARNING_MODE_LABELS[mode]}: revisione non registrata.`, changed: NO_CHANGE }
  }
  if (!input.actor) {
    return {
      note: 'Apprendimento: revisione non registrata, nessun account collegato.',
      changed: NO_CHANGE
    }
  }

  const templateFingerprint = repo.documents.get(input.document.id)?.template_fingerprint ?? null
  const events = reviewLearningEvents(input.document, {
    at: input.at,
    actor: input.actor,
    templateFingerprint
  })

  const settled = repo.learning.acquire((writer) => {
    const touched = writer.retractDocument(key, input.at)
    for (const event of events.map((entry) => writer.addEvent(entry))) {
      for (const [rule, effect] of proofs(writer, repo, event, input)) {
        touched.push(writer.recordEvidence(rule.id, event.id, effect, input.at))
      }
    }
    return settle(writer, touched, input.at, policy)
  })

  return {
    note: `${describeLearnedReview(events)}${describeActions(settled?.actions ?? [])}`,
    changed: settled?.changed ?? NO_CHANGE
  }
}

/** Le regole che un evento sostiene o smentisce, creando quelle che insegna. */
function proofs(
  writer: LearningWriter,
  repo: Repository,
  event: LearningEvent,
  input: LearnFromReviewInput
): Array<[LearningRule, LearningEffect]> {
  const result: Array<[LearningRule, LearningEffect]> = []
  const taught: LearningRule[] = []

  if (event.kind === 'DOCUMENT_TYPE' && event.templateFingerprint) {
    // Il modulo chiuso con questo tipo: a favore di questo tipo, contro tutti gli altri che
    // lo stesso modulo aveva avuto. Un tipo tolto smentisce tutti.
    for (const rule of repo.learning.listRules({
      kind: 'TEMPLATE_TYPE',
      templateFingerprint: event.templateFingerprint
    })) {
      if (rule.documentType !== event.documentType) result.push([rule, 'NEGATIVE'])
    }
    if (event.documentType) {
      const input = templateTypeRuleInput(event.documentType, event.templateFingerprint)
      result.push([
        writer.findRule(input.ruleKey) ?? writer.createRule(input, event.at),
        'POSITIVE'
      ])
    }
    return result
  }

  const spec = event.fieldId ? input.registry?.field(event.fieldId) : undefined
  const location = event.pick?.location
  if (
    event.kind === 'FIELD_VALUE' &&
    TEACHES.has(event.outcome) &&
    spec &&
    event.fieldId &&
    event.documentType &&
    event.pick &&
    location
  ) {
    const pattern = deriveAnchor({
      lines: repo.pages.lines(event.documentId, event.pick.page),
      location,
      fieldId: event.fieldId,
      spec
    })
    if (pattern) {
      for (const rule of anchorRuleInputs({
        pattern,
        documentType: event.documentType,
        fieldId: event.fieldId,
        templateFingerprint: event.templateFingerprint
      })) {
        const existing = writer.findRule(rule.ruleKey) ?? writer.createRule(rule, input.at)
        taught.push(existing)
        result.push([existing, 'POSITIVE'])
      }
    }
  }

  if (event.engineRuleId && !taught.some((rule) => rule.id === event.engineRuleId)) {
    // La regola che aveva proposto il valore: se il revisore l'ha selezionato altrove o
    // l'ha riscritto, la regola ha letto la cosa sbagliata.
    const confirmed = event.outcome === 'CONFIRMED'
    const engineRule = ruleById(writer, repo, event.engineRuleId)
    if (engineRule) result.push([engineRule, confirmed ? 'POSITIVE' : 'NEGATIVE'])
  }
  return result
}

function ruleById(writer: LearningWriter, repo: Repository, id: string): LearningRule | undefined {
  const rule = repo.learning.getRule(id)
  return rule ? writer.findRule(rule.ruleKey) : undefined
}

interface Settled {
  touched: number
  actions: LearningAction[]
  changed: RulesChange
}

/** Porta ogni regola toccata allo stato che le sue prove chiedono. */
function settle(
  writer: LearningWriter,
  rules: LearningRule[],
  at: string,
  policy: LearningPolicy
): Settled {
  const keys = [...new Set(rules.map((rule) => rule.ruleKey))]
  const actions: LearningAction[] = []
  const documentTypes = new Set<string>()
  const templateFingerprints = new Set<string>()
  for (const ruleKey of keys) {
    const rule = writer.findRule(ruleKey)
    if (!rule) continue
    const next = nextRuleStatus(rule, writer.effectsSinceActive(rule.id), policy)
    if (next === rule.status) continue
    actions.push(writer.changeRuleStatus(rule.id, next, { at, detail: describeRule(rule, next) }))
    if (rule.kind === 'TEMPLATE_TYPE' && rule.templateFingerprint) {
      templateFingerprints.add(rule.templateFingerprint)
    } else {
      documentTypes.add(rule.documentType)
    }
  }
  return {
    touched: keys.length,
    actions,
    changed: {
      documentTypes: [...documentTypes],
      templateFingerprints: [...templateFingerprints]
    }
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`
}

/**
 * La riga di cronologia di un cambio di stato, coi numeri che l'hanno deciso. `byHand` per
 * i cambi decisi dalla scheda «Apprendimento»: lì la ragione è la persona, non i numeri.
 */
export function describeRule(rule: LearningRule, next: string, byHand = false): string {
  if (byHand) {
    const verb = next === 'ACTIVE' ? 'riattivata' : next === 'SUSPENDED' ? 'sospesa' : 'scartata'
    const what =
      rule.kind === 'TEMPLATE_TYPE'
        ? `Memoria del modulo ${rule.templateFingerprint} come ${rule.documentType}`
        : isAnchorPattern(rule.pattern)
          ? `Etichetta «${rule.pattern.label}» per ${rule.fieldId}`
          : `Regola ${rule.kind}`
    return `${what} ${verb} a mano: ${plural(ruleSupport(rule), 'conferma', 'conferme')}, ${plural(rule.negativeCount, 'smentita', 'smentite')}.`
  }
  if (rule.kind === 'TEMPLATE_TYPE') {
    const verb =
      next === 'ACTIVE' ? 'attivata' : next === 'SUSPENDED' ? 'sospesa' : next.toLowerCase()
    const reason =
      next === 'SUSPENDED'
        ? `lo stesso modulo è stato chiuso anche con un altro tipo (${plural(rule.negativeCount, 'smentita', 'smentite')})`
        : plural(ruleSupport(rule), 'revisione concorde', 'revisioni concordi')
    return `Memoria del modulo ${rule.templateFingerprint} come ${rule.documentType} ${verb}: ${reason}.`
  }
  const what = isAnchorPattern(rule.pattern)
    ? `Etichetta «${rule.pattern.label}» per ${rule.fieldId}`
    : `Regola ${rule.kind}`
  const where = rule.scope === 'TEMPLATE' ? `sul template ${rule.templateFingerprint}` : 'sul tipo'
  const numbers = `${plural(ruleSupport(rule), 'conferma', 'conferme')}, precisione ${percent(rulePrecision(rule))}`
  const verb =
    next === 'ACTIVE' ? 'attivata' : next === 'SUSPENDED' ? 'sospesa' : next.toLowerCase()
  return `${what} ${where} (${rule.documentType}) ${verb}: ${numbers}.`
}

function describeActions(actions: LearningAction[]): string {
  const promoted = actions.filter((action) => action.after === 'ACTIVE').length
  const suspended = actions.filter((action) => action.after === 'SUSPENDED').length
  const parts = [
    promoted > 0 ? plural(promoted, 'regola attivata', 'regole attivate') : null,
    suspended > 0 ? plural(suspended, 'regola sospesa', 'regole sospese') : null
  ].filter((part) => part !== null)
  return parts.length === 0 ? '' : ` ${parts.join(', ')}.`
}
