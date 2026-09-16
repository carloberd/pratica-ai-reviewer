import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Db, migrate, openDatabase } from '../src/main/db'
import { MIGRATIONS } from '../src/main/db/migrations'
import { databaseAt } from './helpers/db'
import { REGISTRY_V2_DIR, testLegacyFieldMap } from './helpers/registry'

describe('migrazioni', () => {
  it('carica i file .sql numerati in ordine', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0)
    expect(MIGRATIONS[0]?.version).toBe('0001')
    const versions = MIGRATIONS.map((m) => m.version)
    expect([...versions].sort()).toEqual(versions)
  })

  it('crea tutte le tabelle dello schema v1', () => {
    const db = openDatabase({ file: ':memory:' })
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)

    for (const table of [
      'documents',
      'fields',
      'evidence',
      'events',
      'documents_fts',
      'schema_migrations'
    ]) {
      expect(names).toContain(table)
    }
    // La 0002 la elimina: nessuna schermata sa più mostrarne il contenuto.
    expect(names).not.toContain('annotations')
    db.close()
  })

  it('è idempotente: una seconda esecuzione non applica nulla', () => {
    const db = openDatabase({ file: ':memory:' })
    expect(migrate(db)).toEqual([])
    const journal = db.prepare('SELECT version FROM schema_migrations').all()
    expect(journal).toHaveLength(MIGRATIONS.length)
    db.close()
  })

  it('la 0003 porta i vecchi stati sul vocabolario del dataset', () => {
    const db = openDatabase({ file: ':memory:' })
    const insert = db.prepare(
      'INSERT INTO documents (id, drive_file_id, filename, mime, status, synced_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    insert.run('a', 'x1', 'a.pdf', 'application/pdf', 'APPROVED', '2026-01-01')
    insert.run('b', 'x2', 'b.pdf', 'application/pdf', 'REJECTED', '2026-01-01')
    insert.run('c', 'x3', 'c.pdf', 'application/pdf', 'NEEDS_REVIEW', '2026-01-01')

    // Le righe sono state inserite dopo la migrazione: la si rigioca come su un db
    // già installato, dove gli stati vecchi ci sono davvero.
    db.prepare("DELETE FROM schema_migrations WHERE version = '0003'").run()
    expect(migrate(db)).toEqual(['0003'])

    const status = (id: string) =>
      (db.prepare('SELECT status FROM documents WHERE id = ?').get(id) as { status: string }).status
    expect(status('a')).toBe('REVIEWED')
    expect(status('b')).toBe('DISCARDED')
    expect(status('c')).toBe('NEEDS_REVIEW')
    db.close()
  })

  it('applica le pragma attese', () => {
    const db = openDatabase({ file: ':memory:' })
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    db.close()
  })

  it('cancellando un documento spariscono campi, evidenze ed eventi', () => {
    const db = openDatabase({ file: ':memory:' })
    db.prepare(
      "INSERT INTO documents (id, drive_file_id, filename, mime, synced_at) VALUES ('d', 'x', 'f.pdf', 'application/pdf', '2026-01-01')"
    ).run()
    db.prepare(
      "INSERT INTO evidence (id, document_id, page, text, confidence) VALUES ('e', 'd', 1, 'testo', 0.9)"
    ).run()
    db.prepare(
      "INSERT INTO fields (id, document_id, name, label, confidence) VALUES ('f', 'd', 'issue_date', 'Data', 0.9)"
    ).run()
    db.prepare(
      "INSERT INTO events (id, document_id, at, title, detail) VALUES ('v', 'd', '2026', 't', 'd')"
    ).run()
    db.prepare(
      "INSERT INTO documents_fts (document_id, filename, page, page_text) VALUES ('d', 'f.pdf', '1', 'testo')"
    ).run()

    db.prepare("DELETE FROM documents WHERE id = 'd'").run()

    for (const table of ['fields', 'evidence', 'events', 'documents_fts']) {
      const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
      expect(count.c, `${table} deve restare vuota`).toBe(0)
    }
    db.close()
  })

  it('la 0004 aggiunge metadati dei campi, elementi ripetuti e storico dei run', () => {
    const db = openDatabase({ file: ':memory:' })
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name
      )

    expect(columns('fields')).toEqual(
      expect.arrayContaining([
        'semantic_type',
        'cardinality',
        'review_status',
        'validation_errors_json',
        'role'
      ])
    )
    expect(columns('field_items')).toEqual([
      'id',
      'field_id',
      'item_index',
      'value_json',
      'corrected_value_json',
      'confidence',
      'evidence_id',
      'validation_errors_json',
      'updated_at',
      // 0005
      'origin',
      'removed'
    ])
    expect(columns('extraction_runs')).toContain('metrics_json')
    db.close()
  })

  it('la 0005 salva classificazione ed esito, e distingue le righe del revisore', () => {
    const db = databaseAt('0004')
    db.prepare(
      "INSERT INTO documents (id, drive_file_id, filename, mime, synced_at) VALUES ('d', 'x', 'f.pdf', 'application/pdf', '2026-01-01')"
    ).run()
    db.prepare(
      "INSERT INTO fields (id, document_id, name, label, confidence, cardinality) VALUES ('f', 'd', 'line_items', 'Righe documento', 0, 'many')"
    ).run()
    const item = db.prepare(
      'INSERT INTO field_items (id, field_id, item_index, value_json, corrected_value_json, confidence) VALUES (?, ?, ?, ?, ?, ?)'
    )
    item.run('proposta', 'f', 0, '"Fornitura"', null, 0.85)
    item.run('corretta', 'f', 1, '"Posa"', '"Posa in opera"', 0.85)
    // Correzione rimasta senza la riga proposta: la 0004 la teneva con valore nullo.
    item.run('orfana', 'f', 2, null, '"Trasporto"', 0)

    expect(migrate(db)).toEqual(['0005', '0006'])

    expect(
      db.prepare('SELECT id, origin, removed FROM field_items ORDER BY item_index').all()
    ).toEqual([
      { id: 'proposta', origin: 'ENGINE', removed: 0 },
      { id: 'corretta', origin: 'ENGINE', removed: 0 },
      { id: 'orfana', origin: 'MANUAL', removed: 0 }
    ])
    expect(db.prepare('SELECT classification_json, reviewed_at FROM documents').get()).toEqual({
      classification_json: null,
      reviewed_at: null
    })
    db.close()
  })

  it('la 0006 aggiunge l’impronta del layout, vuota sui documenti già a database', () => {
    const db = databaseAt('0005')
    db.prepare(
      "INSERT INTO documents (id, drive_file_id, filename, mime, synced_at) VALUES ('d', 'x', 'f.pdf', 'application/pdf', '2026-01-01')"
    ).run()

    expect(migrate(db)).toEqual(['0006'])

    // NULL = da calcolare al primo export, non «documento senza impronta».
    expect(db.prepare('SELECT template_fingerprint FROM documents').get()).toEqual({
      template_fingerprint: null
    })
    db.prepare("UPDATE documents SET template_fingerprint = 'a1b2c3d4e5f60718'").run()
    expect(db.prepare('SELECT template_fingerprint FROM documents').get()).toEqual({
      template_fingerprint: 'a1b2c3d4e5f60718'
    })
    db.close()
  })
})

describe('migrazione 0004 su un database esistente', () => {
  function seedV1(db: Db): void {
    db.prepare(
      "INSERT INTO documents (id, drive_file_id, filename, mime, document_type, type_confidence, status, synced_at) VALUES ('d1', 'x1', 'f.pdf', 'application/pdf', 'accounting.fattura', 0.9, 'REVIEWED', '2026-01-01')"
    ).run()
    db.prepare(
      "INSERT INTO documents (id, drive_file_id, filename, mime, synced_at) VALUES ('d2', 'x2', 'g.pdf', 'application/pdf', '2026-01-01')"
    ).run()
    db.prepare(
      "INSERT INTO evidence (id, document_id, page, text, confidence) VALUES ('e1', 'd1', 1, 'FATTURA n. 114/2026', 0.85)"
    ).run()
    const field = db.prepare(
      'INSERT INTO fields (id, document_id, name, label, value, corrected_value, confidence, evidence_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    field.run(
      'f1',
      'd1',
      'document_number',
      'Numero documento',
      '114',
      '114/2026',
      0.85,
      'e1',
      '2026-02-01'
    )
    field.run('f2', 'd1', 'total_amount', 'Totale', '86420.00', null, 0.85, null, null)
    field.run('f3', 'd1', 'customs_value', 'Valore doganale', null, '10.00', 0, null, '2026-02-02')
    field.run(
      'f4',
      'd2',
      'issue_date',
      'Data di emissione',
      '2026-09-08',
      '2026-09-09',
      0.85,
      null,
      '2026-02-03'
    )
    field.run('f5', 'd2', 'campo_sconosciuto', 'Altro', 'x', 'y', 0.5, null, null)
  }

  it('rinomina i campi v1 sugli id dell’ontologia senza toccare le correzioni', () => {
    const db = databaseAt('0003')
    seedV1(db)

    expect(migrate(db)).toEqual(['0004', '0005', '0006'])

    const rows = db
      .prepare(
        'SELECT id, name, label, value, corrected_value, evidence_id, updated_at, cardinality FROM fields ORDER BY id'
      )
      .all()
    expect(rows).toEqual([
      {
        id: 'f1',
        name: 'document.number',
        label: 'Numero documento',
        value: '114',
        corrected_value: '114/2026',
        evidence_id: 'e1',
        updated_at: '2026-02-01',
        cardinality: 'one'
      },
      {
        id: 'f2',
        name: 'money.total',
        label: 'Totale',
        value: '86420.00',
        corrected_value: null,
        evidence_id: null,
        updated_at: null,
        cardinality: 'one'
      },
      {
        id: 'f3',
        name: 'money.amount',
        label: 'Importo',
        value: null,
        corrected_value: '10.00',
        evidence_id: null,
        updated_at: '2026-02-02',
        cardinality: 'one'
      },
      {
        id: 'f4',
        name: 'document.issue_date',
        label: 'Data emissione',
        value: '2026-09-08',
        corrected_value: '2026-09-09',
        evidence_id: null,
        updated_at: '2026-02-03',
        cardinality: 'one'
      },
      {
        id: 'f5',
        name: 'campo_sconosciuto',
        label: 'Altro',
        value: 'x',
        corrected_value: 'y',
        evidence_id: null,
        updated_at: null,
        cardinality: 'one'
      }
    ])
    // Stato e tipo del documento restano quelli di prima.
    expect(db.prepare("SELECT status, document_type FROM documents WHERE id = 'd1'").get()).toEqual(
      {
        status: 'REVIEWED',
        document_type: 'accounting.fattura'
      }
    )
    db.close()
  })

  it('due nomi v1 sullo stesso id non producono due righe con lo stesso nome', () => {
    const db = databaseAt('0003')
    db.prepare(
      "INSERT INTO documents (id, drive_file_id, filename, mime, synced_at) VALUES ('d', 'x', 'f.pdf', 'application/pdf', '2026-01-01')"
    ).run()
    const field = db.prepare(
      "INSERT INTO fields (id, document_id, name, label, corrected_value, confidence) VALUES (?, 'd', ?, ?, ?, 0)"
    )
    field.run('a', 'amount', 'Importo', '1.00')
    field.run('b', 'customs_value', 'Valore doganale', '2.00')

    migrate(db)

    const names = db.prepare("SELECT name FROM fields WHERE document_id = 'd' ORDER BY id").all()
    expect(names).toEqual([{ name: 'money.amount' }, { name: 'customs_value' }])
    db.close()
  })

  it('le UPDATE della migrazione coprono esattamente la mappa legacy', () => {
    const sql = MIGRATIONS.find((m) => m.version === '0004')!.sql
    const renames = Object.fromEntries(
      [
        ...sql.matchAll(
          /UPDATE fields SET name = '([^']+)', label = '(?:[^']|'')*' WHERE name = '([^']+)'/g
        )
      ].map((match) => [match[2], match[1]])
    )
    expect(renames).toEqual(testLegacyFieldMap())

    // Le etichette sono quelle dell'ontologia.
    const ontology = JSON.parse(
      readFileSync(join(REGISTRY_V2_DIR, 'field_ontology_v2.json'), 'utf8')
    ).fields as Record<string, { label_it: string }>
    for (const match of sql.matchAll(/SET name = '([^']+)', label = '((?:[^']|'')*)'/g)) {
      expect(match[2]!.replace(/''/g, "'")).toBe(ontology[match[1]!]!.label_it)
    }
  })
})
