import type { IpcErrorCode } from '@shared/types'

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
      call(() => window.reviewer.docs.setType(id, documentType))
  },
  drive: {
    sync: () => call(() => window.reviewer.drive.sync())
  },
  search: {
    query: (text: string) => call(() => window.reviewer.search.query(text))
  },
  pdf: {
    read: (documentId: string) => call(() => window.reviewer.pdf.read(documentId))
  }
}
