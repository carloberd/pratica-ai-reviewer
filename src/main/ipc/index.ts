import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IpcResult, RegistryTypeOption } from '@shared/types'
import { ipcMain, type WebContents } from 'electron'
import { z } from 'zod'
import type { AuthService } from '../auth/service'
import type { Repository } from '../db/repository'
import { toStatus } from '../db/rows'
import { createDriveClient, DOCX_MIME, PDF_MIME } from '../drive/client'
import { cacheUsage, type DocumentProcessor, evictCachedFile, fetchDriveFile } from '../drive/fetch'
import { fail, logError, ok, ReviewerError } from '../errors'
import { extractDocxPages } from '../extract/docx'
import type { OcrService } from '../extract/ocr'
import { cachePathFor } from '../paths'
import { assignDocumentType } from '../reprocess'
import { buildReviewPayload, describeReview, statusForAction } from '../review'
import {
  documentFiltersSchema,
  documentIdSchema,
  documentRefSchema,
  fetchDriveFileSchema,
  ocrRegionSchema,
  reviewSubmissionSchema,
  searchSchema,
  setTypeSchema,
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
  handle('fields:update', updateFieldSchema, ({ documentId, fieldId, correctedValue }) => {
    const field = repo.fields.get(fieldId)
    if (!field || field.document_id !== documentId) {
      throw new ReviewerError('NOT_FOUND', 'Campo non trovato su questo documento.')
    }

    // Solo i campi davvero cambiati diventano una correzione: riscrivere lo stesso
    // valore non deve apparire come intervento del revisore.
    const trimmed = correctedValue?.trim() ?? null
    const next = trimmed === null || trimmed === (field.value ?? '') ? null : trimmed
    repo.fields.setCorrectedValue(fieldId, next)

    return repo.getReviewDocument(documentId)!
  })

  handle('review:submit', reviewSubmissionSchema, ({ documentId, payload }) => {
    const document = repo.getReviewDocument(documentId)
    if (!document) throw new ReviewerError('NOT_FOUND', 'Documento non trovato.')

    // I campi sono già a database — `fields:update` li scrive appena vengono toccati.
    // Qui si registra solo l'esito: dentro o fuori dal dataset, e perché.
    const full = buildReviewPayload(document, payload.action, payload.note)
    const { title, detail } = describeReview(full)

    repo.transaction(() => {
      repo.documents.setStatus(documentId, statusForAction(payload.action))
      repo.events.add(documentId, title, detail)
    })

    return repo.getReviewDocument(documentId)!
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
