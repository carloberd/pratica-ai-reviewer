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
 *
 * Fuori da Electron (i test del livello auth) `app` non esiste: in quel caso restano
 * solo le variabili d'ambiente, che è esattamente quello che serve.
 */
export function envFileCandidates(): string[] {
  if (!app?.getPath) return []
  const candidates = [join(app.getPath('userData'), '.env')]
  if (!app.isPackaged) candidates.unshift(join(app.getAppPath(), '.env'))
  return candidates
}

/**
 * Credenziali cucite nel bundle a build time da `electron.vite.config.ts`, prese
 * dall'ambiente di compilazione (in CI, dai secret del repository).
 *
 * Un client OAuth di tipo desktop non può custodire un segreto — è esattamente la
 * ragione per cui esiste PKCE — quindi Google prevede che finisca dentro il binario.
 * Chi apre l'artefatto può comunque estrarlo: va bene per questa app perché il repo è
 * privato e la schermata di consenso è in modalità test con due soli utenti
 * autorizzati, ma resta un motivo per non rendere pubblici i pacchetti.
 *
 * Fuori dal bundle (test, script) l'identificatore non esiste: `typeof` su un nome non
 * dichiarato è lecito in JavaScript e vale 'undefined'.
 */
declare const __BAKED_GOOGLE_CREDENTIALS__: GoogleCredentials | null

export function bakedCredentials(): GoogleCredentials | null {
  if (typeof __BAKED_GOOGLE_CREDENTIALS__ === 'undefined') return null
  return __BAKED_GOOGLE_CREDENTIALS__
}

/**
 * Sceglie le credenziali fra le sorgenti disponibili, in ordine di precedenza:
 * variabili d'ambiente, poi i file `.env`, poi quelle cucite nel pacchetto.
 *
 * L'ordine conta: un pacchetto già distribuito deve poter essere puntato su
 * credenziali diverse senza ricompilarlo.
 */
export function resolveCredentials(sources: {
  env: Record<string, string | undefined>
  envFiles: Array<Record<string, string>>
  baked: GoogleCredentials | null
}): GoogleCredentials | null {
  let clientId = sources.env.GOOGLE_CLIENT_ID ?? ''
  let clientSecret = sources.env.GOOGLE_CLIENT_SECRET ?? ''

  for (const values of sources.envFiles) {
    if (clientId && clientSecret) break
    clientId = clientId || (values.GOOGLE_CLIENT_ID ?? '')
    clientSecret = clientSecret || (values.GOOGLE_CLIENT_SECRET ?? '')
  }

  if (!clientId && !clientSecret && sources.baked) return sources.baked
  clientId = clientId || (sources.baked?.clientId ?? '')
  clientSecret = clientSecret || (sources.baked?.clientSecret ?? '')

  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export function loadGoogleCredentials(): GoogleCredentials | null {
  const envFiles = envFileCandidates()
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => parseEnvFile(readFileSync(candidate, 'utf8')))

  return resolveCredentials({ env: process.env, envFiles, baked: bakedCredentials() })
}

/**
 * Motore di classificazione e di estrazione. `v2` è il percorso normale; `v1` resta
 * selezionabile come scappatoia, con il comportamento di prima.
 */
export type EngineVersion = 'v1' | 'v2'

export interface EngineSelection {
  classifier: EngineVersion
  extraction: EngineVersion
}

const ENGINE_VARIABLES = {
  classifier: 'CLASSIFIER_ENGINE',
  extraction: 'EXTRACTION_ENGINE'
} as const

/**
 * Un valore scritto male non ripiega in silenzio su un motore: chi imposta
 * `EXTRACTION_ENGINE=V1 ` per tornare indietro deve ottenere il v1, e chi scrive
 * `v3` deve saperlo all'avvio invece di scoprirlo dai campi.
 */
export function parseEngine(variable: string, value: string | undefined): EngineVersion {
  const normalized = value?.trim().toLowerCase() ?? ''
  if (normalized === '') return 'v2'
  if (normalized === 'v1' || normalized === 'v2') return normalized
  throw new Error(`${variable}=${value} non è valido: i valori ammessi sono v1 e v2.`)
}

/** Stessa precedenza delle credenziali: variabili d'ambiente, poi i file `.env` in ordine. */
export function resolveEngines(sources: {
  env: Record<string, string | undefined>
  envFiles: Array<Record<string, string>>
}): EngineSelection {
  const pick = (variable: string): string | undefined => {
    const fromEnv = sources.env[variable]
    if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
    return sources.envFiles.map((values) => values[variable]).find((value) => value?.trim())
  }
  return {
    classifier: parseEngine(ENGINE_VARIABLES.classifier, pick(ENGINE_VARIABLES.classifier)),
    extraction: parseEngine(ENGINE_VARIABLES.extraction, pick(ENGINE_VARIABLES.extraction))
  }
}

export function loadEngines(): EngineSelection {
  const envFiles = envFileCandidates()
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => parseEnvFile(readFileSync(candidate, 'utf8')))

  return resolveEngines({ env: process.env, envFiles })
}

export function setupHint(): string {
  const paths = envFileCandidates()
  return [
    'Credenziali Google non configurate.',
    paths.length > 0
      ? `Crea un file .env con GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET in: ${paths.join('  oppure  ')}`
      : 'Imposta GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.',
    'Le istruzioni per generarle sono nel README, sezione "Setup Google Cloud".'
  ].join(' ')
}
