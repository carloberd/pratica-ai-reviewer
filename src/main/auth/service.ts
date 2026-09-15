import type { AuthStatus } from '@shared/types'
import { BrowserWindow } from 'electron'
import type { OAuth2Client } from 'google-auth-library'
import { google } from 'googleapis'
import { loadGoogleCredentials, setupHint } from '../config'
import { logError, ReviewerError } from '../errors'
import { startLoopbackServer } from './loopback'
import { createPkcePair, createState } from './pkce'
import { createTokenStore, type TokenStore } from './token-store'

/** D5: sola lettura. Nessuno scope di scrittura su Drive viene mai richiesto. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'

/**
 * Google rifiuta il flusso OAuth dentro uno "user agent incorporato". La finestra di
 * login si presenta quindi come un Chrome desktop: è una finestra dedicata, senza
 * preload e senza integrazione Node, che non condivide nulla con il renderer.
 */
const AUTH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export interface AuthService {
  status(): AuthStatus
  login(): Promise<AuthStatus>
  logout(): Promise<AuthStatus>
  /** Client autorizzato per le chiamate a Drive. Lancia `AUTH_REQUIRED` se non c'è sessione. */
  client(): Promise<OAuth2Client>
}

export function createAuthService(store: TokenStore = createTokenStore()): AuthService {
  let cachedClient: OAuth2Client | null = null
  let cachedEmail: string | null = null

  function credentialsOrThrow() {
    const credentials = loadGoogleCredentials()
    if (!credentials) throw new ReviewerError('AUTH_NOT_CONFIGURED', setupHint())
    return credentials
  }

  function newClient(redirectUri?: string): OAuth2Client {
    const { clientId, clientSecret } = credentialsOrThrow()
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri)
  }

  function status(): AuthStatus {
    const configured = loadGoogleCredentials() !== null
    if (!configured) {
      return { configured: false, signedIn: false, email: null, setupHint: setupHint() }
    }
    const session = store.read()
    return {
      configured: true,
      signedIn: session !== null,
      email: session?.email ?? cachedEmail
    }
  }

  async function fetchEmail(client: OAuth2Client): Promise<string | null> {
    try {
      // `about.get` rientra in drive.readonly: evita di chiedere anche lo scope
      // `userinfo.email` solo per mostrare l'account collegato.
      const drive = google.drive({ version: 'v3', auth: client })
      const about = await drive.about.get({ fields: 'user(emailAddress)' })
      return about.data.user?.emailAddress ?? null
    } catch (error) {
      logError('auth.email', error)
      return null
    }
  }

  return {
    status,

    async login(): Promise<AuthStatus> {
      credentialsOrThrow()

      const pkce = createPkcePair()
      const state = createState()
      const server = await startLoopbackServer(state)
      const client = newClient(server.redirectUri)

      const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        // Senza `consent` esplicito Google smette di restituire il refresh token
        // dopo la prima autorizzazione, e il riavvio perderebbe la sessione.
        prompt: 'consent',
        scope: [DRIVE_SCOPE],
        state,
        code_challenge_method: pkce.method as never,
        code_challenge: pkce.challenge
      })

      const window = new BrowserWindow({
        width: 520,
        height: 680,
        title: 'Accesso Google',
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          partition: 'persist:google-auth'
        }
      })

      let closedByUser = true
      try {
        await window.loadURL(authUrl, { userAgent: AUTH_USER_AGENT })

        const code = await Promise.race([
          server.waitForCode(),
          new Promise<never>((_resolve, reject) => {
            window.on('closed', () => {
              if (closedByUser) {
                reject(new ReviewerError('AUTH_CANCELLED', 'Accesso annullato.'))
              }
            })
          })
        ])

        const { tokens } = await client.getToken({
          code,
          redirect_uri: server.redirectUri,
          codeVerifier: pkce.verifier
        })

        if (!tokens.refresh_token) {
          throw new ReviewerError(
            'AUTH_FAILED',
            "Google non ha restituito un refresh token. Revoca l'accesso dell'app dal tuo account Google e riprova."
          )
        }

        client.setCredentials(tokens)
        const email = await fetchEmail(client)

        store.write({
          refreshToken: tokens.refresh_token,
          email,
          createdAt: new Date().toISOString()
        })
        cachedClient = client
        cachedEmail = email

        return status()
      } finally {
        closedByUser = false
        server.close()
        if (!window.isDestroyed()) window.close()
      }
    },

    async logout(): Promise<AuthStatus> {
      const session = store.read()
      if (session) {
        try {
          await newClient().revokeToken(session.refreshToken)
        } catch (error) {
          // Se la revoca remota fallisce la sessione locale va comunque cancellata.
          logError('auth.revoke', error)
        }
      }
      store.clear()
      cachedClient = null
      cachedEmail = null
      return status()
    },

    async client(): Promise<OAuth2Client> {
      if (cachedClient) return cachedClient

      const session = store.read()
      if (!session) {
        throw new ReviewerError('AUTH_REQUIRED', 'Accedi con il tuo account Google per continuare.')
      }

      const client = newClient()
      client.setCredentials({ refresh_token: session.refreshToken })

      // Google può ruotare il refresh token: va riscritto cifrato, non perso.
      client.on('tokens', (tokens) => {
        if (!tokens.refresh_token) return
        try {
          store.write({
            refreshToken: tokens.refresh_token,
            email: session.email,
            createdAt: session.createdAt
          })
        } catch (error) {
          logError('auth.rotate', error)
        }
      })

      try {
        await client.getAccessToken()
      } catch (error) {
        logError('auth.refresh', error)
        store.clear()
        throw new ReviewerError(
          'AUTH_REQUIRED',
          'La sessione Google è scaduta o è stata revocata. Accedi di nuovo.'
        )
      }

      cachedClient = client
      cachedEmail = session.email
      return client
    }
  }
}
