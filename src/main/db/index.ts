import SqliteDatabase from 'better-sqlite3'
import { MIGRATIONS } from './migrations'

export type Db = SqliteDatabase.Database

export interface OpenOptions {
  /** `:memory:` nei test, il file in userData in produzione. */
  file: string
  readonly?: boolean
}

/**
 * Apre il database e porta lo schema all'ultima versione.
 *
 * better-sqlite3 13 distribuisce prebuild N-API, ABI-stabili sia per Node sia per
 * Electron: lo stesso binario serve i test sotto vitest e il processo main.
 */
export function openDatabase(options: OpenOptions): Db {
  const db = new SqliteDatabase(options.file, { readonly: options.readonly ?? false })
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

/** Applica le migrazioni mancanti, ognuna in transazione. Ritorna quelle applicate. */
export function migrate(db: Db): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: string }).version)
  )

  const done: string[] = []
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  )

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    // `exec` non può girare dentro una transazione aperta da better-sqlite3 quando
    // l'SQL contiene BEGIN/COMMIT: qui i file non ne contengono, quindi va bene.
    const run = db.transaction(() => {
      db.exec(migration.sql)
      record.run(migration.version, migration.name, new Date().toISOString())
    })
    run()
    done.push(migration.version)
  }

  return done
}
