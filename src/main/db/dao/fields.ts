import { randomUUID } from 'node:crypto'
import type {
  Cardinality,
  ExtractionScalar,
  FieldReviewStatus,
  FieldRole
} from '@shared/extraction-v2'
import type { Db } from '../index'
import { type FieldItemRow, type FieldRow, parseItemValue } from '../rows'

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

/** Intervento del revisore su una riga proposta: correzione, rimozione o entrambe. */
interface KeptEngineItem {
  corrected_value_json: string | null
  removed: number
  updated_at: string | null
}

/** Una riga che dopo il nuovo run appartiene al revisore: aggiunta a mano o rimasta orfana. */
interface KeptReviewerItem {
  sortIndex: number
  corrected_value_json: string
  updated_at: string | null
}

interface KeptItems {
  label: string
  semantic_type: string | null
  engine: Map<number, KeptEngineItem>
  manual: KeptReviewerItem[]
}

/**
 * Un campo che passa da un valore solo a più valori (la cardinalità decisa per il tipo è
 * cambiata): la correzione del campo singolo diventa il lavoro sulle righe. Se il motore
 * ripropone il valore che il revisore aveva corretto, la correzione va su quella riga; se
 * l'aveva svuotato, quella riga resta tolta; un valore scritto a mano che il motore non
 * propone diventa una riga del revisore.
 */
function singleToItems(
  kept: KeptCorrection,
  items: FieldItemInput[]
): { engine: Map<number, KeptEngineItem>; manual: KeptReviewerItem[] } {
  const engine = new Map<number, KeptEngineItem>()
  const manual: KeptReviewerItem[] = []
  const proposed = kept.value?.trim() || null
  const corrected = kept.corrected_value.trim()
  const same = (item: FieldItemInput, value: string) => item.value?.trim() === value
  const target = proposed === null ? undefined : items.find((item) => same(item, proposed))

  if (corrected === '') {
    if (target) {
      engine.set(target.itemIndex, {
        corrected_value_json: null,
        removed: 1,
        updated_at: kept.updated_at
      })
    }
  } else if (!items.some((item) => same(item, corrected))) {
    if (target) {
      engine.set(target.itemIndex, {
        corrected_value_json: JSON.stringify(corrected),
        removed: 0,
        updated_at: kept.updated_at
      })
    } else {
      manual.push({
        sortIndex: 0,
        corrected_value_json: JSON.stringify(corrected),
        updated_at: kept.updated_at
      })
    }
  }
  return { engine, manual }
}

/** Separatore dei valori di più righe finiti in un campo che ora ne chiede uno solo. */
const JOINED_ITEMS_SEPARATOR = '; '

/**
 * Il contrario: un campo con più righe che ora chiede un valore solo. Le righe che il
 * revisore aveva lasciato — tolte escluse — diventano la correzione del campo, unite con
 * `; ` se sono più d'una: nessun valore sparisce, e il revisore vede in «Dati» cosa tenere.
 * Se restano uguali a quello che il motore propone adesso, non c'è niente da correggere.
 */
function itemsToSingle(
  rows: PreviousItemRow[],
  proposed: string | null
): { corrected_value: string; updated_at: string | null } | null {
  const values = [...rows]
    .sort((a, b) => a.item_index - b.item_index)
    .filter((row) => row.removed === 0)
    .map((row) => parseItemValue(row.corrected_value_json) ?? parseItemValue(row.value_json))
    .map((value) => value?.trim() ?? '')
    .filter((value) => value !== '')
  const updatedAt =
    rows
      .map((row) => row.updated_at)
      .filter((at): at is string => at !== null)
      .sort()
      .pop() ?? null
  const engine = proposed?.trim() || null

  if (values.length === 0) {
    return engine === null ? null : { corrected_value: '', updated_at: updatedAt }
  }
  const joined = values.join(JOINED_ITEMS_SEPARATOR)
  return joined === engine ? null : { corrected_value: joined, updated_at: updatedAt }
}

type PreviousItemRow = Pick<
  FieldItemRow,
  'item_index' | 'value_json' | 'corrected_value_json' | 'removed' | 'updated_at'
> & { name: string }

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
                             evidence_id, validation_errors_json, updated_at, origin, removed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  /** Le righe del revisore vanno in coda, nell'ordine in cui stavano. */
  function insertReviewerItems(fieldId: string, firstIndex: number, items: KeptReviewerItem[]) {
    let index = firstIndex
    for (const item of [...items].sort((a, b) => a.sortIndex - b.sortIndex)) {
      insertItem.run(
        randomUUID(),
        fieldId,
        index,
        null,
        item.corrected_value_json,
        0,
        null,
        null,
        item.updated_at,
        'MANUAL',
        0
      )
      index += 1
    }
  }

  /** Correzioni su righe proposte che il nuovo run non trova più: ora sono del revisore. */
  function orphanedCorrections(kept: KeptItems | undefined, written: Set<number>) {
    const orphaned: KeptReviewerItem[] = []
    for (const [sortIndex, item] of kept?.engine ?? []) {
      if (written.has(sortIndex) || item.removed === 1 || item.corrected_value_json === null) {
        continue
      }
      orphaned.push({
        sortIndex,
        corrected_value_json: item.corrected_value_json,
        updated_at: item.updated_at
      })
    }
    return orphaned
  }

  return {
    /**
     * Sostituisce i campi di un documento. Le correzioni umane gia` salvate vengono
     * conservate per nome del campo: una ri-estrazione non deve cancellare il lavoro
     * del revisore. Per i campi `many` correzione e rimozione di una riga proposta
     * tornano sullo stesso `item_index`; le righe aggiunte a mano restano in coda a quelle
     * del nuovo run, e una riga corretta che il nuovo run non trova più diventa del
     * revisore invece di sparire.
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
          SELECT f.name, f.label, f.semantic_type, i.item_index, i.origin, i.removed,
                 i.corrected_value_json, i.updated_at
            FROM field_items i JOIN fields f ON f.id = i.field_id
           WHERE f.document_id = ? AND (i.corrected_value_json IS NOT NULL OR i.removed = 1)
        ORDER BY f.name, i.item_index
        `)
        .all(documentId) as Array<
        Pick<FieldRow, 'name' | 'label' | 'semantic_type'> &
          Pick<
            FieldItemRow,
            'item_index' | 'origin' | 'removed' | 'corrected_value_json' | 'updated_at'
          >
      >
      const itemCorrections = new Map<string, KeptItems>()
      for (const row of previousItems) {
        const kept = itemCorrections.get(row.name) ?? {
          label: row.label,
          semantic_type: row.semantic_type,
          engine: new Map<number, KeptEngineItem>(),
          manual: []
        }
        if (row.origin === 'MANUAL') {
          if (row.corrected_value_json !== null && row.removed === 0) {
            kept.manual.push({
              sortIndex: row.item_index,
              corrected_value_json: row.corrected_value_json,
              updated_at: row.updated_at
            })
          }
        } else {
          kept.engine.set(row.item_index, {
            corrected_value_json: row.corrected_value_json,
            removed: row.removed,
            updated_at: row.updated_at
          })
        }
        itemCorrections.set(row.name, kept)
      }

      // Tutte le righe dei campi ripetuti, anche quelle confermate senza toccarle: se il campo
      // ora chiede un valore solo, è l'elenco intero che il revisore aveva davanti.
      const allItems = db
        .prepare(`
          SELECT f.name, i.item_index, i.value_json, i.corrected_value_json, i.removed, i.updated_at
            FROM field_items i JOIN fields f ON f.id = i.field_id
           WHERE f.document_id = ?
        `)
        .all(documentId) as PreviousItemRow[]
      const itemsByName = new Map<string, PreviousItemRow[]>()
      for (const row of allItems) {
        itemsByName.set(row.name, [...(itemsByName.get(row.name) ?? []), row])
      }

      /** Il primo fra il nome e i suoi alias che ha una correzione salvata. */
      const matchName = (source: Map<string, unknown>, name: string): string | undefined =>
        [name, ...(options.correctionAliases?.(name) ?? [])].find((candidate) =>
          source.has(candidate)
        )

      // field_items se ne vanno con i campi (ON DELETE CASCADE).
      db.prepare('DELETE FROM fields WHERE document_id = ?').run(documentId)

      const consumed = new Set<string>()
      const consumedItems = new Set<string>()
      for (const field of fields) {
        const id = randomUUID()
        const many = field.cardinality === 'many'
        const keptName = matchName(corrections, field.name)
        const kept = keptName ? corrections.get(keptName) : undefined
        if (keptName) consumed.add(keptName)

        // Un campo ripetuto che ora chiede un valore solo: le sue righe toccate dal revisore
        // diventano la correzione, a meno che il campo singolo non ne abbia già una.
        let single: { corrected_value: string; updated_at: string | null } | null = kept ?? null
        if (!many && !kept) {
          const itemsName = matchName(itemCorrections, field.name)
          if (itemsName) {
            consumedItems.add(itemsName)
            single = itemsToSingle(itemsByName.get(itemsName) ?? [], field.value)
          }
        }

        insert.run(
          id,
          documentId,
          field.name,
          field.label,
          field.value,
          many ? null : (single?.corrected_value ?? null),
          field.confidence,
          field.evidenceId ?? null,
          many ? null : (single?.updated_at ?? null),
          field.semanticType ?? null,
          field.cardinality ?? null,
          field.reviewStatus ?? null,
          errorsJson(field.validationErrors),
          field.role ?? null
        )

        if (!many) continue
        const itemsName = matchName(itemCorrections, field.name)
        if (itemsName) consumedItems.add(itemsName)
        // Un campo singolo che ora chiede più valori: la sua correzione passa sulle righe.
        const keptItems: KeptItems | undefined = itemsName
          ? itemCorrections.get(itemsName)
          : kept
            ? {
                label: kept.label,
                semantic_type: kept.semantic_type,
                ...singleToItems(kept, field.items ?? [])
              }
            : undefined
        const written = new Set<number>()
        let nextIndex = 0
        for (const item of field.items ?? []) {
          const edit = keptItems?.engine.get(item.itemIndex)
          insertItem.run(
            randomUUID(),
            id,
            item.itemIndex,
            item.value === null ? null : JSON.stringify(item.value),
            edit?.corrected_value_json ?? null,
            item.confidence,
            item.evidenceId ?? null,
            errorsJson(item.validationErrors),
            edit?.updated_at ?? null,
            'ENGINE',
            edit?.removed ?? 0
          )
          written.add(item.itemIndex)
          nextIndex = Math.max(nextIndex, item.itemIndex + 1)
        }
        insertReviewerItems(id, nextIndex, [
          ...orphanedCorrections(keptItems, written),
          ...(keptItems?.manual ?? [])
        ])
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
      // Lo stesso per un campo ripetuto: restano le righe che il revisore ha scritto.
      for (const [name, kept] of itemCorrections) {
        if (consumedItems.has(name)) continue
        const rows = [...orphanedCorrections(kept, new Set()), ...kept.manual]
        if (rows.length === 0) continue
        const id = randomUUID()
        insert.run(
          id,
          documentId,
          name,
          kept.label,
          null,
          null,
          0,
          null,
          null,
          kept.semantic_type,
          'many',
          'NEEDS_REVIEW',
          null,
          'optional'
        )
        insertReviewerItems(id, 0, rows)
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
           WHERE field_id = ? AND removed = 0
             AND COALESCE(corrected_value_json, value_json) IS NOT NULL
        `)
        .get(fieldId) as { c: number }
      return row.c
    },

    /** Tutte le righe dei campi ripetuti di un documento, in una query sola. */
    listItemsForDocument(documentId: string): FieldItemRow[] {
      return db
        .prepare(`
          SELECT i.* FROM field_items i JOIN fields f ON f.id = i.field_id
           WHERE f.document_id = ?
        ORDER BY i.field_id, i.item_index
        `)
        .all(documentId) as FieldItemRow[]
    },

    /** La riga col documento a cui appartiene, per verificare che l'id arrivi dal posto giusto. */
    getItem(itemId: string): (FieldItemRow & { document_id: string }) | undefined {
      return db
        .prepare(
          'SELECT i.*, f.document_id FROM field_items i JOIN fields f ON f.id = i.field_id WHERE i.id = ?'
        )
        .get(itemId) as (FieldItemRow & { document_id: string }) | undefined
    },

    /** Riga scritta dal revisore, in coda alle altre. */
    addItem(fieldId: string, value: string): string {
      const row = db
        .prepare('SELECT MAX(item_index) AS last FROM field_items WHERE field_id = ?')
        .get(fieldId) as { last: number | null }
      const id = randomUUID()
      insertItem.run(
        id,
        fieldId,
        (row.last ?? -1) + 1,
        null,
        JSON.stringify(value),
        0,
        null,
        null,
        new Date().toISOString(),
        'MANUAL',
        0
      )
      return id
    },

    /** Toglie (o rimette) una riga proposta dal motore. La proposta resta a database. */
    setItemRemoved(itemId: string, removed: boolean): void {
      db.prepare('UPDATE field_items SET removed = ?, updated_at = ? WHERE id = ?').run(
        removed ? 1 : 0,
        new Date().toISOString(),
        itemId
      )
    },

    /** Solo per le righe aggiunte a mano: una proposta del motore si toglie, non si cancella. */
    deleteItem(itemId: string): void {
      db.prepare('DELETE FROM field_items WHERE id = ?').run(itemId)
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
