import { randomUUID } from 'node:crypto'
import type { Cardinality } from '@shared/extraction-v2'
import type { ProfileEditReason } from '@shared/profile-edit'
import type { ProfileAction, ProfileActionKind } from '@shared/profile-history'
import {
  type CardinalityByType,
  type FieldState,
  fieldStateOrNull,
  type MapValue,
  type OverridesByType,
  type ProfileOverlay,
  type TypeCardinality,
  type TypeOverrides
} from '@shared/profile-overlay'
import type { Db } from '../index'

/**
 * La mappa «tipo documento ↔ dati da estrarre» come l'ha corretta il revisore.
 *
 * Quattro tabelle (migrazioni 0008 e 0009) e un'unica regola: i JSON del registry non si toccano.
 * Qui c'è solo quello che il revisore ha deciso, e la cronologia di come ci è arrivato.
 *
 * L'overlay viene chiesto dal motore a ogni documento elaborato, quindi sta in memoria e
 * si ricostruisce solo dopo una scrittura: questo DAO è l'unico che scrive quelle
 * tabelle, e sa quando la copia in memoria è vecchia.
 */

interface OverrideRow {
  document_type: string
  field_id: string
  state: string
  updated_at: string
}

interface CardinalityRow {
  document_type: string
  field_id: string
  cardinality: string
  updated_at: string
}

interface HintRow {
  field_id: string
  label: string
  document_type: string
  created_at: string
}

interface ActionRow {
  id: string
  at: string
  kind: string
  document_type: string | null
  field_id: string | null
  label: string | null
  before_state: string | null
  after_state: string | null
  previous_override: string | null
  detail: string
  numbers_json: string | null
  reverts_id: string | null
  reverted_at: string | null
}

/**
 * Un valore della cronologia come lo intende il codice di oggi: una cardinalità resta
 * quella, un ruolo passa da `fieldStateOrNull`. `previousOverride` è quello che un
 * annullamento rimette su `profile_overrides`, quindi un ruolo di quattro versioni fa
 * deve arrivarci tradotto, o la riga che riscrive non sarebbe accettata. Il racconto
 * dell'azione resta in `detail`, com'era scritto allora.
 */
function toMapValue(value: string | null): MapValue | null {
  if (value === 'one' || value === 'many') return value
  return fieldStateOrNull(value)
}

function toAction(row: ActionRow): ProfileAction {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind as ProfileActionKind,
    documentType: row.document_type,
    fieldId: row.field_id,
    label: row.label,
    before: toMapValue(row.before_state),
    after: toMapValue(row.after_state),
    previousOverride: toMapValue(row.previous_override),
    detail: row.detail,
    reason: row.numbers_json ? (JSON.parse(row.numbers_json) as ProfileEditReason) : null,
    revertsId: row.reverts_id,
    revertedAt: row.reverted_at
  }
}

/** Quello che serve per scrivere un'azione in cronologia. */
export interface NewProfileAction {
  kind: ProfileActionKind
  detail: string
  documentType?: string | null
  fieldId?: string | null
  label?: string | null
  before?: MapValue | null
  after?: MapValue | null
  previousOverride?: MapValue | null
  reason?: ProfileEditReason | null
  revertsId?: string | null
  at?: string
}

export function createProfileMapDao(db: Db) {
  const selectOverrides = db.prepare('SELECT * FROM profile_overrides')
  const upsertOverride = db.prepare(
    `INSERT INTO profile_overrides (document_type, field_id, state, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (document_type, field_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
  )
  const deleteOverride = db.prepare(
    'DELETE FROM profile_overrides WHERE document_type = ? AND field_id = ?'
  )

  const selectCardinality = db.prepare('SELECT * FROM profile_cardinality_overrides')
  const upsertCardinality = db.prepare(
    `INSERT INTO profile_cardinality_overrides (document_type, field_id, cardinality, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (document_type, field_id) DO UPDATE SET cardinality = excluded.cardinality, updated_at = excluded.updated_at`
  )
  const deleteCardinality = db.prepare(
    'DELETE FROM profile_cardinality_overrides WHERE document_type = ? AND field_id = ?'
  )

  // La tabella è WITHOUT ROWID: l'ordine stabile lo danno le colonne, non un rowid.
  const selectHints = db.prepare(
    'SELECT * FROM profile_hint_labels ORDER BY created_at, field_id, label'
  )
  const insertHint = db.prepare(
    'INSERT OR IGNORE INTO profile_hint_labels (field_id, label, document_type, created_at) VALUES (?, ?, ?, ?)'
  )
  const deleteHint = db.prepare('DELETE FROM profile_hint_labels WHERE field_id = ? AND label = ?')

  const insertAction = db.prepare(
    `INSERT INTO profile_actions
       (id, at, kind, document_type, field_id, label, before_state, after_state,
        previous_override, detail, numbers_json, reverts_id, reverted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  )
  const setReverted = db.prepare('UPDATE profile_actions SET reverted_at = ? WHERE id = ?')
  const selectAction = db.prepare('SELECT * FROM profile_actions WHERE id = ?')

  /** L'overlay in memoria: si butta a ogni scrittura, si rifà alla prima lettura. */
  let cached: ProfileOverlay | null = null

  function overlay(): ProfileOverlay {
    if (cached) return cached

    const fields: OverridesByType = {}
    for (const row of selectOverrides.all() as OverrideRow[]) {
      // Una riga scritta quando i ruoli erano quattro va letta come si legge oggi. La
      // 0021 le ha già convertite: qui si legge anche un database che quella migrazione
      // non ha ancora visto, e una riga illeggibile vale «nessuna decisione» invece di
      // far cadere il motore e ogni export.
      const state = fieldStateOrNull(row.state)
      if (!state) continue
      const forType = fields[row.document_type] ?? {}
      forType[row.field_id] = state
      fields[row.document_type] = forType
    }

    const cardinality: CardinalityByType = {}
    for (const row of selectCardinality.all() as CardinalityRow[]) {
      const forType = cardinality[row.document_type] ?? {}
      forType[row.field_id] = row.cardinality as Cardinality
      cardinality[row.document_type] = forType
    }

    const hintLabels: Record<string, string[]> = {}
    for (const row of selectHints.all() as HintRow[]) {
      hintLabels[row.field_id] = [...(hintLabels[row.field_id] ?? []), row.label]
    }

    cached = { fields, hintLabels, cardinality }
    return cached
  }

  return {
    overlay,

    /** Le decisioni prese su un tipo solo. Oggetto vuoto se non ce n'è nessuna. */
    forType(documentType: string): TypeOverrides {
      return overlay().fields[documentType] ?? {}
    },

    /** Le cardinalità decise su un tipo solo. Oggetto vuoto se non ce n'è nessuna. */
    cardinalityForType(documentType: string): TypeCardinality {
      return overlay().cardinality[documentType] ?? {}
    },

    /** I tipi su cui il revisore ha deciso qualcosa: un peso, «non utile» o una cardinalità. */
    touchedTypes(): string[] {
      const { fields, cardinality } = overlay()
      const touched = [...Object.entries(fields), ...Object.entries(cardinality)]
        .filter(([, decisions]) => Object.keys(decisions).length > 0)
        .map(([documentType]) => documentType)
      return [...new Set(touched)].sort()
    },

    setOverride(documentType: string, fieldId: string, state: FieldState, at: string): void {
      upsertOverride.run(documentType, fieldId, state, at)
      cached = null
    },

    clearOverride(documentType: string, fieldId: string): void {
      deleteOverride.run(documentType, fieldId)
      cached = null
    },

    setCardinality(
      documentType: string,
      fieldId: string,
      cardinality: Cardinality,
      at: string
    ): void {
      upsertCardinality.run(documentType, fieldId, cardinality, at)
      cached = null
    },

    clearCardinality(documentType: string, fieldId: string): void {
      deleteCardinality.run(documentType, fieldId)
      cached = null
    },

    hintLabels(fieldId: string): string[] {
      return overlay().hintLabels[fieldId] ?? []
    },

    addHintLabel(fieldId: string, label: string, documentType: string, at: string): void {
      insertHint.run(fieldId, label, documentType, at)
      cached = null
    },

    removeHintLabel(fieldId: string, label: string): void {
      deleteHint.run(fieldId, label)
      cached = null
    },

    /** Scrive un'azione in cronologia e la restituisce come la leggerà la schermata. */
    addAction(action: NewProfileAction): ProfileAction {
      const row: ActionRow = {
        id: randomUUID(),
        at: action.at ?? new Date().toISOString(),
        kind: action.kind,
        document_type: action.documentType ?? null,
        field_id: action.fieldId ?? null,
        label: action.label ?? null,
        before_state: action.before ?? null,
        after_state: action.after ?? null,
        previous_override: action.previousOverride ?? null,
        detail: action.detail,
        numbers_json: action.reason ? JSON.stringify(action.reason) : null,
        reverts_id: action.revertsId ?? null,
        reverted_at: null
      }
      insertAction.run(
        row.id,
        row.at,
        row.kind,
        row.document_type,
        row.field_id,
        row.label,
        row.before_state,
        row.after_state,
        row.previous_override,
        row.detail,
        row.numbers_json,
        row.reverts_id
      )
      return toAction(row)
    },

    markReverted(id: string, at: string): void {
      setReverted.run(at, id)
    },

    getAction(id: string): ProfileAction | undefined {
      const row = selectAction.get(id) as ActionRow | undefined
      return row ? toAction(row) : undefined
    },

    /** Le azioni più recenti, dalla più nuova. */
    listActions(limit = 500): ProfileAction[] {
      const rows = db
        .prepare('SELECT * FROM profile_actions ORDER BY at DESC, rowid DESC LIMIT ?')
        .all(limit) as ActionRow[]
      return rows.map(toAction)
    },

    /** Tutte le azioni, dalla più vecchia: è l'ordine in cui si legge un changelog. */
    allActions(): ProfileAction[] {
      const rows = db
        .prepare('SELECT * FROM profile_actions ORDER BY at, rowid')
        .all() as ActionRow[]
      return rows.map(toAction)
    },

    /** Quante correzioni alla mappa sono ancora in piedi. */
    countStandingEdits(): number {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM profile_actions
            WHERE reverted_at IS NULL
              AND kind IN ('ADD_FIELD', 'REMOVE_FIELD', 'SET_ROLE', 'RESTORE_FIELD', 'ADD_HINT_LABEL',
                           'SET_CARDINALITY')`
        )
        .get() as { n: number }
      return row.n
    }
  }
}

export type ProfileMapDao = ReturnType<typeof createProfileMapDao>
