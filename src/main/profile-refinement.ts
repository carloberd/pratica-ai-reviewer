import { existsSync } from 'node:fs'
import {
  applyProfileEdit,
  type ProfileEdit,
  ProfileEditError,
  type ProfileEditReason,
  type RawProfile
} from '@shared/profile-edit'
import { measureDelta, type ProfileTypeMeasure } from '@shared/profile-metrics'
import type {
  ProfileEditOutcome,
  ProfileWriteOutcome,
  SkippedDocument,
  TypeRerunResult
} from '@shared/profile-workspace'
import type { Repository } from './db/repository'
import type { DocumentProcessor } from './drive/fetch'
import { logError, ReviewerError } from './errors'
import type { ReloadableExtractionRegistryV2 } from './extract/v2/profile-loader'
import { collectTypeMeasure } from './profile-insights'
import {
  type ChangedFile,
  HINTS_FILE,
  PROFILES_FILE,
  type ProfileWriteResult,
  readRegistrySourceFiles,
  serializeRegistryJson,
  writeProfileFiles
} from './profile-store'

/**
 * Il ciclo completo di una correzione: i numeri dicono cosa non va, la correzione va sui
 * JSON sorgente, il re-run sui documenti già annotati mostra se è servita.
 *
 * Qui si mette insieme quello che gli altri moduli fanno da soli — misurare
 * (`profile-insights`), correggere (`@shared/profile-edit`), scrivere e committare
 * (`profile-store`) — e si rilegge il registry, senza il quale il re-run girerebbe con i
 * profili caricati all'avvio.
 */

export interface RefinementDeps {
  repo: Repository
  registry: ReloadableExtractionRegistryV2
  /** `resources/registry/v2`: dove stanno i JSON da correggere. */
  registryDirectory: string
  typeLabel?: (documentType: string) => string | null
  /** Classificazione e precompilazione: serve solo al re-run. */
  process?: DocumentProcessor | undefined
  /**
   * Dove salvare un JSON corretto quando la cartella del registry è di sola lettura.
   * Restituisce il percorso scelto, `null` se il revisore annulla.
   */
  exportFile?: (file: ChangedFile) => Promise<string | null>
  fileExists?: (path: string) => boolean
}

const NO_NUMBERS: ProfileEditReason = { documents: 0, confirmed: 0, corrected: 0, manual: 0 }

/** I numeri di quel campo su quel tipo, come finiranno nel messaggio del commit. */
export function reasonFor(measure: ProfileTypeMeasure | null, fieldId: string): ProfileEditReason {
  if (!measure) return NO_NUMBERS
  const field = measure.fields.find((candidate) => candidate.fieldId === fieldId)
  return {
    documents: measure.totals.documents,
    confirmed: field?.confirmed ?? 0,
    corrected: field?.corrected ?? 0,
    manual: field?.manual ?? 0
  }
}

/**
 * Applica una correzione al profilo di un tipo e la versiona.
 *
 * Il profilo di un tipo `LEGACY_FALLBACK` non sta nel file: alla prima correzione viene
 * materializzato a partire da quello sintetizzato dal caricatore, marcato come schema
 * non verificato. Correggerlo resta possibile, ma resta anche visibile che non è uno
 * schema costruito su documenti reali.
 */
export async function editTypeProfile(
  deps: RefinementDeps,
  edit: ProfileEdit
): Promise<ProfileEditOutcome> {
  const measure = collectTypeMeasure(deps, edit.documentType)
  const source = readRegistrySourceFiles(deps.registryDirectory)
  const spec = deps.registry.field(edit.fieldId)
  const synthesized = deps.registry.profile(edit.documentType)

  let result: ReturnType<typeof applyProfileEdit>
  try {
    result = applyProfileEdit({
      profiles: source.profiles,
      hints: source.hints,
      edit,
      reason: reasonFor(measure, edit.fieldId),
      field: spec ? { label: spec.label_it, aliases: spec.label_aliases_it } : null,
      fallbackProfile:
        source.profiles.profiles[edit.documentType] || !synthesized
          ? null
          : (synthesized as unknown as RawProfile)
    })
  } catch (error) {
    if (error instanceof ProfileEditError) {
      throw new ReviewerError('INVALID_INPUT', error.message)
    }
    throw error
  }

  const files = [
    ...(result.changedProfiles
      ? [{ name: PROFILES_FILE, content: serializeRegistryJson(result.profiles) }]
      : []),
    ...(result.changedHints
      ? [{ name: HINTS_FILE, content: serializeRegistryJson(result.hints) }]
      : [])
  ]

  const written = writeProfileFiles({
    directory: deps.registryDirectory,
    files,
    commit: result.commit
  })
  const write = await handleExport(deps, written)

  // Senza rilettura il motore continuerebbe a usare i profili caricati all'avvio, e il
  // re-run non mostrerebbe nessun delta. Con l'export il disco non è cambiato.
  if (write.mode !== 'EXPORT_REQUIRED') {
    try {
      deps.registry.reload()
    } catch (error) {
      logError('profiles.reload', error)
      throw new ReviewerError(
        'INTERNAL',
        `I JSON sono stati scritti (${write.subject}) ma il motore non è riuscito a rileggerli: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  return { edit, write, measure: collectTypeMeasure(deps, edit.documentType) }
}

/**
 * Il contenuto dei JSON non attraversa il ponte IPC: quasi un megabyte per un'anteprima
 * che nessuno guarderebbe. Con la cartella di sola lettura il file si salva qui, dove
 * sceglie il revisore, e alla schermata arrivano solo i percorsi.
 */
async function handleExport(
  deps: RefinementDeps,
  result: ProfileWriteResult
): Promise<ProfileWriteOutcome> {
  if (result.mode !== 'EXPORT_REQUIRED') return result

  const files = result.files.map((file) => file.name)
  const exportedTo: string[] = []
  for (const file of result.files) {
    const path = await deps.exportFile?.(file)
    // Annullare il primo file annulla tutta la correzione: mezza correzione sul disco
    // sarebbe peggio di nessuna.
    if (!path) break
    exportedTo.push(path)
  }

  return {
    mode: 'EXPORT_REQUIRED',
    files,
    exportedTo,
    subject: result.subject,
    reason: result.reason
  }
}

// ---------------------------------------------------------------------------
// Re-run e delta
// ---------------------------------------------------------------------------

/**
 * Rilancia l'estrazione sui documenti già annotati di un tipo e confronta i numeri.
 *
 * Solo `REVIEWED` e solo dalla cache: nessun file viene riscaricato. Le correzioni umane
 * sopravvivono perché è la pipeline di sempre a rielaborare — `replaceForDocument` tiene
 * le correzioni per nome del campo, esattamente come quando si cambia tipo a mano.
 *
 * Un errore su un documento non ferma gli altri: finisce nel log e nella lista dei
 * falliti, e il delta si calcola su quello che è passato.
 */
export async function rerunTypeExtraction(
  deps: RefinementDeps,
  documentType: string
): Promise<TypeRerunResult> {
  if (!deps.process) {
    throw new ReviewerError('UNSUPPORTED', 'Rielaborazione non disponibile su questa istanza.')
  }

  const before = collectTypeMeasure(deps, documentType)
  if (!before) {
    throw new ReviewerError(
      'NOT_FOUND',
      `Nessun documento annotato di tipo «${documentType}»: non c'è niente da rielaborare.`
    )
  }

  const fileExists = deps.fileExists ?? existsSync
  const processed: string[] = []
  const skipped: SkippedDocument[] = []
  const failed: SkippedDocument[] = []

  for (const row of deps.repo.documents.list({ status: 'REVIEWED', documentType })) {
    if (!row.cached_path || !fileExists(row.cached_path)) {
      skipped.push({
        documentId: row.id,
        filename: row.filename,
        reason: 'la copia locale non c’è più: riaprilo da Drive per rielaborarlo.'
      })
      continue
    }
    try {
      await deps.process({
        documentId: row.id,
        cachedPath: row.cached_path,
        mime: row.mime,
        filename: row.filename
      })
      processed.push(row.id)
    } catch (error) {
      logError('profiles.rerun', error)
      failed.push({
        documentId: row.id,
        filename: row.filename,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const retyped = processed.filter(
    (documentId) => deps.repo.documents.get(documentId)?.document_type !== documentType
  )

  const after = collectTypeMeasure(deps, documentType) ?? {
    ...before,
    fields: [],
    documents: [],
    totals: { ...before.totals, documents: 0 }
  }

  return {
    documentType,
    processed,
    skipped,
    failed,
    retyped,
    before,
    after,
    delta: measureDelta(before, after)
  }
}
