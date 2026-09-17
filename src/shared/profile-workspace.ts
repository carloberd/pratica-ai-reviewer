import type { ActivityEntry, ProfileAction } from './profile-history'
import type { ProfileTypeMeasure } from './profile-metrics'
import type { ReviewDocument } from './types'

/**
 * I contratti della scheda «Campi da estrarre» e della cronologia: quello che attraversa
 * il ponte IPC e le frasi che il revisore legge. Nessuna dipendenza da Electron, dal
 * database o da React — la scheda li usa per mostrare, il main per rispondere, i test per
 * verificare che le parole siano quelle.
 */

/** Un campo dell'ontologia come compare nel menu che li elenca tutti. */
export interface FieldOption {
  id: string
  label: string
  /** Tipo e descrizione, per distinguere due campi che si somigliano. */
  hint: string
}

/**
 * La mappa del tipo del documento aperto, con quello che serve a correggerla senza
 * lasciare la revisione.
 */
export interface TypeFieldMap {
  documentType: string
  /**
   * I campi che la mappa chiede, con i numeri dei documenti già revisionati di quel tipo.
   * Senza documenti revisionati i numeri sono zero, ma i campi ci sono lo stesso: la mappa
   * si corregge anche sul primo documento.
   */
  measure: ProfileTypeMeasure
  /** Il registry ha un profilo per questo tipo: senza, non c'è una mappa da correggere. */
  editable: boolean
  /** I campi dell'ontologia: si può aggiungerne uno qualsiasi, non solo i visti. */
  ontology: FieldOption[]
  /** Le correzioni su questo tipo che si possono ancora annullare, dalla più recente. */
  undoable: ProfileAction[]
}

/** L'esito di una correzione (o di un annullamento) fatta dal documento aperto. */
export interface MapEditResult {
  action: ProfileAction
  /** Il documento rielaborato con la mappa nuova: la scheda «Dati» lo mostra subito. */
  document: ReviewDocument
  map: TypeFieldMap
  /** `false` se la copia locale non c'è: il documento resta quello di prima. */
  reprocessed: boolean
  /** Altri documenti in coda dello stesso tipo, rielaborati in sottofondo. */
  queued: number
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

/** Com'è andata una correzione fatta dalla revisione, una volta fatta. */
export function describeMapEdit(
  result: Pick<MapEditResult, 'action' | 'reprocessed' | 'queued'>
): string {
  const parts = [result.action.detail]
  parts.push(
    result.reprocessed
      ? 'Il documento è stato rielaborato: i campi aggiornati sono in «Dati».'
      : 'La copia locale del documento non c’è: riaprilo da Drive per vedere i campi aggiornati.'
  )
  if (result.queued > 0) {
    parts.push(
      `${plural(result.queued, 'altro documento in coda', 'altri documenti in coda')} dello stesso tipo si ${result.queued === 1 ? 'rielabora' : 'rielaborano'} in sottofondo.`
    )
  }
  return parts.join(' ')
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
