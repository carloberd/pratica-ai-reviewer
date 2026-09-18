import { randomUUID } from 'node:crypto'
import {
  documentKey,
  isLearningMode,
  LEARNER_VERSION,
  LEARNING_MODE_LABELS,
  type LearningAction,
  type LearningActionKind,
  type LearningActionNumbers,
  type LearningCounts,
  type LearningEffect,
  type LearningEvent,
  type LearningEventInput,
  type LearningEventKind,
  type LearningMode,
  type LearningOutcome,
  type LearningPickMethod,
  type LearningRule,
  type LearningRuleInput,
  type LearningRuleKind,
  type LearningRuleScope,
  type LearningRuleStatus,
  rulePrecision,
  ruleSupport
} from '@shared/local-learning'
import { parseNormalizedTemplateSignature } from '@shared/template-fingerprint'
import type { Db } from '../index'
import { parseBbox, toPickLocation } from '../rows'

/**
 * Il deposito del learner locale (migrazione 0011): modalità, eventi, regole, prove e
 * cronologia.
 *
 * La regola che lo governa sta nella forma, non in un controllo sparso: tutto quello che
 * il learner scrive passa da `acquire`, che lo esegue in una transazione e solo in
 * modalità `LEARNING`. In `FROZEN` e `BASELINE` il lavoro non parte nemmeno, quindi non
 * c'è una scrittura dimenticata che possa contaminare un benchmark.
 *
 * Le regole attive si chiedono a ogni documento elaborato: stanno in memoria e si
 * rileggono dopo una scrittura, come l'overlay della mappa.
 */

interface EventRow {
  id: string
  at: string
  actor: string
  document_id: string
  content_sha256: string | null
  template_fingerprint: string | null
  template_signature_json: string | null
  text_source: string | null
  kind: string
  outcome: string
  document_type: string | null
  predicted_type: string | null
  predicted_confidence: number | null
  field_id: string | null
  item_index: number | null
  engine_confidence: number | null
  engine_rule_id: string | null
  pick_method: string | null
  pick_page: number | null
  pick_bbox_json: string | null
  pick_line_start: number | null
  pick_line_end: number | null
  pick_char_start: number | null
  pick_char_end: number | null
  learner_version: string
  replayed_at: string | null
}

interface RuleRow {
  id: string
  kind: string
  scope: string
  document_type: string
  field_id: string | null
  template_fingerprint: string | null
  pattern_json: string
  rule_key: string
  status: string
  positive_count: number
  negative_count: number
  last_positive_at: string | null
  last_negative_at: string | null
  created_at: string
  updated_at: string
  learner_version: string
}

interface ActionRow {
  id: string
  at: string
  kind: string
  rule_id: string | null
  before_state: string | null
  after_state: string | null
  detail: string
  numbers_json: string | null
  reverts_id: string | null
  reverted_at: string | null
}

function toEvent(row: EventRow): LearningEvent {
  const location = toPickLocation({
    line_start: row.pick_line_start,
    line_end: row.pick_line_end,
    char_start: row.pick_char_start,
    char_end: row.pick_char_end
  })
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    documentId: row.document_id,
    contentSha256: row.content_sha256,
    templateFingerprint: row.template_fingerprint,
    templateSignature: parseNormalizedTemplateSignature(row.template_signature_json),
    textSource: row.text_source as LearningEvent['textSource'],
    kind: row.kind as LearningEventKind,
    outcome: row.outcome as LearningOutcome,
    documentType: row.document_type,
    predictedType: row.predicted_type,
    predictedConfidence: row.predicted_confidence,
    fieldId: row.field_id,
    itemIndex: row.item_index,
    engineConfidence: row.engine_confidence,
    engineRuleId: row.engine_rule_id,
    replayedAt: row.replayed_at,
    pick:
      row.pick_method === null || row.pick_page === null
        ? null
        : {
            method: row.pick_method as LearningPickMethod,
            page: row.pick_page,
            bbox: parseBbox(row.pick_bbox_json) ?? null,
            location: location ?? null
          },
    learnerVersion: row.learner_version
  }
}

function toRule(row: RuleRow): LearningRule {
  return {
    id: row.id,
    kind: row.kind as LearningRuleKind,
    scope: row.scope as LearningRuleScope,
    documentType: row.document_type,
    fieldId: row.field_id,
    templateFingerprint: row.template_fingerprint,
    pattern: parseObject(row.pattern_json),
    ruleKey: row.rule_key,
    status: row.status as LearningRuleStatus,
    positiveCount: row.positive_count,
    negativeCount: row.negative_count,
    lastPositiveAt: row.last_positive_at,
    lastNegativeAt: row.last_negative_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    learnerVersion: row.learner_version
  }
}

/**
 * Il pattern salvato, o nessun pattern: un `pattern_json` illeggibile spegne la singola
 * regola invece di far cadere la lettura di tutto il deposito. Senza `label` né `relation`
 * l'ancora non trova più niente, e la regola resta lì da guardare in cronologia — che è
 * l'esito giusto per una riga che il learner non sa più leggere.
 */
function parseObject(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function toAction(row: ActionRow): LearningAction {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind as LearningActionKind,
    ruleId: row.rule_id,
    before: row.before_state,
    after: row.after_state,
    detail: row.detail,
    numbers: row.numbers_json ? parseNumbers(row.numbers_json) : null,
    revertsId: row.reverts_id,
    revertedAt: row.reverted_at
  }
}

/**
 * I numeri di un'azione, o nessuno: la cronologia è un racconto, e una riga che ha perso
 * il supporto e la precisione si legge lo stesso senza. Si controlla anche la forma, non
 * solo che il JSON stia in piedi, perché `support` finisce in una frase e un `undefined`
 * di lì passerebbe fino a schermo.
 */
function parseNumbers(json: string): LearningActionNumbers | null {
  try {
    const value: unknown = JSON.parse(json)
    if (typeof value !== 'object' || value === null) return null
    const numbers = value as Partial<LearningActionNumbers>
    return typeof numbers.support === 'number' &&
      (numbers.precision === null || typeof numbers.precision === 'number')
      ? { support: numbers.support, precision: numbers.precision }
      : null
  } catch {
    return null
  }
}

/**
 * L'azione che un cambio di stato rappresenta. I passaggi che non hanno un nome non sono
 * permessi: una regola scartata non torna, e una candidata non si sospende perché non
 * valeva ancora.
 */
const TRANSITIONS: Record<
  LearningRuleStatus,
  Partial<Record<LearningRuleStatus, LearningActionKind>>
> = {
  CANDIDATE: { ACTIVE: 'RULE_PROMOTED', REJECTED: 'RULE_REJECTED' },
  ACTIVE: { SUSPENDED: 'RULE_SUSPENDED', REJECTED: 'RULE_REJECTED' },
  SUSPENDED: { ACTIVE: 'RULE_REACTIVATED', REJECTED: 'RULE_REJECTED' },
  REJECTED: {}
}

/** Le scritture del learner: si ottengono solo dentro `acquire`. */
export interface LearningWriter {
  /** Registra una decisione del revisore. */
  addEvent(input: LearningEventInput): LearningEvent
  findRule(ruleKey: string): LearningRule | undefined
  /** Una regola nuova nasce candidata, e non lascia righe in cronologia. */
  createRule(input: LearningRuleInput, at: string): LearningRule
  /**
   * Un evento che sostiene o smentisce una regola. Una regola ha al più una prova per
   * documento: ripetere la prova non gonfia i contatori, e se lo stesso documento la
   * sostiene e la smentisce (due righe di un campo ripetuto) vale la smentita.
   */
  recordEvidence(ruleId: string, eventId: string, effect: LearningEffect, at: string): LearningRule
  /**
   * Toglie le prove di un documento da tutte le regole, e ritorna quelle toccate. Serve
   * prima di registrare di nuovo un documento richiuso, e quando un documento salvato viene
   * scartato: vale solo l'ultima chiusura.
   */
  retractDocument(documentKey: string, at: string): LearningRule[]
  /**
   * Gli effetti delle prove arrivate dopo l'ultima volta che la regola è diventata attiva,
   * dalla più recente; tutte, se non lo è mai stata. Le prove della revisione che l'ha
   * attivata non contano: sono quelle che l'hanno fatta attivare.
   */
  effectsSinceActive(ruleId: string): LearningEffect[]
  /** Promuove, sospende, riattiva o scarta una regola, e lo scrive in cronologia. */
  changeRuleStatus(
    ruleId: string,
    status: LearningRuleStatus,
    change: { at: string; detail: string }
  ): LearningAction
}

export function createLearningDao(db: Db) {
  const insertEvent = db.prepare(`
    INSERT INTO learning_events (
      id, at, actor, document_id, content_sha256, template_fingerprint, template_signature_json,
      text_source, kind, outcome,
      document_type, predicted_type, predicted_confidence, field_id, item_index, engine_confidence,
      engine_rule_id, pick_method, pick_page, pick_bbox_json, pick_line_start, pick_line_end,
      pick_char_start, pick_char_end, learner_version, replayed_at
    ) VALUES (
      @id, @at, @actor, @documentId, @contentSha256, @templateFingerprint, @templateSignatureJson,
      @textSource, @kind, @outcome,
      @documentType, @predictedType, @predictedConfidence, @fieldId, @itemIndex, @engineConfidence,
      @engineRuleId, @pickMethod, @pickPage, @pickBboxJson, @pickLineStart, @pickLineEnd,
      @pickCharStart, @pickCharEnd, @learnerVersion, @replayedAt
    )
  `)
  const insertRule = db.prepare(`
    INSERT INTO learning_rules (
      id, kind, scope, document_type, field_id, template_fingerprint, pattern_json, rule_key,
      status, created_at, updated_at, learner_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CANDIDATE', ?, ?, ?)
  `)
  const insertAction = db.prepare(`
    INSERT INTO learning_actions (id, at, kind, rule_id, before_state, after_state, detail, numbers_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const selectRule = db.prepare('SELECT * FROM learning_rules WHERE id = ?')
  const selectRuleByKey = db.prepare('SELECT * FROM learning_rules WHERE rule_key = ?')

  let activeCache: LearningRule[] | null = null

  function mode(): LearningMode {
    const row = db.prepare('SELECT mode FROM learning_state WHERE id = 1').get() as
      | { mode: string }
      | undefined
    // La riga la crea la migrazione e il CHECK ne vincola il valore: se manca è un bug.
    if (!row || !isLearningMode(row.mode)) throw new Error('Stato del learner illeggibile.')
    return row.mode
  }

  function rule(id: string): LearningRule {
    const row = selectRule.get(id) as RuleRow | undefined
    if (!row) throw new Error(`Regola ${id} inesistente.`)
    return toRule(row)
  }

  /** Sposta un contatore; l'ultima data si aggiorna solo quando una prova arriva. */
  function count(ruleId: string, effect: LearningEffect, delta: 1 | -1, at: string) {
    const column = effect === 'POSITIVE' ? 'positive' : 'negative'
    db.prepare(`
      UPDATE learning_rules
         SET ${column}_count = ${column}_count + ?,
             last_${column}_at = CASE WHEN ? > 0 THEN ? ELSE last_${column}_at END,
             updated_at = ?
       WHERE id = ?
    `).run(delta, delta, at, at, ruleId)
  }

  function addAction(action: Omit<LearningAction, 'id' | 'revertsId' | 'revertedAt'>) {
    const id = randomUUID()
    insertAction.run(
      id,
      action.at,
      action.kind,
      action.ruleId,
      action.before,
      action.after,
      action.detail,
      action.numbers ? JSON.stringify(action.numbers) : null
    )
    return { ...action, id, revertsId: null, revertedAt: null }
  }

  const writer: LearningWriter = {
    addEvent(input) {
      const event: LearningEvent = {
        ...input,
        templateSignature: input.templateSignature ?? null,
        id: randomUUID(),
        learnerVersion: LEARNER_VERSION
      }
      insertEvent.run({
        ...event,
        templateSignatureJson: event.templateSignature
          ? JSON.stringify(event.templateSignature)
          : null,
        pickMethod: event.pick?.method ?? null,
        pickPage: event.pick?.page ?? null,
        pickBboxJson: event.pick?.bbox ? JSON.stringify(event.pick.bbox) : null,
        pickLineStart: event.pick?.location?.lineStart ?? null,
        pickLineEnd: event.pick?.location?.lineEnd ?? null,
        pickCharStart: event.pick?.location?.charStart ?? null,
        pickCharEnd: event.pick?.location?.charEnd ?? null
      })
      return event
    },

    findRule(ruleKey) {
      const row = selectRuleByKey.get(ruleKey) as RuleRow | undefined
      return row ? toRule(row) : undefined
    },

    createRule(input, at) {
      const id = randomUUID()
      insertRule.run(
        id,
        input.kind,
        input.scope,
        input.documentType,
        input.fieldId,
        input.scope === 'TEMPLATE' ? input.templateFingerprint : null,
        JSON.stringify(input.pattern),
        input.ruleKey,
        at,
        at,
        LEARNER_VERSION
      )
      return rule(id)
    },

    recordEvidence(ruleId, eventId, effect, at) {
      const event = db
        .prepare('SELECT content_sha256, document_id FROM learning_events WHERE id = ?')
        .get(eventId) as Pick<EventRow, 'content_sha256' | 'document_id'> | undefined
      if (!event) throw new Error(`Evento ${eventId} inesistente.`)
      const key = documentKey({
        contentSha256: event.content_sha256,
        documentId: event.document_id
      })
      const existing = db
        .prepare('SELECT effect FROM learning_rule_evidence WHERE rule_id = ? AND document_key = ?')
        .get(ruleId, key) as { effect: LearningEffect } | undefined

      if (!existing) {
        db.prepare(
          'INSERT INTO learning_rule_evidence (rule_id, document_key, event_id, effect) VALUES (?, ?, ?, ?)'
        ).run(ruleId, key, eventId, effect)
        count(ruleId, effect, +1, at)
      } else if (existing.effect === 'POSITIVE' && effect === 'NEGATIVE') {
        db.prepare(
          'UPDATE learning_rule_evidence SET effect = ?, event_id = ? WHERE rule_id = ? AND document_key = ?'
        ).run(effect, eventId, ruleId, key)
        count(ruleId, 'POSITIVE', -1, at)
        count(ruleId, 'NEGATIVE', +1, at)
      }
      return rule(ruleId)
    },

    retractDocument(key, at) {
      const rows = db
        .prepare('SELECT rule_id, effect FROM learning_rule_evidence WHERE document_key = ?')
        .all(key) as Array<{ rule_id: string; effect: LearningEffect }>
      for (const row of rows) count(row.rule_id, row.effect, -1, at)
      db.prepare('DELETE FROM learning_rule_evidence WHERE document_key = ?').run(key)
      return rows.map((row) => rule(row.rule_id))
    },

    effectsSinceActive(ruleId) {
      return (
        db
          .prepare(`
            SELECT r.effect FROM learning_rule_evidence r
              JOIN learning_events e ON e.id = r.event_id
             WHERE r.rule_id = @ruleId
               AND e.at > COALESCE(
                 (SELECT MAX(at) FROM learning_actions
                   WHERE rule_id = @ruleId AND after_state = 'ACTIVE' AND reverted_at IS NULL),
                 ''
               )
          ORDER BY e.at DESC, e.rowid DESC
          `)
          .all({ ruleId }) as Array<{ effect: LearningEffect }>
      ).map((row) => row.effect)
    },

    changeRuleStatus(ruleId, status, change) {
      const current = rule(ruleId)
      const kind = TRANSITIONS[current.status][status]
      if (!kind) {
        throw new Error(`Una regola ${current.status} non può diventare ${status}.`)
      }
      db.prepare('UPDATE learning_rules SET status = ?, updated_at = ? WHERE id = ?').run(
        status,
        change.at,
        ruleId
      )
      return addAction({
        at: change.at,
        kind,
        ruleId,
        before: current.status,
        after: status,
        detail: change.detail,
        numbers: { support: ruleSupport(current), precision: rulePrecision(current) }
      })
    }
  }

  return {
    mode,

    /**
     * Cambia modalità e lo scrive in cronologia. Chiedere la modalità in cui si è già non
     * scrive niente: `null`.
     */
    setMode(next: LearningMode, at: string = new Date().toISOString()): LearningAction | null {
      return db.transaction(() => {
        const previous = mode()
        if (previous === next) return null
        db.prepare('UPDATE learning_state SET mode = ?, updated_at = ? WHERE id = 1').run(next, at)
        activeCache = null
        return addAction({
          at,
          kind: 'MODE_CHANGED',
          ruleId: null,
          before: previous,
          after: next,
          detail: `${LEARNING_MODE_LABELS[previous]} → ${LEARNING_MODE_LABELS[next]}.`,
          numbers: null
        })
      })()
    },

    /**
     * Un cambio di stato deciso da una persona dalla scheda «Apprendimento». Vale in ogni
     * modalità: `FROZEN` ferma quello che il learner impara da sé, non chi lo governa.
     */
    setRuleStatus(
      ruleId: string,
      status: LearningRuleStatus,
      change: { at: string; detail: string }
    ): LearningAction {
      try {
        return db.transaction(() => writer.changeRuleStatus(ruleId, status, change))()
      } finally {
        activeCache = null
      }
    },

    /**
     * Esegue il lavoro del learner in una transazione, solo in modalità `LEARNING`; nelle
     * altre ritorna `null` senza chiamarlo. Un errore dentro il lavoro annulla tutto
     * quello che aveva scritto.
     */
    acquire<T>(work: (writer: LearningWriter) => T): T | null {
      try {
        return db.transaction(() => (mode() === 'LEARNING' ? work(writer) : null))()
      } finally {
        activeCache = null
      }
    },

    /** Le regole che valgono adesso, dalla più recente. */
    activeRules(): LearningRule[] {
      if (!activeCache) {
        activeCache = (
          db
            .prepare(
              "SELECT * FROM learning_rules WHERE status = 'ACTIVE' ORDER BY updated_at DESC"
            )
            .all() as RuleRow[]
        ).map(toRule)
      }
      return activeCache
    },

    getRule(id: string): LearningRule | undefined {
      const row = selectRule.get(id) as RuleRow | undefined
      return row ? toRule(row) : undefined
    },

    listRules(
      filter: {
        status?: LearningRuleStatus
        kind?: LearningRuleKind
        documentType?: string
        templateFingerprint?: string
      } = {}
    ): LearningRule[] {
      const where: string[] = []
      const params: string[] = []
      if (filter.status) {
        where.push('status = ?')
        params.push(filter.status)
      }
      if (filter.kind) {
        where.push('kind = ?')
        params.push(filter.kind)
      }
      if (filter.documentType) {
        where.push('document_type = ?')
        params.push(filter.documentType)
      }
      if (filter.templateFingerprint) {
        where.push('template_fingerprint = ?')
        params.push(filter.templateFingerprint)
      }
      return (
        db
          .prepare(
            `SELECT * FROM learning_rules ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY updated_at DESC, rowid DESC`
          )
          .all(...params) as RuleRow[]
      ).map(toRule)
    },

    /** Gli eventi dietro una regola, in ordine di tempo. */
    ruleEvidence(ruleId: string): Array<{ event: LearningEvent; effect: LearningEffect }> {
      return (
        db
          .prepare(`
            SELECT e.*, r.effect FROM learning_rule_evidence r
              JOIN learning_events e ON e.id = r.event_id
             WHERE r.rule_id = ?
          ORDER BY e.at, e.rowid
          `)
          .all(ruleId) as Array<EventRow & { effect: string }>
      ).map((row) => ({ event: toEvent(row), effect: row.effect as LearningEffect }))
    },

    listEvents(filter: { documentId?: string } = {}): LearningEvent[] {
      const rows = filter.documentId
        ? db
            .prepare('SELECT * FROM learning_events WHERE document_id = ? ORDER BY at, rowid')
            .all(filter.documentId)
        : db.prepare('SELECT * FROM learning_events ORDER BY at, rowid').all()
      return (rows as EventRow[]).map(toEvent)
    },

    /** La cronologia, dalla più recente. */
    listActions(): LearningAction[] {
      return (
        db
          .prepare('SELECT * FROM learning_actions ORDER BY at DESC, rowid DESC')
          .all() as ActionRow[]
      ).map(toAction)
    },

    counts(): LearningCounts {
      const events = db.prepare('SELECT COUNT(*) AS n FROM learning_events').get() as { n: number }
      const rules: LearningCounts['rules'] = { CANDIDATE: 0, ACTIVE: 0, SUSPENDED: 0, REJECTED: 0 }
      for (const row of db
        .prepare('SELECT status, COUNT(*) AS n FROM learning_rules GROUP BY status')
        .all() as Array<{ status: LearningRuleStatus; n: number }>) {
        rules[row.status] = row.n
      }
      return { events: events.n, rules }
    }
  }
}

export type LearningDao = ReturnType<typeof createLearningDao>
