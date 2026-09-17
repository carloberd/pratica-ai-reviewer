import type { ActivityEntry, ProfileAction } from './profile-history'
import type { MeasureDelta, ProfileTypeMeasure } from './profile-metrics'

/**
 * I contratti della schermata «Mappa tipi ↔ dati» e della cronologia: quello che
 * attraversa il ponte IPC e le frasi che il revisore legge. Nessuna dipendenza da
 * Electron, dal database o da React — la schermata li usa per mostrare, il main per
 * rispondere, i test per verificare che le parole siano quelle.
 */

/** Un campo dell'ontologia come compare nel menu che li elenca tutti. */
export interface FieldOption {
  id: string
  label: string
  /** Tipo e descrizione, per distinguere due campi che si somigliano. */
  hint: string
}

/** Tutto quello che serve alla schermata in una risposta sola. */
export interface ProfileWorkspace {
  types: ProfileTypeMeasure[]
  /** I 248 campi dell'ontologia: si può aggiungerne uno qualsiasi, non solo i visti. */
  ontology: FieldOption[]
  /** Le ultime azioni, per la riga di riepilogo sotto il tipo. */
  recent: ProfileAction[]
  /** Correzioni alla mappa ancora in piedi, annullate escluse. */
  standingEdits: number
}

export interface ProfileEditOutcome {
  action: ProfileAction
  /** Le misure del tipo dopo la correzione: la mappa è cambiata, i numeri no. */
  measure: ProfileTypeMeasure | null
}

export interface SkippedDocument {
  documentId: string
  filename: string
  reason: string
}

export interface TypeRerunResult {
  documentType: string
  /** Rielaborati dalla cache: nessun file è stato riscaricato. */
  processed: string[]
  skipped: SkippedDocument[]
  failed: SkippedDocument[]
  /** Documenti che dopo il re-run non sono più di questo tipo. Di norma vuoto. */
  retyped: string[]
  before: ProfileTypeMeasure
  after: ProfileTypeMeasure
  delta: MeasureDelta
}

export interface ProfileReportResult {
  /** `false` se il revisore ha annullato la scelta del file. */
  saved: boolean
  path: string | null
  types: number
  documents: number
}

/** L'esito dell'export della mappa corretta. */
export interface ProfileBundleResult {
  saved: boolean
  directory: string | null
  /** I file scritti, per percorso completo. */
  paths: string[]
  /** Tipi con almeno una decisione del revisore. */
  types: number
  /** Campi decisi, in totale. */
  fields: number
  /** Correzioni ancora in piedi al momento dell'export. */
  edits: number
}

/** La cronologia unica, come arriva alla schermata. */
export interface ActivityFeed {
  entries: ActivityEntry[]
  standingEdits: number
}

// ---------------------------------------------------------------------------
// Le frasi che il revisore legge
// ---------------------------------------------------------------------------

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`
}

/** Dove finisce una correzione, detto prima di farla. */
export function describeStore(standingEdits: number): string {
  if (standingEdits === 0) {
    return 'Le correzioni restano qui dentro e valgono subito per il motore. I file per pratica-ai si producono con «Esporta → Mappa tipi ↔ dati», quando vuoi tu.'
  }
  return `${plural(standingEdits, 'correzione in piedi', 'correzioni in piedi')} su questa installazione. Valgono già per il motore; per portarle in pratica-ai usa «Esporta → Mappa tipi ↔ dati».`
}

/** Com'è andata una correzione, una volta fatta. */
export function describeEdit(action: ProfileAction): string {
  return `${action.detail} La trovi in Cronologia, dove si può annullare.`
}

/** L'esito dell'export, con i file che ne sono usciti. */
export function describeBundle(result: ProfileBundleResult): string {
  if (!result.saved) return 'Export annullato: non è stato scritto niente.'
  return (
    `Mappa esportata in ${result.directory}: ${plural(result.types, 'tipo corretto', 'tipi corretti')}, ` +
    `${plural(result.fields, 'campo deciso', 'campi decisi')}, ${result.paths.length} file. ` +
    'I JSON del registry di questa installazione non sono stati toccati.'
  )
}

/** L'esito del re-run in una riga: quanti documenti, e se qualcosa è rimasto fuori. */
export function describeRerun(result: TypeRerunResult): string {
  const parts = [
    `${result.processed.length === 1 ? 'Rielaborato' : 'Rielaborati'} ${plural(result.processed.length, 'documento', 'documenti')} dalla cache.`
  ]
  if (result.skipped.length > 0) {
    parts.push(
      `${plural(result.skipped.length, 'documento saltato', 'documenti saltati')}: la copia locale non c’è più.`
    )
  }
  if (result.failed.length > 0) {
    parts.push(
      `${plural(result.failed.length, 'documento non rielaborato', 'documenti non rielaborati')} per un errore.`
    )
  }
  if (result.retyped.length > 0) {
    parts.push(
      `${plural(result.retyped.length, 'documento ha', 'documenti hanno')} cambiato tipo e non conta più in questi numeri.`
    )
  }
  if (result.delta.unchanged) {
    parts.push('I numeri non si sono mossi: la correzione non ha cambiato la precompilazione.')
  }
  return parts.join(' ')
}
