import type { FieldSignal, ProfileTypeMeasure } from './profile-metrics'

/**
 * Il report d'insieme: tutte le misure per tipo e per campo in un file solo, da mandare
 * al collega che annota o da conservare accanto al dataset esportato.
 *
 * Due formati perché servono a due cose: il JSON per rimetterlo in pancia a uno script,
 * il CSV per aprirlo in un foglio di calcolo e ordinarlo per colonna. Stesso contenuto.
 */

export const PROFILE_REPORT_FORMAT = 'praticaai-reviewer/profile-metrics'
export const PROFILE_REPORT_FORMAT_VERSION = '1.0.0'

export type ProfileReportFormat = 'json' | 'csv'

export interface ProfileReportManifest {
  format: typeof PROFILE_REPORT_FORMAT
  formatVersion: typeof PROFILE_REPORT_FORMAT_VERSION
  exportedAt: string
  app: { name: string; version: string }
  /** Versione dei profili misurati: due report si confrontano solo a parità di questa. */
  schemaVersion: string | null
  counts: { types: number; documents: number; fields: number }
}

export interface ProfileReport {
  manifest: ProfileReportManifest
  types: ProfileTypeMeasure[]
}

export type ProfileReportManifestInput = Pick<
  ProfileReportManifest,
  'exportedAt' | 'app' | 'schemaVersion'
>

export function buildProfileReport(
  manifest: ProfileReportManifestInput,
  types: ProfileTypeMeasure[]
): ProfileReport {
  return {
    manifest: {
      format: PROFILE_REPORT_FORMAT,
      formatVersion: PROFILE_REPORT_FORMAT_VERSION,
      ...manifest,
      counts: {
        types: types.length,
        documents: types.reduce((total, type) => total + type.totals.documents, 0),
        fields: types.reduce((total, type) => total + type.fields.length, 0)
      }
    },
    types
  }
}

/** JSON leggibile, una chiave per riga: il file si apre e si confronta a occhio. */
export function serializeProfileReport(report: ProfileReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/** Le stesse parole della schermata: chi apre il CSV non deve tradurre niente. */
export const SIGNAL_LABELS: Record<FieldSignal, string> = {
  OK: '',
  NEVER_USED: 'mai usato',
  MISSING_FROM_PROFILE: 'assente dal profilo',
  EXCLUDED: 'segnato non utile'
}

const CSV_COLUMNS = [
  'tipo_documento',
  'nome_tipo',
  'profilo',
  'verificato_su_documenti_reali',
  'documenti_annotati',
  'campo',
  'nome_campo',
  'ruolo',
  'nel_profilo',
  'confermati',
  'corretti',
  'a_mano',
  'vuoti',
  'quota_confermati',
  'quota_corretti',
  'quota_a_mano',
  'segnale',
  'decisione_revisore'
] as const

/** Virgolette raddoppiate e campo quotato quando serve: il CSV di RFC 4180. */
function csvCell(value: string | number | boolean): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'sì' : 'no'
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * Una riga per coppia tipo/campo. I tipi senza campi misurati restano fuori: una riga
 * senza campo non direbbe niente che il conteggio dei documenti non dica già.
 */
export function profileReportCsv(types: ProfileTypeMeasure[]): string {
  const rows: string[] = [CSV_COLUMNS.join(',')]

  for (const type of types) {
    for (const field of type.fields) {
      rows.push(
        [
          type.documentType,
          type.label ?? '',
          type.profileOrigin,
          type.fieldTested,
          type.totals.documents,
          field.fieldId,
          field.label,
          field.role ?? '',
          field.inProfile,
          field.confirmed,
          field.corrected,
          field.manual,
          field.empty,
          field.confirmedRate,
          field.correctedRate,
          field.manualRate,
          SIGNAL_LABELS[field.signal],
          field.decision ?? ''
        ]
          .map(csvCell)
          .join(',')
      )
    }
  }

  return `${rows.join('\n')}\n`
}

/** Nome proposto per il file: `praticaai-profili-2026-09-16.csv`. */
export function profileReportFileName(now: Date, format: ProfileReportFormat): string {
  return `praticaai-profili-${now.toISOString().slice(0, 10)}.${format}`
}
