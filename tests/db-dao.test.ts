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
    r.documents.setStatus(c, 'APPROVED')

    expect(r.documents.list({ status: 'APPROVED' }).map((d) => d.id)).toEqual([c])
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
    r.documents.setStatus(b, 'APPROVED')

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
