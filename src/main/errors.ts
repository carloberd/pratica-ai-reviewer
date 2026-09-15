import type { IpcError, IpcErrorCode, IpcResult } from '@shared/types'

/** Errore applicativo con un codice che il renderer può trattare. */
export class ReviewerError extends Error {
  readonly code: IpcErrorCode

  constructor(code: IpcErrorCode, message: string) {
    super(message)
    this.name = 'ReviewerError'
    this.code = code
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /ya29\.[\w.-]+/g, // access token Google
  /1\/\/[\w-]{20,}/g, // refresh token Google
  /\b[\w-]{20,}\.apps\.googleusercontent\.com\b/g, // client id
  /GOCSPX-[\w-]+/g, // client secret Google
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g // JWT / id_token
]

/**
 * Toglie dai messaggi tutto ciò che somiglia a una credenziale.
 *
 * Gli errori di googleapis riportano volentieri la richiesta che li ha generati, e
 * quella richiesta contiene il token: qui non deve passare, né verso il renderer né
 * verso il log.
 */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[redatto]'), text)
}

export function toIpcError(error: unknown): IpcError {
  if (error instanceof ReviewerError) {
    return { code: error.code, message: redact(error.message) }
  }
  if (error instanceof Error) {
    return { code: 'INTERNAL', message: redact(error.message) }
  }
  return { code: 'INTERNAL', message: 'Errore imprevisto.' }
}

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

export function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: toIpcError(error) }
}

/** Log del main, sempre ripulito dalle credenziali. */
export function logError(scope: string, error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error(`[${scope}] ${redact(message)}`)
}
