import { describe, expect, it } from 'vitest'
import DriveFiles from '../../src/renderer/src/components/drive-files'
import type { DriveFileSummary, DriveListing } from '../../src/shared/types'
import { count, html, text } from './render'

const file: DriveFileSummary = {
  id: 'f1',
  name: 'Fattura.pdf',
  mimeType: 'application/pdf',
  modifiedTime: null,
  size: 2048,
  documentId: null,
  cached: false,
  stale: false,
  status: null
}

const listing: DriveListing = {
  folders: [{ id: 'd1', name: 'Pratiche 2026', modifiedTime: null }],
  files: [file]
}

const props = {
  root: 'my-drive' as const,
  path: [],
  listing,
  fetchingId: null,
  busy: false,
  onOpen: () => {},
  onNavigate: () => {}
}

describe('DriveFiles', () => {
  it('cartelle prima dei file, nella stessa tabella', () => {
    const markup = html(<DriveFiles {...props} />)
    expect(markup.indexOf('data-kind="folder"')).toBeLessThan(markup.indexOf('data-kind="file"'))
    expect(text(<DriveFiles {...props} />)).toContain('Pratiche 2026 Cartella')
  })

  it('il percorso: la radice e le cartelle attraversate, solo l’ultima non è un link', () => {
    const path = [
      { id: 'd1', name: 'Pratiche 2026', modifiedTime: null },
      { id: 'd2', name: 'Rossi', modifiedTime: null }
    ]
    const markup = html(<DriveFiles {...props} path={path} />)
    expect(text(<DriveFiles {...props} path={path} />)).toContain(
      'Il mio Drive › Pratiche 2026 › Rossi'
    )
    expect(markup).toContain('aria-current="page">Rossi<')
    expect(count(markup, 'aria-current="page"')).toBe(1)
  })

  it('una cartella vuota non si spaccia per la radice vuota', () => {
    const empty = { folders: [], files: [] }
    const path = [{ id: 'd1', name: 'Vuota', modifiedTime: null }]
    expect(text(<DriveFiles {...props} listing={empty} path={path} />)).toContain('Cartella vuota')
    expect(text(<DriveFiles {...props} root="shared-drives" listing={empty} />)).toContain(
      'Nessun Drive condiviso'
    )
  })

  it('mentre legge una cartella nuova mostra lo scheletro, non un elenco vuoto', () => {
    const view = text(<DriveFiles {...props} listing={null} loading />)
    expect(view).toContain('Leggo la cartella su Drive')
    expect(view).not.toContain('vuot')
  })
})
