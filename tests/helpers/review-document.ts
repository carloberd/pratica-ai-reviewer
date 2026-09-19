import type { ExtractedField, FieldItem, ReviewDocument } from '../../src/shared/types'

/** Campo singolo con i default di un campo v2 compilato dal motore. */
export function scalarField(overrides: Partial<ExtractedField> = {}): ExtractedField {
  return {
    id: 'f-number',
    name: 'document.number',
    label: 'Numero documento',
    value: '114/2026',
    confidence: 0.85,
    required: true,
    semanticType: 'string',
    cardinality: 'one',
    role: 'required',
    reviewStatus: 'AUTO_ACCEPTED',
    items: [],
    ...overrides
  }
}

export function item(overrides: Partial<FieldItem> = {}): FieldItem {
  return {
    id: 'i0',
    index: 0,
    value: 'Fornitura materiali edili',
    confidence: 0.85,
    origin: 'ENGINE',
    removed: false,
    ...overrides
  }
}

export function listField(items: FieldItem[], overrides: Partial<ExtractedField> = {}) {
  return scalarField({
    id: 'f-lines',
    name: 'line_items',
    label: 'Righe documento',
    value: '',
    confidence: 0.85,
    required: false,
    cardinality: 'many',
    role: 'core',
    reviewStatus: 'NEEDS_REVIEW',
    items,
    ...overrides
  })
}

export function reviewDocument(overrides: Partial<ReviewDocument> = {}): ReviewDocument {
  return {
    id: 'doc-1',
    driveFileId: 'drive-1',
    filename: 'Fattura 114.pdf',
    mime: 'application/pdf',
    documentType: 'accounting.fattura',
    documentTypeLabel: 'Fattura',
    typeConfidence: 0.83,
    status: 'NEEDS_REVIEW',
    confidence: 0.85,
    confidenceBand: 'MEDIUM',
    receivedAt: '2026-09-08T10:00:00.000Z',
    syncedAt: '2026-09-10T08:00:00.000Z',
    source: 'Google Drive',
    textSource: 'NATIVE_TEXT',
    cachedPath: null,
    contentSha256: null,
    warnings: [],
    fields: [],
    evidence: [],
    timeline: [],
    classification: null,
    reviewedAt: null,
    reviewNote: null,
    directionChoice: null,
    ...overrides
  }
}
