import { openDatabase } from '../../src/main/db'
import { createRepository, type Repository } from '../../src/main/db/repository'

/**
 * Database in memoria per i test: nessun file, nessuna credenziale, nessuna rete.
 * Il resolver dei campi obbligatori è uno stub, così i test del livello dati non
 * dipendono dal registry.
 */
export function createTestRepository(
  requiredByType: Record<string, string[]> = {}
): Repository & { close: () => void } {
  const db = openDatabase({ file: ':memory:' })
  const repo = createRepository(db, {
    requiredFields: (type) => requiredByType[type ?? ''] ?? ['document_number', 'issue_date'],
    typeLabel: (type) => (type ? type.split('.').pop()!.replace(/_/g, ' ') : null)
  })
  return Object.assign(repo, { close: () => db.close() })
}

export function seedDocument(
  repo: Repository,
  overrides: Partial<{
    driveFileId: string
    filename: string
    mime: string
    receivedAt: string | null
  }> = {}
): string {
  const { id } = repo.documents.upsertFromDrive({
    driveFileId: overrides.driveFileId ?? 'drive-1',
    filename: overrides.filename ?? 'Fattura 114.pdf',
    mime: overrides.mime ?? 'application/pdf',
    receivedAt: overrides.receivedAt ?? '2026-09-08T10:00:00.000Z'
  })
  return id
}
