import { bandOf } from '@shared/confidence'
import { UNIVERSAL_FIELDS } from '@shared/fields'
import type {
  DashboardKpi,
  DocumentFilters,
  ReviewDocument,
  ReviewDocumentSummary
} from '@shared/types'
import { createDocumentsDao } from './dao/documents'
import { createEventsDao } from './dao/events'
import { createEvidenceDao } from './dao/evidence'
import { createExtractionRunsDao } from './dao/extraction-runs'
import { createFieldsDao } from './dao/fields'
import { createSearchDao } from './dao/search'
import type { Db } from './index'
import {
  type DocumentRow,
  type FieldItemRow,
  type FieldRow,
  parseClassification,
  toBand,
  toEvidenceItem,
  toExtractedField,
  toStatus,
  toTextSource,
  toTimelineItem
} from './rows'

export interface RepositoryDeps {
  /** Campi `required` dello schema del tipo. In F1 e nei test è uno stub. */
  requiredFields?: (documentType: string | null) => string[]
  /** Nome leggibile del tipo (`canonical_name` del registry). */
  typeLabel?: (documentType: string | null) => string | null
}

export function createRepository(db: Db, deps: RepositoryDeps = {}) {
  const documents = createDocumentsDao(db)
  const fields = createFieldsDao(db)
  const evidence = createEvidenceDao(db)
  const events = createEventsDao(db)
  const search = createSearchDao(db)
  const extractionRuns = createExtractionRunsDao(db)

  const requiredFields = deps.requiredFields ?? (() => [...UNIVERSAL_FIELDS])
  const typeLabel = deps.typeLabel ?? (() => null)

  function warningsFor(row: DocumentRow, missingRequired: FieldRow[]): string[] {
    const warnings: string[] = []
    if (!row.document_type) {
      warnings.push('Tipo da assegnare a mano: nessun alias del registry supera la soglia.')
    }
    if (row.text_source === 'OCR') {
      warnings.push('Testo ricavato da OCR: la confidence dei campi è ridotta di 0,10.')
    }
    if (missingRequired.length > 0) {
      const labels = missingRequired.map((field) => field.label).join(', ')
      warnings.push(
        missingRequired.length === 1
          ? `Campo obbligatorio senza evidenza: ${labels}.`
          : `Campi obbligatori senza evidenza: ${labels}.`
      )
    }
    return warnings
  }

  /**
   * Un campo scritto dal motore v2 porta il proprio ruolo; per le righe v1 decide lo
   * schema del registry, come prima.
   */
  function isRequired(field: FieldRow, requiredByRegistry: Set<string>): boolean {
    return field.role ? field.role === 'required' : requiredByRegistry.has(field.name)
  }

  function isFilled(field: FieldRow): boolean {
    if (field.cardinality === 'many') return fields.countFilledItems(field.id) > 0
    return Boolean(field.corrected_value ?? field.value)
  }

  function missingRequiredOf(fieldRows: FieldRow[], documentType: string | null): FieldRow[] {
    const required = new Set(requiredFields(documentType))
    return fieldRows.filter((field) => isRequired(field, required) && !isFilled(field))
  }

  function summaryOf(row: DocumentRow): ReviewDocumentSummary {
    const missing = missingRequiredOf(fields.listForDocument(row.id), row.document_type)

    return {
      id: row.id,
      driveFileId: row.drive_file_id,
      filename: row.filename,
      mime: row.mime,
      documentType: row.document_type,
      documentTypeLabel: typeLabel(row.document_type),
      status: toStatus(row.status),
      confidence: row.confidence ?? 0,
      confidenceBand: toBand(row.confidence_band),
      receivedAt: row.received_at,
      textSource: toTextSource(row.text_source),
      warnings: warningsFor(row, missing)
    }
  }

  return {
    /**
     * Unità di lavoro: F3 scrive tipo, campi, evidenze, righe FTS ed eventi di un
     * documento tutti dentro la stessa transazione.
     */
    transaction<T>(work: () => T): T {
      return db.transaction(work)()
    },

    documents,
    fields,
    evidence,
    events,
    search,
    extractionRuns,

    listSummaries(filters: DocumentFilters = {}): ReviewDocumentSummary[] {
      const ftsIds = filters.query?.trim()
        ? search.matchingDocumentIds(filters.query.trim())
        : undefined
      return documents.list(filters, ftsIds).map(summaryOf)
    },

    /** Documento completo per la vista di revisione: campi, evidenze e timeline. */
    getReviewDocument(id: string): ReviewDocument | undefined {
      const row = documents.get(id)
      if (!row) return undefined

      const fieldRows = fields.listForDocument(id)
      const required = new Set(requiredFields(row.document_type))
      const itemsByField = new Map<string, FieldItemRow[]>()
      for (const item of fields.listItemsForDocument(id)) {
        itemsByField.set(item.field_id, [...(itemsByField.get(item.field_id) ?? []), item])
      }

      // L'etichetta di un'evidenza è quella del campo che la cita: nello schema del
      // task la tabella `evidence` non ha una colonna label. Le righe dei campi ripetuti
      // hanno ciascuna la sua.
      const labelByEvidence = new Map<string, string>()
      for (const field of fieldRows) {
        for (const item of itemsByField.get(field.id) ?? []) {
          if (item.evidence_id && !labelByEvidence.has(item.evidence_id)) {
            labelByEvidence.set(item.evidence_id, `${field.label} · riga ${item.item_index + 1}`)
          }
        }
        if (field.evidence_id && !labelByEvidence.has(field.evidence_id)) {
          labelByEvidence.set(field.evidence_id, field.label)
        }
      }

      const missing = missingRequiredOf(fieldRows, row.document_type)

      return {
        id: row.id,
        driveFileId: row.drive_file_id,
        filename: row.filename,
        mime: row.mime,
        documentType: row.document_type,
        documentTypeLabel: typeLabel(row.document_type),
        typeConfidence: row.type_confidence,
        status: toStatus(row.status),
        confidence: row.confidence ?? 0,
        confidenceBand: toBand(row.confidence_band),
        receivedAt: row.received_at,
        syncedAt: row.synced_at,
        source: 'Google Drive',
        textSource: toTextSource(row.text_source),
        cachedPath: row.cached_path,
        warnings: warningsFor(row, missing),
        fields: fieldRows.map((field) =>
          toExtractedField(field, isRequired(field, required), itemsByField.get(field.id))
        ),
        evidence: evidence
          .listForDocument(id)
          .map((item) => toEvidenceItem(item, labelByEvidence.get(item.id) ?? 'Evidenza')),
        timeline: events.listForDocument(id).map(toTimelineItem),
        classification: parseClassification(row.classification_json, typeLabel),
        reviewedAt: row.reviewed_at
      }
    },

    /** Ricalcola confidence e banda del documento come media dei campi valorizzati. */
    recomputeConfidence(documentId: string): void {
      const rows = fields.listForDocument(documentId).filter((field) => field.value)
      const average =
        rows.length === 0
          ? 0
          : Math.round((rows.reduce((sum, f) => sum + f.confidence, 0) / rows.length) * 1e4) / 1e4
      documents.setConfidence(documentId, average, bandOf(average))
    },

    kpis(): DashboardKpi[] {
      const counts = documents.counts()
      return [
        {
          id: 'documents',
          label: 'Totale documenti',
          value: counts.total,
          hint: 'sincronizzati da Google Drive'
        },
        {
          id: 'review',
          label: 'Da revisionare',
          value: counts.needsReview,
          hint: 'in attesa di controllo umano'
        },
        {
          id: 'low',
          label: 'Confidence bassa',
          value: counts.lowConfidence,
          hint: 'sotto la soglia del 75%'
        },
        {
          id: 'untyped',
          label: 'Tipi da assegnare',
          value: counts.untyped,
          hint: 'nessun match nel registry'
        }
      ]
    }
  }
}

export type Repository = ReturnType<typeof createRepository>
