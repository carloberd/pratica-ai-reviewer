import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { type DatasetManifestInput, datasetFileName } from '@shared/dataset'
import { datasetBundleFolderName } from '@shared/dataset-bundle'
import { datasetXlsxFileName } from '@shared/dataset-xlsx'
import { isDirectionChoice } from '@shared/document-direction'
import {
  type LearningExportResult,
  type LearningOverview,
  learningBundleFileName
} from '@shared/learning-workspace'
import { bundleFolderName } from '@shared/profile-bundle'
import type { ProfileAction } from '@shared/profile-history'
import type {
  ActivityFeed,
  MapEditResult,
  ProfileBundleResult,
  TypeFieldMap
} from '@shared/profile-workspace'
import type {
  DatasetBundleResult,
  DatasetExportResult,
  IpcResult,
  RegistryTypeOption,
  XlsxExportResult
} from '@shared/types'
import { ipcMain, type WebContents } from 'electron'
import { z } from 'zod'
import type { AuthService } from '../auth/service'
import { exportDatasetBundle } from '../dataset-bundle'
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
import { replayReviews } from '../learning-replay'
import {
  exportLearnedRules,
  type LearningWorkspaceDeps,
  learningOverview,
  rollbackRuleByHand,
  setRuleStatusByHand
} from '../learning-workspace'
import { cachePathFor } from '../paths'
import { collectActivity, exportProfileBundle, revertProfileAction } from '../profile-map'
import {
  documentFieldMap,
  editMapFromDocument,
  type RefinementDeps,
  reprocessQueueOfTemplate,
  reprocessQueueOfType,
  revertMapFromDocument
} from '../profile-refinement'
import { assignDocumentType } from '../reprocess'
import { submitReview } from '../review'
import type { RulesChange } from '../review-learning'
import { collectXlsxRows, writeXlsxFile } from '../xlsx-export'
import {
  addFieldItemSchema,
  companyIdentitySchema,
  documentFiltersSchema,
  documentIdSchema,
  documentRefSchema,
  driveLocationSchema,
  fetchDriveFileSchema,
  learningModeSchema,
  learningRuleSchema,
  learningRuleStatusSchema,
  mapEditSchema,
  mapRevertSchema,
  ocrRegionSchema,
  profileActionSchema,
  removeFieldItemSchema,
  reviewSubmissionSchema,
  searchSchema,
  setDirectionSchema,
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
    /** Cartella dove scrivere dataset e documenti insieme, `null` se annulla. */
    chooseBundleDirectory: (defaultName: string) => Promise<string | null>
  }
  /**
   * Scheda «Campi da estrarre» della revisione: la mappa del tipo del documento, le
   * correzioni (che vanno sul database, non sui JSON) e il loro export. Assente col motore
   * di estrazione v1, che non ha profili da correggere.
   */
  profiles?: {
    /** Tutto quello che serve a misurare, correggere e rielaborare. */
    refinement: Omit<RefinementDeps, 'repo' | 'process'>
    /** Versioni per il manifest dell'export della mappa. */
    manifest: () => { app: { name: string; version: string }; schemaVersion: string | null }
    /** Cartella dove scrivere i file della mappa corretta, `null` se annulla. */
    chooseDirectory: (defaultName: string) => Promise<string | null>
  }
  /** La scheda «Apprendimento»: i nomi dei campi V5.1 per l'export delle regole. */
  learning?: {
    legacyFieldMap: Record<string, string>
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
  // Solo metadati, una cartella per volta: l'elenco non scarica niente.
  handle('drive:list', driveLocationSchema, async (location) => {
    const drive = createDriveClient(await auth.client())
    const { folders, files } = await drive.listFolder(location)
    return {
      folders,
      files: files.map((file) => {
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
    }
  })

  /** Scarica ed elabora un file solo quando il revisore lo apre davvero. */
  handle('drive:fetch', fetchDriveFileSchema, async ({ driveFileId, force }) => {
    const drive = createDriveClient(await auth.client())
    const file = await drive.getFile(driveFileId)
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

  // La direzione non fa rielaborare niente: non è un campo estratto, è una decisione sul
  // documento. Si scrive e si rilegge, e il calcolo resta per confronto.
  handle('docs:set-direction', setDirectionSchema, ({ id, choice }) => {
    if (!repo.documents.get(id)) throw new ReviewerError('NOT_FOUND', 'Documento non trovato.')
    repo.documents.setDirectionChoice(id, isDirectionChoice(choice) ? choice : null)
    return repo.getReviewDocument(id)!
  })

  // ---- impostazioni --------------------------------------------------------
  handle('settings:company', noInput, () => repo.company.get())

  handle('settings:set-company', companyIdentitySchema, (identity) => repo.company.set(identity))

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
  // registra solo l'esito: dentro o fuori dal dataset, e perché. L'account collegato è
  // l'autore delle decisioni che il learner registra; se una regola cambia stato, i
  // documenti in coda del suo tipo si rielaborano in sottofondo.
  handle('review:submit', reviewSubmissionSchema, ({ documentId, payload }) =>
    submitReview(repo, {
      documentId,
      action: payload.action,
      note: payload.note,
      actor: auth.status().email,
      registry: context.profiles?.refinement.registry,
      onRulesChanged: reprocessAfter
    })
  )

  /**
   * Una regola ha cominciato o smesso di valere: i documenti in coda che ne dipendono si
   * rielaborano in sottofondo, per tipo (etichette) o per impronta (memoria dei moduli).
   */
  function reprocessAfter({ documentTypes, templateFingerprints }: RulesChange): void {
    if (!context.profiles || !context.process) return
    const deps = refinement()
    for (const documentType of documentTypes) reprocessQueueOfType(deps, documentType, null)
    for (const fingerprint of templateFingerprints) reprocessQueueOfTemplate(deps, fingerprint)
  }

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

  /**
   * Il dataset **e i documenti da cui è uscito**, in una cartella sola: `dataset.json`,
   * `dataset.xlsx`, una copia dei file chiusi dal revisore e `documenti.json` che lega
   * ogni copia alla sua riga del dataset.
   *
   * È l'export da mandare a chi il dataset lo userà: le evidenze rimandano a pagine e
   * coordinate di file che senza questa cartella restano su questa macchina.
   */
  handle('dataset:export-bundle', noInput, async (): Promise<DatasetBundleResult> => {
    if (!context.dataset) {
      throw new ReviewerError('UNSUPPORTED', 'Export non disponibile su questa istanza.')
    }
    const now = new Date()
    const empty = {
      saved: false as const,
      directory: null,
      documents: 0,
      corrections: 0,
      copied: 0,
      missing: 0,
      mismatched: 0,
      bytes: 0
    }
    // Lo stesso dataset della voce «JSON», raccolto una volta sola: nella cartella ci
    // finisce questo, e da qui si sa già se c'è qualcosa da esportare.
    const dataset = collectDataset(repo, {
      ...context.dataset.manifest(),
      exportedAt: now.toISOString()
    })
    if (dataset.manifest.counts.documents === 0) {
      throw new ReviewerError(
        'NOT_FOUND',
        'Nessun documento da esportare: il dataset contiene solo documenti salvati o scartati.'
      )
    }

    const directory = await context.dataset.chooseBundleDirectory(datasetBundleFolderName(now))
    if (!directory) return empty

    return exportDatasetBundle({ repo, dataset, directory })
  })

  // ---- campi da estrarre ---------------------------------------------------
  function refinement(): RefinementDeps {
    if (!context.profiles) {
      throw new ReviewerError(
        'UNSUPPORTED',
        'I campi da estrarre si correggono solo col motore di estrazione v2.'
      )
    }
    return {
      ...context.profiles.refinement,
      repo,
      ...(context.process ? { process: context.process } : {})
    }
  }

  /** La mappa del tipo del documento aperto, coi numeri dei documenti già revisionati. */
  handle(
    'map:get',
    documentRefSchema,
    ({ documentId }): TypeFieldMap => documentFieldMap(refinement(), documentId)
  )

  /**
   * Una correzione alla mappa dal documento aperto. Scrive la decisione e la cronologia sul
   * database, senza toccare nessun file, e rielabora il documento: la scheda «Dati» riceve
   * già i campi della mappa nuova.
   */
  handle(
    'map:edit',
    mapEditSchema,
    ({ documentId, edit }): Promise<MapEditResult> =>
      editMapFromDocument(refinement(), documentId, edit)
  )

  /** Annulla una correzione dal documento aperto, e lo rielabora con la mappa di prima. */
  handle(
    'map:revert',
    mapRevertSchema,
    ({ documentId, actionId }): Promise<MapEditResult> =>
      revertMapFromDocument(refinement(), documentId, actionId)
  )

  /**
   * Annulla un'azione dalla Cronologia, fuori da un documento: la mappa torna com'era e i
   * documenti in coda di quel tipo si rielaborano in sottofondo.
   */
  handle('profiles:revert', profileActionSchema, ({ actionId }): ProfileAction => {
    const deps = refinement()
    const action = revertProfileAction(deps, actionId)
    if (action.documentType) reprocessQueueOfType(deps, action.documentType, null)
    return action
  })

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

  // ---- apprendimento --------------------------------------------------------
  function learning(): LearningWorkspaceDeps {
    const registry = context.profiles?.refinement.registry
    const typeLabel = context.profiles?.refinement.typeLabel
    return {
      repo,
      names: {
        typeLabel: (documentType) => typeLabel?.(documentType) ?? null,
        fieldLabel: (fieldId) => registry?.field(fieldId)?.label_it ?? null
      }
    }
  }

  /** Modalità, contatori, regole e cronologia del learner. */
  handle('learning:overview', noInput, (): LearningOverview => learningOverview(learning()))

  /**
   * Cambia modalità. Non rielabora niente: vale dai documenti elaborati da adesso, e i
   * documenti già precompilati restano come il revisore li ha visti.
   */
  handle('learning:set-mode', learningModeSchema, ({ mode }): LearningOverview => {
    repo.learning.setMode(mode)
    return learningOverview(learning())
  })

  /** Sospende, riattiva o scarta una regola, e rielabora la coda che ne dipende. */
  handle(
    'learning:set-rule-status',
    learningRuleStatusSchema,
    ({ ruleId, status }): LearningOverview => {
      const { change } = setRuleStatusByHand(learning(), ruleId, status)
      reprocessAfter(change)
      return learningOverview(learning())
    }
  )

  /**
   * Annulla l'ultimo cambio di stato ancora in vigore su una regola, e rielabora la coda
   * che ne dipende: una regola che torna a valere, o che smette, cambia la precompilazione
   * dei documenti in attesa esattamente come un cambio di stato a mano.
   */
  handle('learning:rollback-rule', learningRuleSchema, ({ ruleId }): LearningOverview => {
    const { change } = rollbackRuleByHand(learning(), ruleId)
    reprocessAfter(change)
    return learningOverview(learning())
  })

  /**
   * Ripassa per il learner le revisioni già chiuse.
   *
   * Il learner è stato acceso a revisione iniziata, e quello che le chiusure di prima
   * avrebbero insegnato non gliel'ha mai visto nessuno. È idempotente — ogni documento
   * ritira le sue prove prima di rimetterle — quindi si può rilanciare.
   */
  handle('learning:replay', noInput, (): LearningOverview => {
    const actor = auth.status().email
    if (!actor) {
      throw new ReviewerError('AUTH_REQUIRED', 'Nessun account collegato: non si sa chi ripassa.')
    }
    const result = replayReviews({
      repo,
      actor,
      registry: context.profiles?.refinement.registry
    })
    reprocessAfter(result.changed)
    return learningOverview(learning())
  })

  /** Il file delle regole apprese, per pratica-ai. */
  handle('learning:export', noInput, async (): Promise<LearningExportResult> => {
    if (!context.dataset) {
      throw new ReviewerError('UNSUPPORTED', 'Export non disponibile su questa istanza.')
    }
    const now = new Date()
    const path = await context.dataset.choosePath(learningBundleFileName(now))
    if (!path) return { saved: false, path: null, rules: 0, events: 0 }
    return exportLearnedRules(
      {
        ...learning(),
        legacyFieldMap: context.learning?.legacyFieldMap ?? {},
        app: context.dataset.manifest().app
      },
      path,
      now
    )
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
