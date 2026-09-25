/**
 * Il dataset annotato **coi documenti da cui è stato ricavato**: una cartella sola con il
 * JSON, il foglio di calcolo e una copia dei file che il revisore ha chiuso.
 *
 * Esiste perché il dataset da solo non basta a chi lo riceve: le evidenze rimandano a
 * pagine, righe e coordinate di file che stanno nella cache di questa macchina, e senza
 * quei file non si può né controllare un valore né far girare un motore sui documenti
 * veri. I due export di prima restano quello che erano — qui dentro il `dataset.json` è
 * byte per byte quello della voce «JSON», e il foglio quello della voce «Excel».
 *
 * Il legame fra una riga del dataset e il file copiato lo tiene `documenti.json`: la
 * chiave è il `driveFileId`, la stessa del dataset. Il nome del file copiato invece è
 * quello che il revisore vede in Drive, ripulito di quello che un filesystem non accetta,
 * perché la cartella la aprirà una persona.
 *
 * Modulo puro: nessun file e nessun database. Il main copia e riempie i byte.
 */

/** La copia del file DOCX arriva così da Drive; tutto il resto è un PDF. */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export const BUNDLE_FILES_FORMAT = 'praticaai-reviewer/annotated-dataset-files'
export const BUNDLE_FILES_FORMAT_VERSION = '1.0.0'

/** La sottocartella con le copie, e il file che le lega alle righe del dataset. */
export const BUNDLE_DOCUMENTS_DIR = 'documenti'
export const BUNDLE_FILES_MANIFEST = 'documenti.json'

/**
 * Perché un documento chiuso dal revisore è nel dataset ma non nella cartella.
 *
 * `NO_LOCAL_COPY` è la copia tolta dalla cache («Libera spazio» sul documento), `FILE_GONE`
 * il path registrato ma il file sparito dal disco, `COPY_FAILED` una copia non riuscita.
 * Un export non riscarica niente da Drive: dice quali file mancano e si riaprono da lì.
 */
export type BundleFileMissing = 'NO_LOCAL_COPY' | 'FILE_GONE' | 'COPY_FAILED'

/** Un documento chiuso dal revisore, come lo vede chi prepara la cartella. */
export interface BundleFileInput {
  driveFileId: string
  filename: string
  mime: string
  /** `REVIEWED` o `DISCARDED`: gli scartati hanno un file come gli altri. */
  status: string
  /** Sha-256 del file **elaborato**, `null` se elaborato prima della 1.1.0. */
  contentSha256: string | null
  /** La copia in cache, `null` se non c'è più. */
  cachedPath: string | null
}

/** Dove va copiato un documento, prima che qualcuno lo copi davvero. */
export interface PlannedBundleFile extends BundleFileInput {
  /** Percorso dentro la cartella, separatore `/`; `null` se non c'è niente da copiare. */
  file: string | null
  missing: BundleFileMissing | null
}

/** Un documento nella cartella, a copia fatta. */
export interface BundleFileEntry {
  driveFileId: string
  filename: string
  mime: string
  status: string
  /** Il percorso dentro la cartella, `null` quando il file manca. */
  file: string | null
  bytes: number | null
  /** Sha-256 della copia, `null` quando il file manca. */
  sha256: string | null
  /** Sha-256 del file al momento dell'elaborazione, `null` se non era registrato. */
  contentSha256: string | null
  /**
   * `true` se la copia è lo stesso file su cui il revisore ha annotato, `false` se il file
   * in cache è cambiato da allora, `null` quando non c'è modo di saperlo.
   */
  matchesAnnotated: boolean | null
  missing: BundleFileMissing | null
}

export interface DatasetFilesManifest {
  format: typeof BUNDLE_FILES_FORMAT
  formatVersion: typeof BUNDLE_FILES_FORMAT_VERSION
  exportedAt: string
  counts: {
    documents: number
    copied: number
    missing: number
    /** Copie che non corrispondono al file annotato: da guardare prima di usarle. */
    mismatched: number
    bytes: number
  }
  files: BundleFileEntry[]
}

// ---------------------------------------------------------------------------
// I nomi dei file copiati
// ---------------------------------------------------------------------------

/** Quello che Windows non accetta in un nome, più i separatori e i caratteri di controllo. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: sono proprio quelli da togliere
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g

/** Un nome lungo quanto basta a riconoscere il documento, senza sfondare i path di Windows. */
const MAX_STEM = 80

function extensionOf(mime: string): string {
  return mime === DOCX_MIME ? 'docx' : 'pdf'
}

/**
 * Il nome del file come lo vede il revisore, reso scrivibile su disco: via i caratteri che
 * un filesystem rifiuta, gli spazi ripetuti e i punti in fondo (che Windows mangia).
 * Se non resta niente di leggibile vale l'id di Drive, che c'è sempre.
 */
function safeStem(filename: string, extension: string, fallback: string): string {
  const dot = filename.lastIndexOf('.')
  // L'estensione la decide il mime: quella scritta nel nome si toglie solo se è già quella.
  const withoutExtension =
    dot > 0 && filename.slice(dot + 1).toLowerCase() === extension
      ? filename.slice(0, dot)
      : filename

  const cleaned = withoutExtension
    .replace(FORBIDDEN, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .slice(0, MAX_STEM)
    .trim()

  return cleaned.length > 0 ? cleaned : fallback.replace(FORBIDDEN, '_')
}

/**
 * Dove finisce ogni documento dentro la cartella.
 *
 * Due documenti di Drive possono chiamarsi allo stesso modo — «fattura.pdf» ce n'è in ogni
 * cartella — e allora il secondo prende un `-2`. L'ordine è quello del dataset (nome file,
 * poi id di Drive), così due export dello stesso database danno gli stessi nomi.
 */
export function planBundleFiles(inputs: BundleFileInput[]): PlannedBundleFile[] {
  const ordered = [...inputs].sort(
    (a, b) =>
      a.filename.localeCompare(b.filename, 'it') || a.driveFileId.localeCompare(b.driveFileId)
  )

  const taken = new Set<string>()
  return ordered.map((input) => {
    if (!input.cachedPath) return { ...input, file: null, missing: 'NO_LOCAL_COPY' }

    const extension = extensionOf(input.mime)
    const stem = safeStem(input.filename, extension, input.driveFileId)
    let name = `${stem}.${extension}`
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${stem}-${n}.${extension}`
    taken.add(name.toLowerCase())

    return { ...input, file: `${BUNDLE_DOCUMENTS_DIR}/${name}`, missing: null }
  })
}

// ---------------------------------------------------------------------------
// Il manifest
// ---------------------------------------------------------------------------

/** `documenti.json`: cosa è stato copiato, cosa manca e cosa non corrisponde. */
export function buildFilesManifest(
  exportedAt: string,
  files: BundleFileEntry[]
): DatasetFilesManifest {
  return {
    format: BUNDLE_FILES_FORMAT,
    formatVersion: BUNDLE_FILES_FORMAT_VERSION,
    exportedAt,
    counts: {
      documents: files.length,
      copied: files.filter((file) => file.file !== null).length,
      missing: files.filter((file) => file.missing !== null).length,
      mismatched: files.filter((file) => file.matchesAnnotated === false).length,
      bytes: files.reduce((sum, file) => sum + (file.bytes ?? 0), 0)
    },
    files
  }
}

/** JSON leggibile, come gli altri export: il file si apre e si confronta a occhio. */
export function serializeFilesManifest(manifest: DatasetFilesManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Il nome della cartella proposta al revisore: `praticaai-dataset-2026-09-25`. */
export function datasetBundleFolderName(now: Date): string {
  return `praticaai-dataset-${now.toISOString().slice(0, 10)}`
}

// ---------------------------------------------------------------------------
// La frase che il revisore legge
// ---------------------------------------------------------------------------

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`
}

/** Quanti byte occupa la cartella, come si scrivono in una riga di stato. */
function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/**
 * Com'è andato l'export completo. I file che mancano e quelli che non corrispondono si
 * dicono sempre: una cartella incompleta che sembra completa è il modo più facile per
 * mandare al benchmark un documento che non è quello annotato.
 */
export function describeDatasetBundle(result: {
  saved: boolean
  directory: string | null
  documents: number
  corrections: number
  copied: number
  missing: number
  mismatched: number
  bytes: number
}): string {
  if (!result.saved) return 'Export annullato: non è stato scritto niente.'

  const parts = [
    `Dataset completo esportato in ${result.directory}: ` +
      `${plural(result.documents, 'documento', 'documenti')}, ` +
      `${plural(result.corrections, 'correzione', 'correzioni')}, ` +
      `${plural(result.copied, 'file copiato', 'file copiati')} (${humanBytes(result.bytes)}).`
  ]
  if (result.missing > 0) {
    parts.push(
      `${plural(result.missing, 'documento è', 'documenti sono')} nel dataset ma senza file: ` +
        'la copia locale non c’è più. Riaprili da Drive e riesporta.'
    )
  }
  if (result.mismatched > 0) {
    parts.push(
      `Attenzione: ${plural(result.mismatched, 'file copiato non corrisponde', 'file copiati non corrispondono')} ` +
        'al documento annotato — su Drive è cambiato dopo la revisione. Sono elencati in documenti.json.'
    )
  }
  return parts.join(' ')
}
