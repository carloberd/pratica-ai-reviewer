import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export interface GoogleCredentials {
  clientId: string
  clientSecret: string
}

/**
 * Legge un file `.env` minimale: `CHIAVE=valore`, `#` per i commenti, virgolette
 * opzionali. Basta per le due variabili che servono e non aggiunge dipendenze.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) result[key] = value
  }
  return result
}

/**
 * Percorsi dove cercare il `.env`, in ordine di precedenza:
 * la radice del repo in sviluppo, la cartella dei dati utente nell'app impacchettata.
 */
export function envFileCandidates(): string[] {
  const candidates = [join(app.getPath('userData'), '.env')]
  if (!app.isPackaged) candidates.unshift(join(app.getAppPath(), '.env'))
  return candidates
}

export function loadGoogleCredentials(): GoogleCredentials | null {
  let clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''

  if (!clientId || !clientSecret) {
    for (const candidate of envFileCandidates()) {
      if (!existsSync(candidate)) continue
      const values = parseEnvFile(readFileSync(candidate, 'utf8'))
      clientId = clientId || (values.GOOGLE_CLIENT_ID ?? '')
      clientSecret = clientSecret || (values.GOOGLE_CLIENT_SECRET ?? '')
      if (clientId && clientSecret) break
    }
  }

  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export function setupHint(): string {
  const paths = envFileCandidates().join('  oppure  ')
  return [
    'Credenziali Google non configurate.',
    `Crea un file .env con GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET in: ${paths}`,
    'Le istruzioni per generarle sono nel README, sezione "Setup Google Cloud".'
  ].join(' ')
}
