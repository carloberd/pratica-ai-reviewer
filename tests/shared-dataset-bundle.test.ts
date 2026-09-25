import { describe, expect, it } from 'vitest'
import {
  type BundleFileEntry,
  type BundleFileInput,
  buildFilesManifest,
  datasetBundleFolderName,
  describeDatasetBundle,
  planBundleFiles
} from '../src/shared/dataset-bundle'

/**
 * I nomi dei file nella cartella e il manifest che li lega al dataset. Tutto puro: qui
 * non si copia niente, si decide soltanto dove andrebbe copiato e cosa scriverne.
 */

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function input(overrides: Partial<BundleFileInput> = {}): BundleFileInput {
  return {
    driveFileId: 'drive-1',
    filename: 'Fattura 114.pdf',
    mime: 'application/pdf',
    status: 'REVIEWED',
    contentSha256: 'abc',
    cachedPath: '/cache/drive-1.pdf',
    ...overrides
  }
}

function entry(overrides: Partial<BundleFileEntry> = {}): BundleFileEntry {
  return {
    driveFileId: 'drive-1',
    filename: 'Fattura 114.pdf',
    mime: 'application/pdf',
    status: 'REVIEWED',
    file: 'documenti/Fattura 114.pdf',
    bytes: 1024,
    sha256: 'abc',
    contentSha256: 'abc',
    matchesAnnotated: true,
    missing: null,
    ...overrides
  }
}

describe('i file della cartella', () => {
  it('tiene il nome che il revisore vede in Drive', () => {
    const [file] = planBundleFiles([input()])
    expect(file!.file).toBe('documenti/Fattura 114.pdf')
    expect(file!.missing).toBeNull()
  })

  it('l’estensione è quella del mime, non quella scritta nel nome', () => {
    const files = planBundleFiles([
      input({ driveFileId: 'a', filename: 'contratto', mime: DOCX }),
      input({ driveFileId: 'b', filename: 'scansione.PDF' })
    ])
    expect(files.map((file) => file.file)).toEqual([
      'documenti/contratto.docx',
      'documenti/scansione.pdf'
    ])
  })

  it('ordina come il dataset — nome file, poi id di Drive', () => {
    const files = planBundleFiles([
      input({ driveFileId: 'z', filename: 'b.pdf' }),
      input({ driveFileId: 'b', filename: 'a.pdf' }),
      input({ driveFileId: 'a', filename: 'a.pdf' })
    ])
    expect(files.map((file) => file.driveFileId)).toEqual(['a', 'b', 'z'])
  })

  // Due cartelle di Drive con dentro «fattura.pdf» sono la norma, non un caso limite:
  // sovrascrivere il primo col secondo perderebbe un documento annotato senza dirlo.
  it('due documenti con lo stesso nome non si sovrascrivono', () => {
    const files = planBundleFiles([
      input({ driveFileId: 'a', filename: 'fattura.pdf' }),
      input({ driveFileId: 'b', filename: 'fattura.pdf' }),
      input({ driveFileId: 'c', filename: 'FATTURA.pdf' })
    ])
    // Il confronto è senza maiuscole: su macOS e Windows «fattura.pdf» e «FATTURA.pdf»
    // sono lo stesso file, e il terzo documento finirebbe sopra il primo.
    expect(files.map((file) => file.file)).toEqual([
      'documenti/fattura.pdf',
      'documenti/fattura-2.pdf',
      'documenti/FATTURA-3.pdf'
    ])
  })

  it('toglie dal nome quello che un filesystem non accetta', () => {
    const [file] = planBundleFiles([
      input({ filename: 'DURC 1/2026: "definitivo"?.pdf', mime: 'application/pdf' })
    ])
    expect(file!.file).toBe('documenti/DURC 1_2026_ _definitivo__.pdf')
  })

  it('senza niente di leggibile nel nome vale l’id di Drive', () => {
    const [file] = planBundleFiles([input({ driveFileId: 'drive-9', filename: '...' })])
    expect(file!.file).toBe('documenti/drive-9.pdf')
  })

  it('senza copia locale non c’è file da copiare, e si dice perché', () => {
    const [file] = planBundleFiles([input({ cachedPath: null })])
    expect(file!.file).toBeNull()
    expect(file!.missing).toBe('NO_LOCAL_COPY')
  })
})

describe('documenti.json', () => {
  it('conta copiati, mancanti e copie che non corrispondono', () => {
    const manifest = buildFilesManifest('2026-09-25T10:00:00.000Z', [
      entry({ bytes: 1000 }),
      entry({ driveFileId: 'drive-2', bytes: 2000, sha256: 'xyz', matchesAnnotated: false }),
      entry({
        driveFileId: 'drive-3',
        file: null,
        bytes: null,
        sha256: null,
        matchesAnnotated: null,
        missing: 'NO_LOCAL_COPY'
      })
    ])
    expect(manifest.counts).toEqual({
      documents: 3,
      copied: 2,
      missing: 1,
      mismatched: 1,
      bytes: 3000
    })
    expect(manifest.format).toBe('praticaai-reviewer/annotated-dataset-files')
  })

  it('un documento elaborato prima che ci fosse lo sha non è un documento sbagliato', () => {
    const manifest = buildFilesManifest('2026-09-25T10:00:00.000Z', [
      entry({ contentSha256: null, matchesAnnotated: null })
    ])
    expect(manifest.counts.mismatched).toBe(0)
  })
})

describe('la frase che il revisore legge', () => {
  const base = {
    saved: true,
    directory: '/Users/x/Documents/praticaai-dataset-2026-09-25',
    documents: 3,
    corrections: 7,
    copied: 3,
    missing: 0,
    mismatched: 0,
    bytes: 3_500_000
  }

  it('dice dove, quanti documenti e quanto pesa', () => {
    expect(describeDatasetBundle(base)).toBe(
      'Dataset completo esportato in /Users/x/Documents/praticaai-dataset-2026-09-25: ' +
        '3 documenti, 7 correzioni, 3 file copiati (3.3 MB).'
    )
  })

  it('i file che mancano si dicono sempre', () => {
    const message = describeDatasetBundle({ ...base, copied: 2, missing: 1 })
    expect(message).toContain('1 documento è nel dataset ma senza file')
    expect(message).toContain('Riaprili da Drive')
  })

  it('una copia che non è il documento annotato è un avviso, non una riga in meno', () => {
    const message = describeDatasetBundle({ ...base, mismatched: 2 })
    expect(message).toContain('2 file copiati non corrispondono')
    expect(message).toContain('documenti.json')
  })

  it('annullato vuol dire che non è stato scritto niente', () => {
    expect(describeDatasetBundle({ ...base, saved: false, directory: null })).toBe(
      'Export annullato: non è stato scritto niente.'
    )
  })
})

it('la cartella proposta ha la data dell’export', () => {
  expect(datasetBundleFolderName(new Date('2026-09-25T18:00:00.000Z'))).toBe(
    'praticaai-dataset-2026-09-25'
  )
})
