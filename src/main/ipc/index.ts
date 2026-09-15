import { readFile } from 'node:fs/promises'
import type { IpcResult, RegistryTypeOption } from '@shared/types'
import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { z } from 'zod'
import type { AuthService } from '../auth/service'
import type { Repository } from '../db/repository'
import { toAnnotation } from '../db/rows'
import { createDriveClient, DOCX_MIME, PDF_MIME } from '../drive/client'
import { type DocumentProcessor, syncDrive } from '../drive/sync'
import { fail, logError, ok, ReviewerError } from '../errors'
import { exportAnnotatedPdf, writeAnnotatedPdf } from '../export/annotated-pdf'
import { extractDocxPages } from '../extract/docx'
import { cachePathFor } from '../paths'
import { buildReviewPayload, describeReview } from '../review'
import {
  addAnnotationSchema,
  documentFiltersSchema,
  documentIdSchema,
  documentRefSchema,
  reviewPayloadSchema,
  searchSchema,
  setTypeSchema,
  updateAnnotationSchema,
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
  handle('drive:list', noInput, async () => {
    const drive = createDriveClient(await auth.client())
    const files = await drive.listFiles()
    return files.map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime,
      size: file.size,
      known: repo.documents.getByDriveFileId(file.id) !== undefined
    }))
  })

  handle('drive:sync', noInput, async () => {
    const drive = createDriveClient(await auth.client())
    return syncDrive({
      drive,
      repo,
      cachePathFor,
      ...(context.process ? { process: context.process } : {}),
      onProgress: (progress) => {
        const target = context.sender?.()
        if (target && !target.isDestroyed()) target.send('drive:sync-progress', progress)
      }
    })
  })

  // ---- documenti -----------------------------------------------------------
  handle('docs:list', documentFiltersSchema, (filters) => repo.listSummaries(filters))

  handle('docs:get', documentIdSchema, ({ id }) => {
    const document = repo.getReviewDocument(id)
    if (!document) throw new ReviewerError('NOT_FOUND', 'Documento non trovato.')
    return document
  })

  handle('docs:stats', noInput, () => ({ kpis: repo.kpis() }))

  handle('docs:types', noInput, () => context.registryTypes?.() ?? [])

  handle('docs:set-type', setTypeSchema, ({ id, documentType }) => {
    const existing = repo.documents.get(id)
    if (!existing) throw new ReviewerError('NOT_FOUND', 'Documento non trovato.')

    repo.transaction(() => {
      // Assegnazione manuale: la confidence del tipo resta nulla, perché non viene
      // da un match del registry ma da una decisione del revisore.
      repo.documents.setType(id, documentType, null)
      repo.events.add(
        id,
        documentType ? 'Tipo assegnato a mano' : 'Tipo rimosso',
        documentType
          ? `Il revisore ha impostato il tipo «${documentType}».`
          : 'Il revisore ha rimosso il tipo assegnato.'
      )
    })

    return repo.getReviewDocument(id)!
  })

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

  handle('review:submit', reviewPayloadSchema, ({ documentId, payload }) => {
    const document = repo.getReviewDocument(documentId)
    if (!document) throw new ReviewerError('NOT_FOUND', 'Documento non trovato.')

    const full = buildReviewPayload(document, payload.decision, payload.note)
    const { title, detail } = describeReview(full)

    repo.transaction(() => {
      repo.documents.setStatus(documentId, payload.decision === 'REJECT' ? 'REJECTED' : 'APPROVED')
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

  // ---- annotazioni ---------------------------------------------------------
  // D3: vivono in SQLite e non toccano mai il PDF in cache, che resta identico al
  // file su Drive byte per byte.
  handle('annotations:list', documentRefSchema, ({ documentId }) =>
    repo.listAnnotations(documentId)
  )

  handle('annotations:add', addAnnotationSchema, (input) => {
    const document = repo.documents.get(input.documentId)
    if (!document) throw new ReviewerError('NOT_FOUND', 'Documento non trovato.')
    if (document.mime !== PDF_MIME) {
      throw new ReviewerError('UNSUPPORTED', 'Le annotazioni sono disponibili solo sui PDF.')
    }
    return toAnnotation(
      repo.annotations.add({
        documentId: input.documentId,
        page: input.page,
        bbox: input.bbox,
        kind: input.kind,
        note: input.note
      })
    )
  })

  handle('annotations:update', updateAnnotationSchema, ({ id, bbox, note }) => {
    const updated = repo.annotations.update(id, {
      ...(bbox ? { bbox } : {}),
      ...(note !== undefined ? { note } : {})
    })
    if (!updated) throw new ReviewerError('NOT_FOUND', 'Annotazione non trovata.')
    return toAnnotation(updated)
  })

  handle('annotations:delete', documentIdSchema, ({ id }) => {
    if (!repo.annotations.delete(id)) {
      throw new ReviewerError('NOT_FOUND', 'Annotazione non trovata.')
    }
    return { id }
  })

  handle('annotations:export', documentRefSchema, async ({ documentId }) => {
    const row = repo.documents.get(documentId)
    if (!row) throw new ReviewerError('NOT_FOUND', 'Documento non trovato.')
    if (row.mime !== PDF_MIME) {
      throw new ReviewerError('UNSUPPORTED', 'Solo i PDF possono essere esportati annotati.')
    }
    if (!row.cached_path) {
      throw new ReviewerError('NOT_FOUND', 'Il file non è ancora stato scaricato in cache.')
    }

    const suggested = `${row.filename.replace(/\.pdf$/i, '')} - annotato.pdf`
    const parent = context.sender?.() ? BrowserWindow.fromWebContents(context.sender()!) : null
    const choice = await (parent
      ? dialog.showSaveDialog(parent, {
          defaultPath: suggested,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        })
      : dialog.showSaveDialog({
          defaultPath: suggested,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        }))

    if (choice.canceled || !choice.filePath) return { path: null }

    const bytes = await exportAnnotatedPdf(
      row.cached_path,
      repo.listAnnotations(documentId),
      row.filename
    )
    await writeAnnotatedPdf(choice.filePath, bytes)
    repo.events.add(
      documentId,
      'PDF annotato esportato',
      `Copia con le annotazioni salvata in «${choice.filePath}». Il file in cache non è stato modificato.`
    )
    return { path: choice.filePath }
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
