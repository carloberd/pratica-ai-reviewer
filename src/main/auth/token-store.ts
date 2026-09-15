import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import { ReviewerError } from '../errors'

export interface StoredSession {
  refreshToken: string
  email: string | null
  /** Solo per mostrare in UI da quando la sessione è attiva. */
  createdAt: string
}

/**
 * D1: il refresh token vive solo qui, cifrato con `safeStorage` (Keychain su macOS,
 * DPAPI su Windows) e scritto in `userData/tokens.bin`. Non passa mai dal renderer,
 * non finisce mai in un log e non viene mai esposto su un canale IPC.
 */
export interface TokenStore {
  read(): StoredSession | null
  write(session: StoredSession): void
  clear(): void
  readonly available: boolean
  readonly file: string
}

export function createTokenStore(file = join(app.getPath('userData'), 'tokens.bin')): TokenStore {
  return {
    file,

    get available() {
      return safeStorage.isEncryptionAvailable()
    },

    read(): StoredSession | null {
      if (!existsSync(file)) return null
      if (!safeStorage.isEncryptionAvailable()) {
        throw new ReviewerError(
          'AUTH_FAILED',
          'Il portachiavi di sistema non è disponibile: impossibile leggere la sessione salvata.'
        )
      }
      try {
        const plain = safeStorage.decryptString(readFileSync(file))
        const parsed = JSON.parse(plain) as Partial<StoredSession>
        if (typeof parsed.refreshToken !== 'string' || parsed.refreshToken.length === 0) return null
        return {
          refreshToken: parsed.refreshToken,
          email: typeof parsed.email === 'string' ? parsed.email : null,
          createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : ''
        }
      } catch {
        // File corrotto o cifrato con un'altra chiave: si riparte da un login pulito.
        rmSync(file, { force: true })
        return null
      }
    },

    write(session: StoredSession): void {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new ReviewerError(
          'AUTH_FAILED',
          'Il portachiavi di sistema non è disponibile: la sessione non può essere salvata in modo sicuro.'
        )
      }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, safeStorage.encryptString(JSON.stringify(session)), { mode: 0o600 })
    },

    clear(): void {
      rmSync(file, { force: true })
    }
  }
}
