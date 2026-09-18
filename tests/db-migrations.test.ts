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
      'removed',
      // 0010
      'corrected_evidence_id'
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

    expect(migrate(db)).toEqual([
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017'
    ])

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

    expect(migrate(db)).toEqual([
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017'
    ])

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

  it('la 0008 apre le tabelle della mappa, vuote: nessuna decisione presa prima esiste', () => {
    const db = databaseAt('0007')

    expect(migrate(db)).toEqual([
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017'
    ])

    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_overrides').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_hint_labels').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_actions').get()).toEqual({ n: 0 })

    // Lo stato di un campo è uno dei quattro pesi oppure «non utile», e basta.
    db.prepare(
      "INSERT INTO profile_overrides (document_type, field_id, state, updated_at) VALUES ('accounting.fattura', 'procurement.cig', 'excluded', '2026-09-17')"
    ).run()
    expect(() =>
      db
        .prepare(
          "INSERT INTO profile_overrides (document_type, field_id, state, updated_at) VALUES ('accounting.fattura', 'bank.iban', 'importante', '2026-09-17')"
        )
        .run()
    ).toThrow()

    db.close()
  })

  it('la 0009 apre la tabella delle cardinalità, vuota: ogni campo segue l’ontologia', () => {
    const db = databaseAt('0008')

    expect(migrate(db)).toEqual([
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017'
    ])

    expect(db.prepare('SELECT COUNT(*) AS n FROM profile_cardinality_overrides').get()).toEqual({
      n: 0
    })

    // Un valore solo o più valori, e basta.
    db.prepare(
      "INSERT INTO profile_cardinality_overrides (document_type, field_id, cardinality, updated_at) VALUES ('accounting.fattura', 'bank.iban', 'many', '2026-09-17')"
    ).run()
    expect(() =>
      db
        .prepare(
          "INSERT INTO profile_cardinality_overrides (document_type, field_id, cardinality, updated_at) VALUES ('accounting.fattura', 'procurement.cig', 'tanti', '2026-09-17')"
        )
        .run()
    ).toThrow()

    db.close()
  })

  it('la 0010 conserva le correzioni e le evidenze di prima: tutte del motore, nessuna selezione', () => {
    const db = databaseAt('0009')
    db.exec(`
      INSERT INTO documents (id, drive_file_id, filename, mime, synced_at)
        VALUES ('d', 'x', 'f.pdf', 'application/pdf', '2026-01-01');
      INSERT INTO evidence (id, document_id, page, text, confidence)
        VALUES ('e', 'd', 1, 'FATTURA n. 114/2026', 0.85);
      INSERT INTO fields (id, document_id, name, label, value, corrected_value, confidence, evidence_id)
        VALUES ('f', 'd', 'document.number', 'Numero documento', '114/2026', '114/2026-bis', 0.85, 'e');
    `)

    expect(migrate(db)).toEqual(['0010', '0011', '0012', '0013', '0014', '0015', '0016', '0017'])

    expect(db.prepare('SELECT origin, method, line_start, char_start FROM evidence').get()).toEqual(
      {
        origin: 'ENGINE',
        method: null,
        line_start: null,
        char_start: null
      }
    )
    // Una correzione di prima resta senza selezione: nessuno sa da dove venisse.
    expect(db.prepare('SELECT corrected_value, corrected_evidence_id FROM fields').get()).toEqual({
      corrected_value: '114/2026-bis',
      corrected_evidence_id: null
    })
    expect(db.prepare('SELECT content_sha256 FROM documents').get()).toEqual({
      content_sha256: null
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM document_pages').get()).toEqual({ n: 0 })
    expect(() => db.prepare("UPDATE evidence SET origin = 'OTHER'").run()).toThrow(
      /CHECK constraint failed/
    )
    db.close()
  })

  it('la 0011 apre il deposito del learner vuoto, in modalità LEARNING', () => {
    const db = databaseAt('0010')
    expect(migrate(db)).toEqual(['0011', '0012', '0013', '0014', '0015', '0016', '0017'])

    expect(db.prepare('SELECT id, mode FROM learning_state').all()).toEqual([
      { id: 1, mode: 'LEARNING' }
    ])
    for (const table of [
      'learning_events',
      'learning_rules',
      'learning_rule_evidence',
      'learning_actions'
    ]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
    }
    // Una sola riga di stato, e solo le tre modalità.
    expect(() =>
      db
        .prepare("INSERT INTO learning_state (id, mode, updated_at) VALUES (2, 'LEARNING', 'x')")
        .run()
    ).toThrow(/CHECK constraint failed/)
    expect(() => db.prepare("UPDATE learning_state SET mode = 'OFF'").run()).toThrow(
      /CHECK constraint failed/
    )
    db.close()
  })

  it('la 0012 lega evidenze ed eventi alle regole, e conta una prova per documento', () => {
    const db = databaseAt('0011')
    expect(migrate(db)).toEqual(['0012', '0013', '0014', '0015', '0016', '0017'])
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    expect(columns('evidence')).toContain('rule_id')
    expect(columns('learning_events')).toContain('engine_rule_id')
    expect(columns('learning_rule_evidence')).toEqual([
      'rule_id',
      'document_key',
      'event_id',
      'effect'
    ])
    db.close()
  })

  it('la 0013 butta le impronte vecchie e chiude le regole che ci erano appese', () => {
    const db = databaseAt('0012')
    db.prepare(
      "INSERT INTO documents (id, drive_file_id, filename, mime, status, synced_at, template_fingerprint) VALUES ('d', 'x', 'f.pdf', 'application/pdf', 'REVIEWED', '2026-01-01', 'aabbccdd11223344')"
    ).run()
    db.prepare(
      "INSERT INTO learning_events (id, at, actor, document_id, template_fingerprint, kind, outcome, learner_version) VALUES ('e', '2026-01-01', 'chi@esempio.it', 'd', 'aabbccdd11223344', 'FIELD_VALUE', 'FILLED', 'v')"
    ).run()
    const rule = (id: string, scope: string, status: string, fingerprint: string | null) =>
      db
        .prepare(
          'INSERT INTO learning_rules (id, kind, scope, document_type, template_fingerprint, pattern_json, rule_key, status, created_at, updated_at, learner_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          id,
          'EXTRACTION_ANCHOR',
          scope,
          'accounting.fattura',
          fingerprint,
          '{}',
          id,
          status,
          '2026-01-01',
          '2026-01-01',
          'v'
        )
    rule('template-candidata', 'TEMPLATE', 'CANDIDATE', 'aabbccdd11223344')
    rule('template-attiva', 'TEMPLATE', 'ACTIVE', 'aabbccdd11223344')
    rule('classe', 'CLASS', 'CANDIDATE', null)

    expect(migrate(db)).toEqual(['0013', '0014', '0015', '0016', '0017'])

    // Le impronte del vecchio algoritmo spariscono: l'elaborazione e l'export le rifanno.
    expect(db.prepare('SELECT template_fingerprint FROM documents').get()).toEqual({
      template_fingerprint: null
    })
    // L'evento resta, senza l'impronta: quello che il revisore ha deciso non cambia.
    expect(
      db.prepare('SELECT id, outcome, template_fingerprint FROM learning_events').get()
    ).toEqual({ id: 'e', outcome: 'FILLED', template_fingerprint: null })
    // Le regole TEMPLATE chiudono, quelle CLASS restano dove sono.
    expect(db.prepare('SELECT id, status FROM learning_rules ORDER BY id').all()).toEqual([
      { id: 'classe', status: 'CANDIDATE' },
      { id: 'template-attiva', status: 'REJECTED' },
      { id: 'template-candidata', status: 'REJECTED' }
    ])
    // Una regola non si cancella in silenzio: l'azione dice da dove arriva e perché.
    const actions = db
      .prepare(
        'SELECT kind, rule_id, before_state, after_state FROM learning_actions ORDER BY rule_id'
      )
      .all()
    expect(actions).toEqual([
      {
        kind: 'RULE_REJECTED',
        rule_id: 'template-attiva',
        before_state: 'ACTIVE',
        after_state: 'REJECTED'
      },
      {
        kind: 'RULE_REJECTED',
        rule_id: 'template-candidata',
        before_state: 'CANDIDATE',
        after_state: 'REJECTED'
      }
    ])
    db.close()
  })

  it('la 0014 apre la data del ripasso, vuota sugli eventi già registrati', () => {
    const db = databaseAt('0013')
    db.prepare(
      "INSERT INTO learning_events (id, at, actor, document_id, kind, outcome, learner_version) VALUES ('e', '2026-09-15', 'chi@esempio.it', 'd', 'FIELD_VALUE', 'FILLED', 'v')"
    ).run()

    expect(migrate(db)).toEqual(['0014', '0015', '0016', '0017'])

    // Gli eventi di prima sono stati registrati sul momento: non hanno una data di ripasso.
    expect(db.prepare('SELECT at, replayed_at FROM learning_events').get()).toEqual({
      at: '2026-09-15',
      replayed_at: null
    })
    db.close()
  })

  it('la 0015 apre la colonna della lettura sistemata, spenta sulle selezioni di prima', () => {
    const db = databaseAt('0014')
    db.prepare(
      "INSERT INTO documents (id, drive_file_id, filename, mime, synced_at) VALUES ('d', 'x', 'f.pdf', 'application/pdf', '2026-01-01')"
    ).run()
    db.prepare(
      "INSERT INTO evidence (id, document_id, page, text, confidence, origin, method) VALUES ('e', 'd', 1, '29 O7 2026', 1, 'REVIEWER', 'AREA_OCR')"
    ).run()

    expect(migrate(db)).toEqual(['0015', '0016', '0017'])

    // Una selezione registrata prima di questa versione era per forza il valore salvato:
    // il testo non era stato sistemato, o la selezione non sarebbe qui.
    expect(db.prepare('SELECT text, text_corrected FROM evidence').get()).toEqual({
      text: '29 O7 2026',
      text_corrected: 0
    })
    db.close()
  })

  it('la 0016 apre la firma del modulo, vuota su documenti ed eventi di prima', () => {
    const db = databaseAt('0015')
    db.prepare(
      "INSERT INTO documents (id, drive_file_id, filename, mime, synced_at, template_fingerprint) VALUES ('d', 'x', 'f.pdf', 'application/pdf', '2026-01-01', 'abc123')"
    ).run()
    db.prepare(
      `INSERT INTO learning_events (id, at, actor, document_id, kind, outcome, learner_version, template_fingerprint)
       VALUES ('e', '2026-01-01', 'chi', 'd', 'DOCUMENT_TYPE', 'CONFIRMED', 'local-learner/0.1.0', 'abc123')`
    ).run()

    expect(migrate(db)).toEqual(['0016', '0017'])

    // L'impronta esatta non si tocca: le regole scritte prima continuano a valere per
    // confronto esatto, e la firma manca semplicemente su quello che c'era già.
    expect(
      db.prepare('SELECT template_fingerprint, template_signature_json FROM documents').get()
    ).toEqual({ template_fingerprint: 'abc123', template_signature_json: null })
    expect(db.prepare('SELECT template_signature_json FROM learning_events').get()).toEqual({
      template_signature_json: null
    })
    db.close()
  })

  it('la 0017 apre le colonne della provenienza, vuote sulle evidenze già lette', () => {
    const db = databaseAt('0016')
    db.prepare(
      "INSERT INTO documents (id, drive_file_id, filename, mime, synced_at) VALUES ('d', 'x', 'f.pdf', 'application/pdf', '2026-01-01')"
    ).run()
    db.prepare(
      `INSERT INTO learning_rules (id, kind, scope, document_type, pattern_json, rule_key, status, created_at, updated_at, learner_version)
       VALUES ('regola-1', 'EXTRACTION_ANCHOR', 'CLASS', 'accounting.fattura', '{}', 'k', 'ACTIVE', '2026-01-01', '2026-01-01', 'local-learner/0.1.0')`
    ).run()
    db.prepare(
      "INSERT INTO evidence (id, document_id, page, text, confidence, origin, rule_id) VALUES ('motore', 'd', 1, 'Data: 12/09/2026', 0.85, 'ENGINE', 'regola-1')"
    ).run()
    db.prepare(
      "INSERT INTO evidence (id, document_id, page, text, confidence, origin, method) VALUES ('revisore', 'd', 1, '12/09/2026', 1, 'REVIEWER', 'TEXT_SELECTION')"
    ).run()

    expect(migrate(db)).toEqual(['0017'])

    // Come sia stato letto un valore prima di qui non è ricostruibile: la colonna resta
    // vuota, e vuota vuol dire «non registrato», non «letto in nessun modo».
    expect(
      db
        .prepare('SELECT id, rule_id, extraction_strategy, rule_scope FROM evidence ORDER BY id')
        .all()
    ).toEqual([
      { id: 'motore', rule_id: 'regola-1', extraction_strategy: null, rule_scope: null },
      { id: 'revisore', rule_id: null, extraction_strategy: null, rule_scope: null }
    ])

    // Nullable davvero: un'evidenza si scrive ancora senza dire da dove viene, come fa il
    // motore v1 e come farà chiunque legga in un modo che non ha ancora un nome.
    const columns = db.prepare('PRAGMA table_info(evidence)').all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
    }>
    expect(
      columns
        .filter((c) => ['extraction_strategy', 'rule_scope'].includes(c.name))
        .map((c) => [c.name, c.type, c.notnull, c.dflt_value])
    ).toEqual([
      ['extraction_strategy', 'TEXT', 0, null],
      ['rule_scope', 'TEXT', 0, null]
    ])
    expect(() =>
      db
        .prepare(
          "INSERT INTO evidence (id, document_id, page, text, confidence, origin) VALUES ('senza', 'd', 1, 'x', 0.5, 'ENGINE')"
        )
        .run()
    ).not.toThrow()

    // Nessun CHECK: il vocabolario cresce col codice che lo produce, e una migrazione in
    // meno da scrivere il giorno in cui succede.
    db.prepare(
      "UPDATE evidence SET extraction_strategy = 'LABEL_STRICT', rule_scope = 'TEMPLATE' WHERE id = 'motore'"
    ).run()
    expect(
      db.prepare("SELECT extraction_strategy, rule_scope FROM evidence WHERE id = 'motore'").get()
    ).toEqual({ extraction_strategy: 'LABEL_STRICT', rule_scope: 'TEMPLATE' })
    db.close()
  })

  it('la 0007 aggiunge la nota del revisore, vuota sui documenti già chiusi', () => {
    const db = databaseAt('0006')
    db.prepare(
      "INSERT INTO documents (id, drive_file_id, filename, mime, status, reviewed_at, synced_at) VALUES ('d', 'x', 'f.pdf', 'application/pdf', 'REVIEWED', '2026-01-02', '2026-01-01')"
    ).run()

    expect(migrate(db)).toEqual([
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017'
    ])

    // Chi ha chiuso un documento prima di questa versione non ha una nota da recuperare:
    // restava solo nel testo della timeline, che non è un formato da rileggere.
    expect(db.prepare('SELECT review_note FROM documents').get()).toEqual({ review_note: null })
    db.prepare("UPDATE documents SET review_note = 'timbro illeggibile'").run()
    expect(db.prepare('SELECT review_note FROM documents').get()).toEqual({
      review_note: 'timbro illeggibile'
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

    expect(migrate(db)).toEqual([
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
      '0013',
      '0014',
      '0015',
      '0016',
      '0017'
    ])

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
