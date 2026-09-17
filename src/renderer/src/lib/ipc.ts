import type { ProfileEdit } from '@shared/profile-edit'
import type { DocumentPick, DriveLocation, IpcErrorCode, ReviewAction } from '@shared/types'

/**
 * Il main risponde sempre con `{ ok: true, data }` oppure `{ ok: false, error }`:
 * niente eccezioni attraverso il ponte, dove un `Error` verrebbe clonato a metà.
 * Qui il risultato torna a essere un'eccezione normale, dentro il renderer.
 */
export class ReviewerClientError extends Error {
  readonly code: IpcErrorCode

  constructor(code: IpcErrorCode, message: string) {
    super(message)
    this.name = 'ReviewerClientError'
    this.code = code
  }
}

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

export async function call<T>(invoke: () => Promise<Result<T>>): Promise<T> {
  const result = await invoke()
  if (result.ok) return result.data
  throw new ReviewerClientError(result.error.code as IpcErrorCode, result.error.message)
}

export function errorMessage(error: unknown): string {
  if (error instanceof ReviewerClientError) return error.message
  if (error instanceof Error) return error.message
  return 'Errore imprevisto.'
}

/** `true` quando l'errore si risolve solo rifacendo il login. */
export function needsLogin(error: unknown): boolean {
  return error instanceof ReviewerClientError && error.code === 'AUTH_REQUIRED'
}

export const api = {
  auth: {
    status: () => call(() => window.reviewer.auth.status()),
    login: () => call(() => window.reviewer.auth.login()),
    logout: () => call(() => window.reviewer.auth.logout())
  },
  docs: {
    list: (filters?: Parameters<typeof window.reviewer.docs.list>[0]) =>
      call(() => window.reviewer.docs.list(filters)),
    get: (id: string) => call(() => window.reviewer.docs.get(id)),
    stats: () => call(() => window.reviewer.docs.stats()),
    types: () => call(() => window.reviewer.docs.types()),
    setType: (id: string, documentType: string | null) =>
      call(() => window.reviewer.docs.setType(id, documentType)),
    evict: (id: string) => call(() => window.reviewer.docs.evict(id))
  },
  fields: {
    update: (
      documentId: string,
      fieldId: string,
      correctedValue: string | null,
      pick?: DocumentPick
    ) =>
      call(() =>
        window.reviewer.fields.update({
          documentId,
          fieldId,
          correctedValue,
          ...(pick ? { pick } : {})
        })
      ),
    addItem: (documentId: string, fieldId: string, value: string, pick?: DocumentPick) =>
      call(() =>
        window.reviewer.fields.addItem({ documentId, fieldId, value, ...(pick ? { pick } : {}) })
      ),
    updateItem: (
      documentId: string,
      itemId: string,
      correctedValue: string | null,
      pick?: DocumentPick
    ) =>
      call(() =>
        window.reviewer.fields.updateItem({
          documentId,
          itemId,
          correctedValue,
          ...(pick ? { pick } : {})
        })
      ),
    removeItem: (documentId: string, itemId: string, removed: boolean) =>
      call(() => window.reviewer.fields.removeItem({ documentId, itemId, removed }))
  },
  dataset: {
    export: () => call(() => window.reviewer.dataset.export()),
    exportXlsx: () => call(() => window.reviewer.dataset.exportXlsx())
  },
  map: {
    get: (documentId: string) => call(() => window.reviewer.map.get(documentId)),
    edit: (documentId: string, edit: ProfileEdit) =>
      call(() => window.reviewer.map.edit(documentId, edit)),
    revert: (documentId: string, actionId: string) =>
      call(() => window.reviewer.map.revert(documentId, actionId))
  },
  profiles: {
    revert: (actionId: string) => call(() => window.reviewer.profiles.revert(actionId)),
    exportMap: () => call(() => window.reviewer.profiles.exportMap())
  },
  history: {
    list: () => call(() => window.reviewer.history.list())
  },
  review: {
    submit: (documentId: string, action: ReviewAction, note?: string) =>
      call(() =>
        window.reviewer.review.submit({
          documentId,
          payload: { action, ...(note ? { note } : {}) }
        })
      )
  },
  drive: {
    list: (location: DriveLocation) => call(() => window.reviewer.drive.list(location)),
    fetch: (driveFileId: string, options?: { force?: boolean }) =>
      call(() => window.reviewer.drive.fetch(driveFileId, options)),
    cacheUsage: () => call(() => window.reviewer.drive.cacheUsage())
  },
  search: {
    query: (text: string) => call(() => window.reviewer.search.query(text))
  },
  pdf: {
    read: (documentId: string) => call(() => window.reviewer.pdf.read(documentId))
  },
  docx: {
    text: (documentId: string) => call(() => window.reviewer.docx.text(documentId))
  },
  ocr: {
    region: (image: Uint8Array) => call(() => window.reviewer.ocr.region(image))
  }
}
