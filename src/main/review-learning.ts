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
  type LearningRuleInput,
  nextRuleStatus,
  rulePrecision,
  ruleSupport
} from '@shared/local-learning'
import { describeLearnedReview, reviewLearningEvents } from '@shared/review-learning'
import {
  isNormalizedTemplateSignature,
  type NormalizedTemplateSignature,
  parseNormalizedTemplateSignature,
  templateSignatureSimilarity
} from '@shared/template-fingerprint'
import type { ReviewAction, ReviewDocument } from '@shared/types'
import type { LearningWriter } from './db/dao/learning'
import type { Repository } from './db/repository'
import type { ExtractionRegistryV2 } from './extract/v2/profile-loader'
import { anchorRuleInputs, deriveAnchor, documentEntityWords } from './learning-anchors'
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
  /**
   * La revisione si ripassa invece di chiuderla adesso: `at` resta il momento in cui il
   * revisore aveva deciso, e questa è la data in cui l'evento viene scritto.
   */
  replayedAt?: string | null
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
  /** Quante decisioni sono finite nel registro: 0 fuori da LEARNING, o se non ce n'erano. */
  events: number
  changed: RulesChange
}

const NO_CHANGE: RulesChange = { documentTypes: [], templateFingerprints: [] }
const NOTHING: LearnedReview = { note: null, events: 0, changed: NO_CHANGE }

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
      events: 0,
      changed: settled.changed
    }
  }

  if (mode !== 'LEARNING') {
    return {
      note: `${LEARNING_MODE_LABELS[mode]}: revisione non registrata.`,
      events: 0,
      changed: NO_CHANGE
    }
  }
  if (!input.actor) {
    return {
      note: 'Apprendimento: revisione non registrata, nessun account collegato.',
      events: 0,
      changed: NO_CHANGE
    }
  }

  const documentRow = repo.documents.get(input.document.id)
  const templateFingerprint = documentRow?.template_fingerprint ?? null
  const templateSignature = parseNormalizedTemplateSignature(documentRow?.template_signature_json)
  const events = reviewLearningEvents(input.document, {
    at: input.at,
    actor: input.actor,
    templateFingerprint,
    templateSignature,
    replayedAt: input.replayedAt ?? null
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
    events: events.length,
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
    const sameModule = repo.learning
      .listRules({ kind: 'TEMPLATE_TYPE' })
      .filter((rule) => sameTemplate(rule, event.templateFingerprint, event.templateSignature))
    for (const rule of sameModule) {
      if (rule.documentType !== event.documentType) result.push([rule, 'NEGATIVE'])
    }
    if (event.documentType) {
      const ruleInput = templateTypeRuleInput(
        event.documentType,
        event.templateFingerprint,
        event.templateSignature
      )
      // La memoria di questo modulo può già esistere sotto un'altra impronta: è lo stesso
      // stampato riconosciuto per somiglianza, e le due revisioni devono contare insieme.
      const existing = sameModule.find((rule) => rule.documentType === event.documentType)
      result.push([
        (existing ? writer.findRule(existing.ruleKey) : undefined) ??
          writer.findRule(ruleInput.ruleKey) ??
          writer.createRule(ruleInput, event.at),
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
        templateFingerprint: event.templateFingerprint,
        templateSignature: event.templateSignature,
        entityWords: documentEntityWords(input.document, event.fieldId)
      })) {
        // Come sopra: una regola di template già imparata su un esemplare somigliante è la
        // stessa regola, e va ritrovata prima di crearne una nuova a supporto 1.
        const compatible =
          rule.scope === 'TEMPLATE'
            ? repo.learning
                .listRules({ kind: 'EXTRACTION_ANCHOR', documentType: event.documentType })
                .find((candidate) => compatibleAnchor(candidate, rule))
            : undefined
        const existing =
          (compatible ? writer.findRule(compatible.ruleKey) : undefined) ??
          writer.findRule(rule.ruleKey) ??
          writer.createRule(rule, input.at)
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

/**
 * Lo stesso modulo del documento che si sta registrando: impronta identica — che tiene
 * buone le regole scritte prima della firma — oppure testate abbastanza somiglianti.
 */
function sameTemplate(
  rule: LearningRule,
  templateFingerprint: string | null,
  templateSignature: NormalizedTemplateSignature | null | undefined
): boolean {
  if (templateFingerprint !== null && rule.templateFingerprint === templateFingerprint) return true
  const stored = rule.pattern.templateSignature
  return (
    isNormalizedTemplateSignature(stored) &&
    templateSignatureSimilarity(stored, templateSignature) >=
      DEFAULT_LEARNING_POLICY.minTemplateSimilarity
  )
}

/** La stessa regola d'etichetta su un esemplare somigliante dello stesso modulo. */
function compatibleAnchor(candidate: LearningRule, proposed: LearningRuleInput): boolean {
  if (
    candidate.scope !== 'TEMPLATE' ||
    candidate.kind !== 'EXTRACTION_ANCHOR' ||
    candidate.fieldId !== proposed.fieldId ||
    !isAnchorPattern(candidate.pattern) ||
    !isAnchorPattern(proposed.pattern) ||
    candidate.pattern.label !== proposed.pattern.label ||
    candidate.pattern.relation !== proposed.pattern.relation
  ) {
    return false
  }
  return sameTemplate(candidate, proposed.templateFingerprint, proposed.pattern.templateSignature)
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
