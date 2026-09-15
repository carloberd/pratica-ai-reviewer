import { describe, expect, it } from 'vitest'
import { migrate, openDatabase } from '../src/main/db'
import { MIGRATIONS } from '../src/main/db/migrations'

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
      'annotations',
      'events',
      'documents_fts',
      'schema_migrations'
    ]) {
      expect(names).toContain(table)
    }
    db.close()
  })

  it('è idempotente: una seconda esecuzione non applica nulla', () => {
    const db = openDatabase({ file: ':memory:' })
    expect(migrate(db)).toEqual([])
    const journal = db.prepare('SELECT version FROM schema_migrations').all()
    expect(journal).toHaveLength(MIGRATIONS.length)
    db.close()
  })

  it('applica le pragma attese', () => {
    const db = openDatabase({ file: ':memory:' })
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    db.close()
  })

  it('cancellando un documento spariscono campi, evidenze, annotazioni ed eventi', () => {
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
      "INSERT INTO annotations (id, document_id, page, bbox_json, kind, created_at, updated_at) VALUES ('a', 'd', 1, '{}', 'note', '2026', '2026')"
    ).run()
    db.prepare(
      "INSERT INTO events (id, document_id, at, title, detail) VALUES ('v', 'd', '2026', 't', 'd')"
    ).run()
    db.prepare(
      "INSERT INTO documents_fts (document_id, filename, page, page_text) VALUES ('d', 'f.pdf', '1', 'testo')"
    ).run()

    db.prepare("DELETE FROM documents WHERE id = 'd'").run()

    for (const table of ['fields', 'evidence', 'annotations', 'events', 'documents_fts']) {
      const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
      expect(count.c, `${table} deve restare vuota`).toBe(0)
    }
    db.close()
  })
})
