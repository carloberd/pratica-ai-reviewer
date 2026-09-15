/**
 * Le migrazioni sono file `.sql` numerati in `migrations/`.
 *
 * Vengono inlinate nel bundle con `import.meta.glob(..., '?raw')`: così funzionano
 * identiche in sviluppo, nell'app impacchettata (dove non esiste una cartella
 * `migrations/` su disco) e sotto vitest.
 */
const modules = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

export interface Migration {
  /** Prefisso numerico del file, es. `0001`. */
  version: string
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = Object.entries(modules)
  .map(([path, sql]) => {
    const name = path.split('/').pop() ?? path
    const version = name.split('_')[0] ?? name
    return { version, name, sql }
  })
  .sort((a, b) => a.version.localeCompare(b.version))
