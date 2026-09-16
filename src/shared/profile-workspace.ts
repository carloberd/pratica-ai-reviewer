import type { ProfileEdit } from './profile-edit'
import type { MeasureDelta, ProfileTypeMeasure } from './profile-metrics'

/**
 * I contratti della schermata «Istruzioni per tipo»: quello che attraversa il ponte IPC
 * e le frasi che il revisore legge. Nessuna dipendenza da Electron, dal database o da
 * React — la schermata li usa per mostrare, il main per rispondere, i test per
 * verificare che le parole siano quelle.
 */

/** Dove finisce una correzione ai JSON del registry. */
export type ProfileWriteMode =
  /** Scritta e committata: il caso normale, col repo in sviluppo. */
  | 'COMMITTED'
  /** Scritta ma non versionata: la cartella non sta in un repo git, o git ha rifiutato. */
  | 'WRITTEN'
  /** Cartella di sola lettura: il JSON corretto si esporta e si sostituisce a mano. */
  | 'EXPORT_REQUIRED'

export interface ProfileStoreStatus {
  directory: string
  writable: boolean
  repositoryRoot: string | null
  mode: ProfileWriteMode
}

export type ProfileWriteOutcome =
  | { mode: 'COMMITTED'; paths: string[]; commit: string; subject: string }
  | { mode: 'WRITTEN'; paths: string[]; subject: string; reason: string }
  | {
      mode: 'EXPORT_REQUIRED'
      /** I file che sarebbero cambiati, per nome. */
      files: string[]
      /** Dove il revisore li ha salvati; vuoto se ha annullato. */
      exportedTo: string[]
      subject: string
      reason: string
    }

export interface ProfileEditOutcome {
  edit: ProfileEdit
  write: ProfileWriteOutcome
  /** Le misure del tipo dopo la correzione: il profilo è cambiato, i numeri no. */
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

/** Tutto quello che serve alla schermata in una risposta sola. */
export interface ProfileWorkspace {
  types: ProfileTypeMeasure[]
  store: ProfileStoreStatus
}

export interface ProfileReportResult {
  /** `false` se il revisore ha annullato la scelta del file. */
  saved: boolean
  path: string | null
  types: number
  documents: number
}

// ---------------------------------------------------------------------------
// Le frasi che il revisore legge
// ---------------------------------------------------------------------------

/** Cosa succederà alla prossima correzione, detto prima di farla. */
export function describeStore(store: ProfileStoreStatus): string {
  if (store.mode === 'COMMITTED') {
    return 'Ogni correzione riscrive i JSON del registry e ne fa un commit dedicato.'
  }
  if (store.mode === 'WRITTEN') {
    return 'I JSON del registry sono scrivibili ma non versionati: la correzione viene salvata senza commit.'
  }
  return 'La cartella del registry è di sola lettura: la correzione produce il JSON corretto da salvare e sostituire a mano.'
}

/** Com'è andata, una volta fatta. */
export function describeWriteOutcome(outcome: ProfileWriteOutcome): string {
  if (outcome.mode === 'COMMITTED') {
    return `${outcome.subject} — commit ${outcome.commit || 'creato'}.`
  }
  if (outcome.mode === 'WRITTEN') {
    return `${outcome.subject} — salvato senza commit. ${outcome.reason}`
  }
  if (outcome.exportedTo.length === 0) {
    return `${outcome.subject} — export annullato: il registry non è stato modificato. ${outcome.reason}`
  }
  return `${outcome.subject} — JSON corretto salvato in ${outcome.exportedTo.join(', ')}: sostituiscilo a mano in ${outcome.files.join(', ')}. ${outcome.reason}`
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`
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
