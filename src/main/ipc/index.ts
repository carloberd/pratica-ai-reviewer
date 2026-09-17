import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { type DatasetManifestInput, datasetFileName } from '@shared/dataset'
import { datasetXlsxFileName } from '@shared/dataset-xlsx'
import { bundleFolderName } from '@shared/profile-bundle'
import { profileReportFileName } from '@shared/profile-report'
import type {
  ActivityFeed,
  ProfileBundleResult,
  ProfileEditOutcome,
  ProfileReportResult,
  ProfileWorkspace,
  TypeRerunResult
} from '@shared/profile-workspace'
import type {
  DatasetExportResult,
  IpcResult,
  RegistryTypeOption,
  XlsxExportResult
} from '@shared/types'
import { ipcMain, type WebContents } from 'electron'
import { z } from 'zod'
import type { AuthService } from '../auth/service'
import { collectDataset, writeDatasetFile } from '../dataset-export'
import type { Repository } from '../db/repository'
import { toStatus } from '../db/rows'
import { createDriveClient, DOCX_MIME, PDF_MIME } from '../drive/client'
import { cacheUsage, type DocumentProcessor, evictCachedFile, fetchDriveFile } from '../drive/fetch'
import { fail, logError, ok, ReviewerError } from '../errors'
import { extractDocxPages } from '../extract/docx'
import type { OcrService } from '../extract/ocr'
import {
  addFieldItem,
  setFieldItemRemoved,
  updateFieldItem,
  updateFieldValue
} from '../field-edits'
import { cachePathFor } from '../paths'
import {
  collectProfileReport,
  collectTypeMeasure,
  collectTypeMeasures,
  writeProfileReportFile
} from '../profile-insights'
import {
  collectActivity,
  editProfileMap,
  exportProfileBundle,
  revertProfileAction
} from '../profile-map'
import { type RefinementDeps, rerunTypeExtraction } from '../profile-refinement'
import { assignDocumentType } from '../reprocess'
import { submitReview } from '../review'
import { collectXlsxRows, writeXlsxFile } from '../xlsx-export'
import {
  addFieldItemSchema,
  documentFiltersSchema,
  documentIdSchema,
  documentRefSchema,
  fetchDriveFileSchema,
  ocrRegionSchema,
  profileActionSchema,
  profileEditSchema,
  profileReportSchema,
  profileTypeSchema,
  removeFieldItemSchema,
  reviewSubmissionSchema,
  searchSchema,
  setTypeSchema,
  updateFieldItemSchema,
  updateFieldSchema
} from './schemas'

/** Canali senza input: accettano `undefined` e nient'altro di significativo. */
const noInput = z.unknown().optional()

export interface IpcContext {
  repo: Repository
  auth: AuthService
  /** Tipi del registry per il menu di assegnazione manuale. */
  registryTypes?: () => RegistryTypeOption[]
  /** Classificazione e precompilazione, eseguita su ogni documento scaricato. */
  process?: DocumentProcessor
  /** Serve anche alla revisione, per leggere un'area evidenziata su una scansione. */
  ocr?: OcrService
  /** Invia gli eventi di avanzamento della sincronizzazione al renderer. */
  sender?: () => WebContents | null
  /** Export del dataset annotato: versioni per il manifest e scelta del file. */
  dataset?: {
    manifest: () => Omit<DatasetManifestInput, 'exportedAt'>
    /** Percorso scelto dal revisore, `null` se annulla. */
    choosePath: (defaultName: string) => Promise<string | null>
    /** Percorso per il foglio di calcolo, con il suo filtro `.xlsx`. */
    chooseXlsxPath: (defaultName: string) => Promise<string | null>
  }
  /**
   * Schermata «Mappa tipi ↔ dati»: misure sui profili, correzioni (che vanno sul
   * database, non sui JSON) e re-run sui documenti annotati. Assente col motore di
   * estrazione v1, che non ha profili da misurare.
   */
  profiles?: {
    /** Tutto quello che serve a misurare, correggere e rielaborare. */
    refinement: Omit<RefinementDeps, 'repo' | 'process'>
    /** Versioni per il manifest del report e dell'export della mappa. */
    manifest: () => { app: { name: string; version: string }; schemaVersion: string | null }
    /** Percorso scelto dal revisore per il report, `null` se annulla. */
    choosePath: (defaultName: string) => Promise<string | null>
    /** Cartella dove scrivere i file della mappa corretta, `null` se annulla. */
    chooseDirectory: (defaultName: string) => Promise<string | null>
  }
}

/**
 * Registra un canale. Il corpo non lancia mai verso il renderer: ogni esito passa
 * dal risultato tipato `{ ok }` e gli errori inattesi finiscono nel log del main,
 * ripuliti dalle credenziali.
 */
function handle<S extends z.ZodType, T>(
  channel: string,
  schema: S,
  work: (input: z.output<S>) => Promise<T> | T
): void {
  ipcMain.handle(channel, async (_event, raw): Promise<IpcResult<T>> => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      const detail = parsed.error.issues[0]?.message ?? 'input non valido'
      return fail(new ReviewerError('INVALID_INPUT', `Richiesta non valida: ${detail}`))
    }
    try {
      return ok(await work(parsed.data))
    } catch (error) {
      logError(channel, error)
      return fail(error)
    }
  })
}

export function registerIpcHandlers(context: IpcContext): void {
  const { repo, auth } = context

  // ---- auth ----------------------------------------------------------------
  handle('auth:status', noInput, () => auth.status())
  handle('auth:login', noInput, () => auth.login())
  handle('auth:logout', noInput, () => auth.logout())

  // ---- drive ---------------------------------------------------------------
  // Solo metadati: l'elenco non scarica niente.
  handle('drive:list', noInput, async () => {
    const drive = createDriveClient(await auth.client())
    const files = await drive.listFiles()
    return files.map((file) => {
      const local = repo.documents.getByDriveFileId(file.id)
      const cached = Boolean(local?.cached_path && existsSync(local.cached_path))
      const stale = Boolean(
        local &&
          file.modifiedTime &&
          (local.received_at === null || file.modifiedTime > local.received_at)
      )
      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        size: file.size,
        documentId: local?.id ?? null,
        cached: cached && !stale,
        stale,
        status: local ? toStatus(local.status) : null
      }
    })
  })

  /** Scarica ed elabora un file solo quando il revisore lo apre davvero. */
  handle('drive:fetch', fetchDriveFileSchema, async ({ driveFileId, force }) => {
    const drive = createDriveClient(await auth.client())
    const files = await drive.listFiles()
    const file = files.find((candidate) => candidate.id === driveFileId)
    if (!file) {
      throw new ReviewerError('NOT_FOUND', 'Il file non è più presente su Google Drive.')
    }

    return fetchDriveFile({
      drive,
      repo,
      file,
      cachePathFor,
      force,
      ...(context.process ? { process: context.process } : {}),
      onProgress: (progress) => {
        const target = context.sender?.()
        if (target && !target.isDestroyed()) target.send('drive:fetch-progress', progress)
      }
    })
  })

  handle('drive:cache-usage', noInput, () => cacheUsage(repo))

  handle('docs:evict', documentIdSchema, async ({ id }) => ({
    freedBytes: await evictCachedFile(repo, id)
  }))

  // ---- documenti -----------------------------------------------------------
  handle('docs:list', documentFiltersSchema, (filters) => repo.listSummaries(filters))

  handle('docs:get', documentIdSchema, ({ id }) => {
    const document = repo.getReviewDocument(id)
    if (!document) throw new ReviewerError('NOT_FOUND', 'Documento non trovato.')
    return document
  })

  handle('docs:stats', noInput, () => ({ kpis: repo.kpis() }))

  handle('docs:types', noInput, () => context.registryTypes?.() ?? [])

  handle('docs:set-type', setTypeSchema, ({ id, documentType }) =>
    assignDocumentType({ repo, documentId: id, documentType, process: context.process })
  )

  // ---- campi e revisione ---------------------------------------------------
  // Solo i campi davvero cambiati diventano una correzione: riscrivere lo stesso valore
  // non deve apparire come intervento del revisore. Le regole stanno in `field-edits`.
  handle('fields:update', updateFieldSchema, (input) => {
    updateFieldValue(repo, input)
    return repo.getReviewDocument(input.documentId)!
  })

  handle('fields:item-add', addFieldItemSchema, (input) => {
    addFieldItem(repo, input)
    return repo.getReviewDocument(input.documentId)!
  })

  handle('fields:item-update', updateFieldItemSchema, (input) => {
    updateFieldItem(repo, input)
    return repo.getReviewDocument(input.documentId)!
  })

  handle('fields:item-remove', removeFieldItemSchema, (input) => {
    setFieldItemRemoved(repo, input)
    return repo.getReviewDocument(input.documentId)!
  })

  // I campi sono già a database — ogni modifica li scrive appena avviene. Qui si
  // registra solo l'esito: dentro o fuori dal dataset, e perché.
  handle('review:submit', reviewSubmissionSchema, ({ documentId, payload }) =>
    submitReview(repo, { documentId, action: payload.action, note: payload.note })
  )

  // ---- dataset annotato ----------------------------------------------------
  handle('dataset:export', noInput, async (): Promise<DatasetExportResult> => {
    if (!context.dataset) {
      throw new ReviewerError('UNSUPPORTED', 'Export non disponibile su questa istanza.')
    }
    const now = new Date()
    const dataset = collectDataset(repo, {
      ...context.dataset.manifest(),
      exportedAt: now.toISOString()
    })
    const { documents, corrections } = dataset.manifest.counts
    if (documents === 0) {
      throw new ReviewerError(
        'NOT_FOUND',
        'Nessun documento da esportare: il dataset contiene solo documenti salvati o scartati.'
      )
    }

    const path = await context.dataset.choosePath(datasetFileName(now))
    if (!path) return { saved: false, path: null, documents, corrections }
    await writeDatasetFile(path, dataset)
    return { saved: true, path, documents, corrections }
  })

  // Lo stesso dataset in forma di foglio di calcolo: due tabelle invece di un JSON
  // annidato. Il formato JSON non cambia — questo è un secondo export, parallelo.
  handle('dataset:export-xlsx', noInput, async (): Promise<XlsxExportResult> => {
    if (!context.dataset) {
      throw new ReviewerError('UNSUPPORTED', 'Export non disponibile su questa istanza.')
    }
    const rows = await collectXlsxRows(repo)
    const documents = rows.documents.length
    const fields = rows.fields.length
    if (documents === 0) {
      throw new ReviewerError(
        'NOT_FOUND',
        'Nessun documento da esportare: il dataset contiene solo documenti salvati o scartati.'
      )
    }

    const path = await context.dataset.chooseXlsxPath(datasetXlsxFileName(new Date()))
    if (!path) return { saved: false, path: null, documents, fields }
    await writeXlsxFile(path, rows)
    return { saved: true, path, documents, fields }
  })

  // ---- istruzioni per tipo -------------------------------------------------
  /**
   * Le misure partono dal database e finiscono in `@shared/profile-metrics`: qui non
   * c'è una sola query, e la schermata riceve numeri già fatti.
   */
  function refinement(): RefinementDeps {
    if (!context.profiles) {
      throw new ReviewerError(
        'UNSUPPORTED',
        'Le istruzioni per tipo esistono solo col motore di estrazione v2.'
      )
    }
    return {
      ...context.profiles.refinement,
      repo,
      ...(context.process ? { process: context.process } : {})
    }
  }

  /** Tutto quello che la schermata mostra, in una risposta sola. */
  function workspace(deps: RefinementDeps): ProfileWorkspace {
    return {
      types: collectTypeMeasures(deps),
      // Tutti i campi dell'ontologia, non solo quelli già visti su un documento: un tipo
      // può avere bisogno di un dato che nessuna annotazione ha ancora prodotto.
      ontology: deps.registry.allFields().map((field) => ({
        id: field.id,
        label: field.label_it,
        hint:
          field.description && field.description !== field.label_it
            ? `${field.id} · ${field.description}`
            : field.id
      })),
      recent: deps.repo.profileMap.listActions(20),
      standingEdits: deps.repo.profileMap.countStandingEdits()
    }
  }

  handle('profiles:list', noInput, (): ProfileWorkspace => workspace(refinement()))

  /**
   * Una correzione alla mappa. Scrive due righe sul database — la decisione e la
   * cronologia — e non tocca nessun file: da qui in poi il motore vede la mappa
   * corretta, e i JSON del registry restano quelli del programmer pack.
   */
  handle(
    'profiles:edit',
    profileEditSchema,
    ({ edit }): { outcome: ProfileEditOutcome; workspace: ProfileWorkspace } => {
      const deps = refinement()
      const action = editProfileMap(deps, edit)
      return {
        outcome: { action, measure: collectTypeMeasure(deps, edit.documentType) },
        workspace: workspace(deps)
      }
    }
  )

  /** Annulla un'azione della cronologia e rimette lo stato che c'era prima. */
  handle(
    'profiles:revert',
    profileActionSchema,
    ({ actionId }): { outcome: ProfileEditOutcome; workspace: ProfileWorkspace } => {
      const deps = refinement()
      const action = revertProfileAction(deps, actionId)
      return {
        outcome: {
          action,
          measure: action.documentType ? collectTypeMeasure(deps, action.documentType) : null
        },
        workspace: workspace(deps)
      }
    }
  )

  handle(
    'profiles:rerun',
    profileTypeSchema,
    async ({ documentType }): Promise<{ rerun: TypeRerunResult; workspace: ProfileWorkspace }> => {
      const deps = refinement()
      const rerun = await rerunTypeExtraction(deps, documentType)
      return { rerun, workspace: workspace(deps) }
    }
  )

  handle(
    'profiles:export',
    profileReportSchema,
    async ({ format }): Promise<ProfileReportResult> => {
      const profiles = context.profiles
      if (!profiles) {
        throw new ReviewerError(
          'UNSUPPORTED',
          'Le istruzioni per tipo esistono solo col motore di estrazione v2.'
        )
      }
      const now = new Date()
      const report = collectProfileReport(refinement(), {
        ...profiles.manifest(),
        exportedAt: now.toISOString()
      })
      const { types, documents } = report.manifest.counts
      if (types === 0) {
        throw new ReviewerError(
          'NOT_FOUND',
          'Nessuna misura da esportare: servono documenti revisionati con un tipo assegnato.'
        )
      }

      const path = await profiles.choosePath(profileReportFileName(now, format))
      if (!path) return { saved: false, path: null, types, documents }
      await writeProfileReportFile(path, report, format)
      return { saved: true, path, types, documents }
    }
  )

  /**
   * I file della mappa corretta, da portare in pratica-ai. È l'unico momento in cui il
   * lavoro del revisore diventa un file, e il file lo scrive dove decide lui.
   */
  handle('profiles:export-map', noInput, async (): Promise<ProfileBundleResult> => {
    const profiles = context.profiles
    if (!profiles) {
      throw new ReviewerError(
        'UNSUPPORTED',
        'La mappa per tipo esiste solo col motore di estrazione v2.'
      )
    }
    const deps = refinement()
    if (repo.profileMap.countStandingEdits() === 0) {
      throw new ReviewerError(
        'NOT_FOUND',
        'Nessuna correzione da esportare: la mappa è ancora quella del registry.'
      )
    }

    const now = new Date()
    const directory = await profiles.chooseDirectory(bundleFolderName(now))
    if (!directory) {
      return { saved: false, directory: null, paths: [], types: 0, fields: 0, edits: 0 }
    }

    const bundle = await exportProfileBundle(
      deps,
      { ...profiles.manifest(), exportedAt: now.toISOString() },
      directory
    )
    return {
      saved: true,
      directory: bundle.directory,
      paths: bundle.paths,
      types: bundle.types,
      fields: bundle.fields,
      edits: bundle.edits
    }
  })

  // ---- cronologia ----------------------------------------------------------
  /** Azioni sulla mappa ed eventi dei documenti, in una lista sola. */
  handle('history:list', noInput, (): ActivityFeed => {
    const deps = refinement()
    return {
      entries: collectActivity(deps),
      standingEdits: repo.profileMap.countStandingEdits()
    }
  })

  // ---- ricerca -------------------------------------------------------------
  handle('search:query', searchSchema, ({ text }) =>
    repo.search.query(text).map((hit) => ({
      documentId: hit.documentId,
      filename: hit.filename,
      page: hit.page,
      snippet: hit.snippet
    }))
  )

  // ---- OCR su richiesta ----------------------------------------------------
  /**
   * Legge il ritaglio di pagina che il revisore ha evidenziato, per compilare un
   * campo. Il ritaglio arriva già rasterizzato dal renderer, che la pagina ce l'ha
   * sotto gli occhi: il main non deve riaprire il PDF per rifare lo stesso lavoro.
   */
  handle('ocr:region', ocrRegionSchema, async ({ image }) => {
    if (!context.ocr) {
      throw new ReviewerError('UNSUPPORTED', 'OCR non disponibile su questa istanza.')
    }
    const bytes = image instanceof Uint8Array ? image : new Uint8Array(image)
    return { text: await context.ocr.recognizeImage(bytes) }
  })

  // ---- file in cache -------------------------------------------------------
  handle('pdf:read', documentRefSchema, async ({ documentId }) => {
    const row = repo.documents.get(documentId)
    if (!row) throw new ReviewerError('NOT_FOUND', 'Documento non trovato.')
    if (!row.cached_path) {
      throw new ReviewerError('NOT_FOUND', 'Il file non è ancora stato scaricato in cache.')
    }
    if (row.mime !== PDF_MIME) {
      throw new ReviewerError('UNSUPPORTED', 'Il documento non è un PDF.')
    }
    const buffer = await readFile(row.cached_path)
    // Copia in un ArrayBuffer proprio: il pool di Buffer di Node non va esposto.
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  })

  handle('docx:text', documentRefSchema, async ({ documentId }) => {
    const row = repo.documents.get(documentId)
    if (!row) throw new ReviewerError('NOT_FOUND', 'Documento non trovato.')
    if (row.mime !== DOCX_MIME)
      throw new ReviewerError('UNSUPPORTED', 'Il documento non è un DOCX.')
    if (!row.cached_path) {
      throw new ReviewerError('NOT_FOUND', 'Il file non è ancora stato scaricato in cache.')
    }
    const pages = await extractDocxPages(row.cached_path)
    return pages.map((page) => page.text).join('\n\n')
  })
}
