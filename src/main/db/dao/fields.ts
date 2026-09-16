import { randomUUID } from 'node:crypto'
import type {
  Cardinality,
  ExtractionScalar,
  FieldReviewStatus,
  FieldRole
} from '@shared/extraction-v2'
import type { Db } from '../index'
import type { FieldItemRow, FieldRow } from '../rows'

export interface FieldItemInput {
  itemIndex: number
  /** Valore normalizzato; finisce in `value_json`. */
  value: string | null
  confidence: number
  evidenceId?: string | null
  validationErrors?: string[]
}

export interface FieldInput {
  name: string
  label: string
  value: string | null
  confidence: number
  evidenceId?: string | null
  /** Metadati v2: il motore v1 non li passa e le colonne restano ai default. */
  semanticType?: ExtractionScalar | null
  role?: FieldRole | null
  cardinality?: Cardinality
  reviewStatus?: FieldReviewStatus | null
  validationErrors?: string[] | null
  /** Solo per `cardinality = 'many'`. */
  items?: FieldItemInput[]
}

export interface ReplaceFieldsOptions {
  /**
   * Altri nomi sotto cui cercare una correzione già salvata. Serve fra motori: dopo la
   * migrazione 0004 i nomi sono quelli dell'ontologia, e un re-run col v1 deve ritrovare
   * `document.number` scrivendo `document_number` (e viceversa).
   */
  correctionAliases?: (name: string) => string[]
  /**
   * Una correzione su un campo che il nuovo run non produce più (tipo cambiato, profilo
   * v2 senza quel campo, tipo non riconosciuto) resta come campo a sé invece di sparire.
   * Il motore v1 non lo chiede: lì vale il comportamento di sempre.
   */
  keepUnmatchedCorrections?: boolean
}

type KeptCorrection = Pick<
  FieldRow,
  'name' | 'label' | 'value' | 'confidence' | 'updated_at' | 'semantic_type'
> & { corrected_value: string }

interface KeptItemCorrection {
  corrected_value_json: string
  updated_at: string | null
}

function errorsJson(errors: string[] | null | undefined): string | null {
  return errors && errors.length > 0 ? JSON.stringify(errors) : null
}

export function createFieldsDao(db: Db) {
  const insert = db.prepare(`
    INSERT INTO fields (id, document_id, name, label, value, corrected_value, confidence, evidence_id,
                        updated_at, semantic_type, cardinality, review_status, validation_errors_json, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'one'), ?, ?, ?)
  `)
  const insertItem = db.prepare(`
    INSERT INTO field_items (id, field_id, item_index, value_json, corrected_value_json, confidence,
                             evidence_id, validation_errors_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  return {
    /**
     * Sostituisce i campi di un documento. Le correzioni umane gia` salvate vengono
     * conservate per nome del campo: una ri-estrazione non deve cancellare il lavoro
     * del revisore. Per i campi `many` la correzione di un elemento torna sullo stesso
     * `item_index`; se il nuovo run ne trova meno, l'elemento corretto resta comunque.
     */
    replaceForDocument(
      documentId: string,
      fields: FieldInput[],
      options: ReplaceFieldsOptions = {}
    ): void {
      const previous = db
        .prepare(`
          SELECT name, label, value, corrected_value, confidence, updated_at, semantic_type
            FROM fields
           WHERE document_id = ? AND corrected_value IS NOT NULL AND cardinality = 'one'
        `)
        .all(documentId) as KeptCorrection[]
      const corrections = new Map(previous.map((row) => [row.name, row] as const))

      const previousItems = db
        .prepare(`
          SELECT f.name, i.item_index, i.corrected_value_json, i.updated_at
            FROM field_items i JOIN fields f ON f.id = i.field_id
           WHERE f.document_id = ? AND i.corrected_value_json IS NOT NULL
        `)
        .all(documentId) as Array<
        { name: string } & Pick<FieldItemRow, 'item_index' | 'corrected_value_json' | 'updated_at'>
      >
      const itemCorrections = new Map<string, Map<number, KeptItemCorrection>>()
      for (const row of previousItems) {
        const byIndex = itemCorrections.get(row.name) ?? new Map<number, KeptItemCorrection>()
        byIndex.set(row.item_index, {
          corrected_value_json: row.corrected_value_json!,
          updated_at: row.updated_at
        })
        itemCorrections.set(row.name, byIndex)
      }

      /** Il primo fra il nome e i suoi alias che ha una correzione salvata. */
      const matchName = (source: Map<string, unknown>, name: string): string | undefined =>
        [name, ...(options.correctionAliases?.(name) ?? [])].find((candidate) =>
          source.has(candidate)
        )

      // field_items se ne vanno con i campi (ON DELETE CASCADE).
      db.prepare('DELETE FROM fields WHERE document_id = ?').run(documentId)

      const consumed = new Set<string>()
      for (const field of fields) {
        const id = randomUUID()
        const keptName = matchName(corrections, field.name)
        const kept = keptName ? corrections.get(keptName) : undefined
        if (keptName) consumed.add(keptName)
        insert.run(
          id,
          documentId,
          field.name,
          field.label,
          field.value,
          kept?.corrected_value ?? null,
          field.confidence,
          field.evidenceId ?? null,
          kept?.updated_at ?? null,
          field.semanticType ?? null,
          field.cardinality ?? null,
          field.reviewStatus ?? null,
          errorsJson(field.validationErrors),
          field.role ?? null
        )

        if (field.cardinality !== 'many') continue
        const itemsName = matchName(itemCorrections, field.name)
        const keptItems =
          (itemsName && itemCorrections.get(itemsName)) || new Map<number, KeptItemCorrection>()
        const written = new Set<number>()
        for (const item of field.items ?? []) {
          const correction = keptItems.get(item.itemIndex)
          insertItem.run(
            randomUUID(),
            id,
            item.itemIndex,
            item.value === null ? null : JSON.stringify(item.value),
            correction?.corrected_value_json ?? null,
            item.confidence,
            item.evidenceId ?? null,
            errorsJson(item.validationErrors),
            correction?.updated_at ?? null
          )
          written.add(item.itemIndex)
        }
        for (const [itemIndex, correction] of keptItems) {
          if (written.has(itemIndex)) continue
          insertItem.run(
            randomUUID(),
            id,
            itemIndex,
            null,
            correction.corrected_value_json,
            0,
            null,
            null,
            correction.updated_at
          )
        }
      }

      if (!options.keepUnmatchedCorrections) return
      for (const kept of corrections.values()) {
        if (consumed.has(kept.name)) continue
        // Senza evidenza: quella vecchia è appena stata sostituita.
        insert.run(
          randomUUID(),
          documentId,
          kept.name,
          kept.label,
          kept.value,
          kept.corrected_value,
          kept.confidence,
          null,
          kept.updated_at,
          kept.semantic_type,
          'one',
          'NEEDS_REVIEW',
          null,
          'optional'
        )
      }
    },

    listForDocument(documentId: string): FieldRow[] {
      return db
        .prepare('SELECT * FROM fields WHERE document_id = ? ORDER BY rowid')
        .all(documentId) as FieldRow[]
    },

    get(id: string): FieldRow | undefined {
      return db.prepare('SELECT * FROM fields WHERE id = ?').get(id) as FieldRow | undefined
    },

    /**
     * Registra la correzione umana. `null` annulla la correzione e riporta il campo
     * al valore precompilato: `value` non viene mai sovrascritto.
     */
    setCorrectedValue(id: string, correctedValue: string | null): void {
      db.prepare('UPDATE fields SET corrected_value = ?, updated_at = ? WHERE id = ?').run(
        correctedValue,
        correctedValue === null ? null : new Date().toISOString(),
        id
      )
    },

    corrected(documentId: string): FieldRow[] {
      return db
        .prepare('SELECT * FROM fields WHERE document_id = ? AND corrected_value IS NOT NULL')
        .all(documentId) as FieldRow[]
    },

    listItems(fieldId: string): FieldItemRow[] {
      return db
        .prepare('SELECT * FROM field_items WHERE field_id = ? ORDER BY item_index')
        .all(fieldId) as FieldItemRow[]
    },

    /** Elementi con un valore, precompilato o corretto: un campo `many` vuoto non ne ha. */
    countFilledItems(fieldId: string): number {
      const row = db
        .prepare(`
          SELECT COUNT(*) AS c FROM field_items
           WHERE field_id = ? AND COALESCE(corrected_value_json, value_json) IS NOT NULL
        `)
        .get(fieldId) as { c: number }
      return row.c
    },

    /** Come `setCorrectedValue`, per un elemento di un campo `many`. */
    setItemCorrectedValue(itemId: string, correctedValue: string | null): void {
      db.prepare(
        'UPDATE field_items SET corrected_value_json = ?, updated_at = ? WHERE id = ?'
      ).run(
        correctedValue === null ? null : JSON.stringify(correctedValue),
        correctedValue === null ? null : new Date().toISOString(),
        itemId
      )
    }
  }
}

export type FieldsDao = ReturnType<typeof createFieldsDao>
