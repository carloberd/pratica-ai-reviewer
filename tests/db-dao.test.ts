import { afterEach, describe, expect, it } from 'vitest'
import { toFtsQuery } from '../src/main/db/dao/search'
import { createTestRepository, seedDocument } from './helpers/db'

let repo: ReturnType<typeof createTestRepository> | null = null

function makeRepo(required?: Record<string, string[]>) {
  repo = createTestRepository(required)
  return repo
}

afterEach(() => {
  repo?.close()
  repo = null
})

describe('documents dao', () => {
  it('dedup per drive_file_id: lo stesso file non crea due documenti', () => {
    const r = makeRepo()
    const first = r.documents.upsertFromDrive({
      driveFileId: 'file-1',
      filename: 'a.pdf',
      mime: 'application/pdf',
      receivedAt: '2026-09-01T10:00:00.000Z'
    })
    const second = r.documents.upsertFromDrive({
      driveFileId: 'file-1',
      filename: 'a-rinominato.pdf',
      mime: 'application/pdf',
      receivedAt: '2026-09-01T10:00:00.000Z'
    })

    expect(first.isNew).toBe(true)
    expect(second.isNew).toBe(false)
    expect(second.id).toBe(first.id)
    expect(r.documents.get(first.id)?.filename).toBe('a-rinominato.pdf')
    expect(r.documents.list()).toHaveLength(1)
  })

  it('segnala stale solo quando Drive riporta un modifiedTime più recente', () => {
    const r = makeRepo()
    r.documents.upsertFromDrive({
      driveFileId: 'file-1',
      filename: 'a.pdf',
      mime: 'application/pdf',
      receivedAt: '2026-09-01T10:00:00.000Z'
    })
    const same = r.documents.upsertFromDrive({
      driveFileId: 'file-1',
      filename: 'a.pdf',
      mime: 'application/pdf',
      receivedAt: '2026-09-01T10:00:00.000Z'
    })
    const newer = r.documents.upsertFromDrive({
      driveFileId: 'file-1',
      filename: 'a.pdf',
      mime: 'application/pdf',
      receivedAt: '2026-09-05T10:00:00.000Z'
    })

    expect(same.isStale).toBe(false)
    expect(newer.isStale).toBe(true)
  })

  it('filtra per stato, tipo e banda', () => {
    const r = makeRepo()
    const a = seedDocument(r, { driveFileId: 'a', filename: 'a.pdf' })
    const b = seedDocument(r, { driveFileId: 'b', filename: 'b.pdf' })
    const c = seedDocument(r, { driveFileId: 'c', filename: 'c.pdf' })

    r.documents.setExtraction(a, {
      documentType: 'accounting.fattura',
      typeConfidence: 0.9,
      confidence: 0.95,
      confidenceBand: 'HIGH',
      textSource: 'NATIVE_TEXT'
    })
    r.documents.setExtraction(b, {
      documentType: 'accounting.fattura',
      typeConfidence: 0.9,
      confidence: 0.6,
      confidenceBand: 'LOW',
      textSource: 'OCR'
    })
    r.documents.setStatus(c, 'REVIEWED')

    expect(r.documents.list({ status: 'REVIEWED' }).map((d) => d.id)).toEqual([c])
    expect(r.documents.list({ documentType: 'accounting.fattura' })).toHaveLength(2)
    expect(r.documents.list({ documentType: '__none__' }).map((d) => d.id)).toEqual([c])
    expect(r.documents.list({ band: 'HIGH' }).map((d) => d.id)).toEqual([a])
    // Un documento senza banda calcolata conta come LOW.
    expect(
      r.documents
        .list({ band: 'LOW' })
        .map((d) => d.id)
        .sort()
    ).toEqual([b, c].sort())
  })

  it('ordina dal più recente su Drive', () => {
    const r = makeRepo()
    seedDocument(r, {
      driveFileId: 'vecchio',
      filename: 'vecchio.pdf',
      receivedAt: '2026-01-01T00:00:00.000Z'
    })
    seedDocument(r, {
      driveFileId: 'nuovo',
      filename: 'nuovo.pdf',
      receivedAt: '2026-09-01T00:00:00.000Z'
    })
    expect(r.documents.list().map((d) => d.filename)).toEqual(['nuovo.pdf', 'vecchio.pdf'])
  })

  it('conta i KPI della dashboard', () => {
    const r = makeRepo()
    const a = seedDocument(r, { driveFileId: 'a' })
    const b = seedDocument(r, { driveFileId: 'b' })
    r.documents.setExtraction(a, {
      documentType: 'accounting.fattura',
      typeConfidence: 0.9,
      confidence: 0.95,
      confidenceBand: 'HIGH',
      textSource: 'NATIVE_TEXT'
    })
    r.documents.setStatus(b, 'REVIEWED')

    expect(r.documents.counts()).toEqual({
      total: 2,
      needsReview: 1,
      lowConfidence: 1,
      untyped: 1
    })
    expect(r.kpis().map((k) => k.value)).toEqual([2, 1, 1, 1])
  })
})

describe('fields ed evidence dao', () => {
  it('collega i campi alle evidenze e li restituisce nel documento completo', () => {
    const r = makeRepo({ 'accounting.fattura': ['document_number', 'issue_date'] })
    const id = seedDocument(r)
    const [evidenceId] = r.evidence.replaceForDocument(id, [
      {
        page: 1,
        text: 'Fattura n. 114/2026',
        confidence: 0.85,
        bbox: { x: 10, y: 20, w: 120, h: 14 }
      }
    ])
    r.fields.replaceForDocument(id, [
      {
        name: 'document_number',
        label: 'Numero documento',
        value: '114/2026',
        confidence: 0.85,
        evidenceId
      },
      { name: 'issue_date', label: 'Data di emissione', value: null, confidence: 0 }
    ])
    r.documents.setExtraction(id, {
      documentType: 'accounting.fattura',
      typeConfidence: 0.9,
      confidence: 0.85,
      confidenceBand: 'MEDIUM',
      textSource: 'NATIVE_TEXT'
    })

    const doc = r.getReviewDocument(id)!
    expect(doc.fields.map((f) => f.name)).toEqual(['document_number', 'issue_date'])
    expect(doc.fields[0]?.evidenceId).toBe(evidenceId)
    expect(doc.fields[0]?.required).toBe(true)
    expect(doc.fields[0]?.semanticType).toBe('string')
    expect(doc.fields[1]?.semanticType).toBe('date')
    expect(doc.evidence[0]?.label).toBe('Numero documento')
    expect(doc.evidence[0]?.bbox).toEqual({ x: 10, y: 20, w: 120, h: 14 })
    expect(doc.warnings).toContain('Campo obbligatorio senza evidenza: Data di emissione.')
  })

  it('una correzione umana sopravvive alla ri-estrazione', () => {
    const r = makeRepo()
    const id = seedDocument(r)
    r.fields.replaceForDocument(id, [
      { name: 'issuer_name', label: 'Emittente', value: 'ALFA SRL', confidence: 0.7 }
    ])
    const field = r.fields.listForDocument(id)[0]!
    r.fields.setCorrectedValue(field.id, 'Alfa S.r.l.')

    r.fields.replaceForDocument(id, [
      { name: 'issuer_name', label: 'Emittente', value: 'ALFA S.R.L.', confidence: 0.85 }
    ])

    const after = r.fields.listForDocument(id)[0]!
    expect(after.value).toBe('ALFA S.R.L.')
    expect(after.corrected_value).toBe('Alfa S.r.l.')
    expect(after.id).not.toBe(field.id)
  })

  it('azzerare la correzione riporta il campo al valore precompilato', () => {
    const r = makeRepo()
    const id = seedDocument(r)
    r.fields.replaceForDocument(id, [
      { name: 'issuer_name', label: 'Emittente', value: 'ALFA SRL', confidence: 0.7 }
    ])
    const field = r.fields.listForDocument(id)[0]!
    r.fields.setCorrectedValue(field.id, 'Alfa S.r.l.')
    r.fields.setCorrectedValue(field.id, null)

    const after = r.fields.get(field.id)!
    expect(after.corrected_value).toBeNull()
    expect(after.updated_at).toBeNull()
    expect(after.value).toBe('ALFA SRL')
  })

  it('sostituire le evidenze non lascia campi che puntano nel vuoto', () => {
    const r = makeRepo()
    const id = seedDocument(r)
    const [evidenceId] = r.evidence.replaceForDocument(id, [
      { page: 1, text: 'primo', confidence: 0.8 }
    ])
    r.fields.replaceForDocument(id, [
      { name: 'amount', label: 'Importo', value: '10.00', confidence: 0.8, evidenceId }
    ])

    r.evidence.replaceForDocument(id, [{ page: 2, text: 'secondo', confidence: 0.8 }])

    expect(r.fields.listForDocument(id)[0]?.evidence_id).toBeNull()
    expect(r.evidence.listForDocument(id)).toHaveLength(1)
  })

  it('ricalcola confidence e banda come media dei campi valorizzati', () => {
    const r = makeRepo()
    const id = seedDocument(r)
    r.fields.replaceForDocument(id, [
      { name: 'amount', label: 'Importo', value: '10.00', confidence: 0.9 },
      { name: 'currency', label: 'Valuta', value: 'EUR', confidence: 0.8 },
      { name: 'issue_date', label: 'Data di emissione', value: null, confidence: 0 }
    ])
    r.recomputeConfidence(id)

    const row = r.documents.get(id)!
    expect(row.confidence).toBeCloseTo(0.85, 4)
    expect(row.confidence_band).toBe('MEDIUM')
  })
})

describe('campi v2: metadati, elementi ripetuti, correzioni fra motori', () => {
  it('persiste ruolo, tipo, cardinalità, stato di revisione ed errori', () => {
    // Lo stub del registry dice «issue_date»: per i campi v2 decide il ruolo salvato.
    const r = makeRepo()
    const id = seedDocument(r)
    r.fields.replaceForDocument(id, [
      {
        name: 'document.issue_date',
        label: 'Data emissione',
        value: '2026-09-08',
        confidence: 0.85,
        semanticType: 'date',
        role: 'required',
        cardinality: 'one',
        reviewStatus: 'AUTO_ACCEPTED',
        validationErrors: []
      },
      {
        name: 'bank.iban',
        label: 'IBAN',
        value: 'IT00X',
        confidence: 0.67,
        semanticType: 'identifier',
        role: 'optional',
        reviewStatus: 'NEEDS_REVIEW',
        validationErrors: ['INVALID_IBAN']
      },
      {
        name: 'money.total',
        label: 'Totale',
        value: null,
        confidence: 0,
        semanticType: 'money',
        role: 'required',
        reviewStatus: 'MISSING'
      }
    ])

    const [date, iban, total] = r.fields.listForDocument(id)
    expect(date).toMatchObject({ semantic_type: 'date', role: 'required', cardinality: 'one' })
    expect(date?.validation_errors_json).toBeNull()
    expect(iban).toMatchObject({ review_status: 'NEEDS_REVIEW', cardinality: 'one' })
    expect(JSON.parse(iban!.validation_errors_json!)).toEqual(['INVALID_IBAN'])

    const doc = r.getReviewDocument(id)!
    expect(doc.fields.map((f) => [f.name, f.required, f.semanticType])).toEqual([
      ['document.issue_date', true, 'date'],
      ['bank.iban', false, 'string'],
      ['money.total', true, 'money']
    ])
    expect(total?.review_status).toBe('MISSING')
    expect(doc.warnings).toContain('Campo obbligatorio senza evidenza: Totale.')
  })

  it('le righe del motore v1 lasciano vuote le colonne nuove', () => {
    const r = makeRepo()
    const id = seedDocument(r)
    r.fields.replaceForDocument(id, [
      { name: 'issue_date', label: 'Data di emissione', value: '2026-09-08', confidence: 0.85 }
    ])
    expect(r.fields.listForDocument(id)[0]).toMatchObject({
      semantic_type: null,
      role: null,
      review_status: null,
      validation_errors_json: null,
      cardinality: 'one'
    })
  })

  it('scrive gli elementi di un campo many con le loro evidenze', () => {
    const r = makeRepo()
    const id = seedDocument(r)
    const [first, second] = r.evidence.replaceForDocument(id, [
      { id: 'ev-1', page: 1, text: 'Garanzia: Incendio', confidence: 0.85 },
      { id: 'ev-2', page: 1, text: 'Garanzia: Furto', confidence: 0.85 }
    ])
    r.fields.replaceForDocument(id, [
      {
        name: 'insurance.coverages',
        label: 'Garanzie',
        value: null,
        confidence: 0.85,
        evidenceId: first,
        cardinality: 'many',
        role: 'required',
        items: [
          { itemIndex: 0, value: 'Incendio', confidence: 0.85, evidenceId: first },
          { itemIndex: 1, value: 'Furto', confidence: 0.85, evidenceId: second }
        ]
      }
    ])

    const field = r.fields.listForDocument(id)[0]!
    const items = r.fields.listItems(field.id)
    expect(items.map((item) => [item.item_index, item.value_json, item.evidence_id])).toEqual([
      [0, '"Incendio"', 'ev-1'],
      [1, '"Furto"', 'ev-2']
    ])
    // Un campo many obbligatorio con elementi non è «senza evidenza».
    expect(r.getReviewDocument(id)!.warnings.filter((w) => w.includes('obbligator'))).toEqual([])

    // Senza elementi invece sì.
    r.fields.replaceForDocument(id, [
      {
        name: 'insurance.coverages',
        label: 'Garanzie',
        value: null,
        confidence: 0,
        cardinality: 'many',
        role: 'required',
        items: []
      }
    ])
    expect(r.getReviewDocument(id)!.warnings).toContain(
      'Campo obbligatorio senza evidenza: Garanzie.'
    )
  })

  it('la correzione di un elemento torna sullo stesso item_index, anche se il run ne trova meno', () => {
    const r = makeRepo()
    const id = seedDocument(r)
    const many = (values: string[]) => [
      {
        name: 'line_items',
        label: 'Righe documento',
        value: null,
        confidence: 0.85,
        cardinality: 'many' as const,
        items: values.map((value, itemIndex) => ({ itemIndex, value, confidence: 0.85 }))
      }
    ]
    r.fields.replaceForDocument(id, many(['riga A', 'riga B', 'riga C']))
    const [, second, third] = r.fields.listItems(r.fields.listForDocument(id)[0]!.id)
    r.fields.setItemCorrectedValue(second!.id, 'riga B corretta')
    r.fields.setItemCorrectedValue(third!.id, 'riga C corretta')

    r.fields.replaceForDocument(id, many(['riga A', 'riga B bis']))

    const items = r.fields.listItems(r.fields.listForDocument(id)[0]!.id)
    expect(
      items.map((item) => [item.item_index, item.value_json, item.corrected_value_json])
    ).toEqual([
      [0, '"riga A"', null],
      [1, '"riga B bis"', '"riga B corretta"'],
      [2, null, '"riga C corretta"']
    ])
    expect(items[1]?.updated_at).toBeTruthy()

    r.fields.setItemCorrectedValue(items[1]!.id, null)
    expect(r.fields.listItems(items[1]!.field_id)[1]).toMatchObject({
      corrected_value_json: null,
      updated_at: null
    })
  })

  it('sostituire le evidenze non lascia elementi che puntano nel vuoto', () => {
    const r = makeRepo()
    const id = seedDocument(r)
    const [evidenceId] = r.evidence.replaceForDocument(id, [
      { page: 1, text: 'Rata 1: 100,00', confidence: 0.85 }
    ])
    r.fields.replaceForDocument(id, [
      {
        name: 'finance.installments',
        label: 'Rate',
        value: null,
        confidence: 0.85,
        evidenceId,
        cardinality: 'many',
        items: [{ itemIndex: 0, value: '100,00', confidence: 0.85, evidenceId }]
      }
    ])

    expect(() =>
      r.evidence.replaceForDocument(id, [{ page: 1, text: 'altro', confidence: 0.8 }])
    ).not.toThrow()
    expect(r.fields.listItems(r.fields.listForDocument(id)[0]!.id)[0]?.evidence_id).toBeNull()
  })

  it('ritrova una correzione salvata con l’altro nome del campo', () => {
    const r = makeRepo()
    const id = seedDocument(r)
    const aliases = (name: string) =>
      name === 'document.number'
        ? ['document_number']
        : name === 'document_number'
          ? ['document.number']
          : []

    r.fields.replaceForDocument(id, [
      { name: 'document_number', label: 'Numero documento', value: '114', confidence: 0.85 }
    ])
    r.fields.setCorrectedValue(r.fields.listForDocument(id)[0]!.id, '114/2026')

    r.fields.replaceForDocument(
      id,
      [{ name: 'document.number', label: 'Numero documento', value: '114', confidence: 0.85 }],
      { correctionAliases: aliases }
    )
    expect(r.fields.listForDocument(id)[0]).toMatchObject({
      name: 'document.number',
      corrected_value: '114/2026'
    })

    // E all'indietro, tornando al motore v1.
    r.fields.replaceForDocument(
      id,
      [{ name: 'document_number', label: 'Numero documento', value: '114', confidence: 0.85 }],
      { correctionAliases: aliases }
    )
    expect(r.fields.listForDocument(id)[0]?.corrected_value).toBe('114/2026')
  })

  it('su richiesta conserva una correzione su un campo che il nuovo run non produce', () => {
    const r = makeRepo()
    const id = seedDocument(r)
    const seedCorrection = () => {
      r.fields.replaceForDocument(id, [
        { name: 'tax_code', label: 'Codice fiscale', value: '0123', confidence: 0.7 },
        { name: 'issue_date', label: 'Data', value: null, confidence: 0 }
      ])
      r.fields.setCorrectedValue(r.fields.listForDocument(id)[0]!.id, '01234567890')
    }

    seedCorrection()
    r.fields.replaceForDocument(id, [], { keepUnmatchedCorrections: true })
    expect(r.fields.listForDocument(id)).toMatchObject([
      {
        name: 'tax_code',
        label: 'Codice fiscale',
        value: '0123',
        corrected_value: '01234567890',
        evidence_id: null,
        review_status: 'NEEDS_REVIEW',
        role: 'optional'
      }
    ])

    // Senza l'opzione vale il comportamento di sempre.
    seedCorrection()
    r.fields.replaceForDocument(id, [])
    expect(r.fields.listForDocument(id)).toEqual([])
  })
})

describe('extraction runs dao', () => {
  it('accumula i run dal più recente e riconosce motore e profili già usati', () => {
    const r = makeRepo()
    const id = seedDocument(r)
    const base = {
      engineVersion: 'extraction-brain-v2/test',
      schemaVersion: '2.0.0',
      documentType: 'accounting.fattura',
      completedAt: '2026-09-16T10:00:01.000Z',
      status: 'COMPLETED' as const,
      missingRequired: ['money.total'],
      conflicts: [],
      metrics: { coverage: 0.5 }
    }
    r.extractionRuns.add(id, { ...base, startedAt: '2026-09-16T10:00:00.000Z' })
    r.extractionRuns.add(id, {
      ...base,
      startedAt: '2026-09-16T11:00:00.000Z',
      status: 'SKIPPED_UNKNOWN_TYPE',
      documentType: ''
    })

    const runs = r.extractionRuns.listForDocument(id)
    expect(runs.map((run) => run.status)).toEqual(['SKIPPED_UNKNOWN_TYPE', 'COMPLETED'])
    expect(JSON.parse(runs[1]!.missing_required_json!)).toEqual(['money.total'])
    expect(JSON.parse(runs[1]!.metrics_json!)).toEqual({ coverage: 0.5 })

    expect(r.extractionRuns.hasRun(id, 'extraction-brain-v2/test', '2.0.0')).toBe(true)
    expect(r.extractionRuns.hasRun(id, 'extraction-brain-v2/test', '2.1.0')).toBe(false)
    expect(r.extractionRuns.hasRun(id, 'altro', '2.0.0')).toBe(false)
  })

  it('i run spariscono col documento', () => {
    const r = makeRepo()
    const id = seedDocument(r)
    r.extractionRuns.add(id, {
      engineVersion: 'v2',
      schemaVersion: '2.0.0',
      documentType: '',
      startedAt: '2026-09-16T10:00:00.000Z',
      completedAt: '2026-09-16T10:00:00.000Z',
      status: 'SKIPPED_UNKNOWN_TYPE',
      missingRequired: [],
      conflicts: [],
      metrics: {}
    })
    r.documents.delete(id)
    expect(r.extractionRuns.listForDocument(id)).toEqual([])
  })
})

describe('events dao', () => {
  it('costruisce la timeline in ordine cronologico', () => {
    const r = makeRepo()
    const id = seedDocument(r)
    r.events.add(id, 'Documento sincronizzato', 'Scaricato da Drive.', '2026-09-08T10:00:00.000Z')
    r.events.add(id, 'Tipo riconosciuto', 'accounting.fattura (90%)', '2026-09-08T10:00:05.000Z')

    const doc = r.getReviewDocument(id)!
    expect(doc.timeline.map((t) => t.title)).toEqual([
      'Documento sincronizzato',
      'Tipo riconosciuto'
    ])
  })
})

describe('ricerca FTS5', () => {
  it('normalizza la query dell utente in un espressione FTS valida', () => {
    expect(toFtsQuery('fattura 2026')).toBe('"fattura"* AND "2026"*')
    expect(toFtsQuery('  ')).toBeNull()
    // I token di un solo carattere sono rumore in una prefix query e vengono scartati.
    expect(toFtsQuery('a')).toBeNull()
    // I caratteri con significato sintattico in FTS5 non devono passare grezzi.
    expect(toFtsQuery('NEAR("importo" -iva)*')).toBe('"near"* AND "importo"* AND "iva"*')
  })

  it('trova i documenti per testo di pagina e per filename', () => {
    const r = makeRepo()
    const a = seedDocument(r, { driveFileId: 'a', filename: 'Fattura 114.pdf' })
    const b = seedDocument(r, { driveFileId: 'b', filename: 'DURC.pdf' })
    r.search.replaceForDocument(a, 'Fattura 114.pdf', [
      { page: 1, text: 'Fattura n. 114/2026 emessa da Alfa S.r.l.' },
      { page: 2, text: 'Totale documento 86.420,00 euro' }
    ])
    r.search.replaceForDocument(b, 'DURC.pdf', [
      { page: 1, text: 'Documento unico di regolarità contributiva' }
    ])

    expect(r.search.matchingDocumentIds('alfa')).toEqual([a])
    expect(r.search.matchingDocumentIds('durc')).toEqual([b])
    expect(r.search.matchingDocumentIds('contributiva')).toEqual([b])
    expect(r.search.matchingDocumentIds('inesistente')).toEqual([])

    const hits = r.search.query('86.420')
    expect(hits[0]?.documentId).toBe(a)
    expect(hits[0]?.page).toBe(2)
    expect(hits[0]?.snippet).toContain('[86]')
  })

  it('il filtro di ricerca restringe la lista dei documenti', () => {
    const r = makeRepo()
    const a = seedDocument(r, { driveFileId: 'a', filename: 'Fattura 114.pdf' })
    seedDocument(r, { driveFileId: 'b', filename: 'DURC.pdf' })
    r.search.replaceForDocument(a, 'Fattura 114.pdf', [{ page: 1, text: 'Alfa S.r.l.' }])

    expect(r.listSummaries({ query: 'alfa' }).map((d) => d.id)).toEqual([a])
    expect(r.listSummaries({ query: 'zzzz' })).toEqual([])
    expect(r.listSummaries()).toHaveLength(2)
  })

  it('reindicizzare un documento sostituisce le righe, non le somma', () => {
    const r = makeRepo()
    const id = seedDocument(r)
    r.search.replaceForDocument(id, 'a.pdf', [{ page: 1, text: 'primo testo' }])
    r.search.replaceForDocument(id, 'a.pdf', [{ page: 1, text: 'secondo testo' }])

    expect(r.search.matchingDocumentIds('primo')).toEqual([])
    expect(r.search.matchingDocumentIds('secondo')).toEqual([id])
  })
})

describe('transazioni', () => {
  it('un errore a metà lavoro non lascia scritture parziali', () => {
    const r = makeRepo()
    const id = seedDocument(r)

    expect(() =>
      r.transaction(() => {
        r.fields.replaceForDocument(id, [
          { name: 'amount', label: 'Importo', value: '10.00', confidence: 0.9 }
        ])
        r.events.add(id, 'Campi precompilati', '1 campo')
        throw new Error('estrazione fallita')
      })
    ).toThrow('estrazione fallita')

    expect(r.fields.listForDocument(id)).toHaveLength(0)
    expect(r.events.listForDocument(id)).toHaveLength(0)
  })
})
