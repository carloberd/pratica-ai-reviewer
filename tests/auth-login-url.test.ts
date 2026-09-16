import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuthService, DRIVE_SCOPE } from '../src/main/auth/service'
import type { TokenStore } from '../src/main/auth/token-store'

/** Store finto: i test non toccano il portachiavi di sistema né il disco. */
function fakeStore(): TokenStore {
  let session: ReturnType<TokenStore['read']> = null
  return {
    file: '/dev/null',
    available: true,
    read: () => session,
    write: (value) => {
      session = value
    },
    clear: () => {
      session = null
    }
  }
}

const ORIGINAL = {
  id: process.env.GOOGLE_CLIENT_ID,
  secret: process.env.GOOGLE_CLIENT_SECRET
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = '123456789-test.apps.googleusercontent.com'
  process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-test'
})

afterEach(() => {
  if (ORIGINAL.id === undefined) delete process.env.GOOGLE_CLIENT_ID
  else process.env.GOOGLE_CLIENT_ID = ORIGINAL.id
  if (ORIGINAL.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET
  else process.env.GOOGLE_CLIENT_SECRET = ORIGINAL.secret
})

/**
 * Il consenso deve aprirsi nel browser di sistema: dentro una finestra dell'app Google
 * risponde «Questo browser o questa app potrebbero non essere sicuri» e il login non
 * si completa. Qui si verifica che l'URL passi davvero dal browser esterno, e con i
 * parametri giusti.
 */
describe('avvio del login', () => {
  async function capture(): Promise<URL> {
    let opened: string | null = null
    const auth = createAuthService(fakeStore(), {
      openExternal: async (url) => {
        opened = url
      },
      // Nessuno risponderà sul loopback: il login scade subito e il server si chiude.
      loginTimeoutMs: 150
    })

    await expect(auth.login()).rejects.toMatchObject({ code: 'AUTH_CANCELLED' })
    expect(opened).not.toBeNull()
    return new URL(opened!)
  }

  it('apre la pagina di consenso di Google nel browser di sistema', async () => {
    const url = await capture()
    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.pathname).toBe('/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(process.env.GOOGLE_CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
  })

  it('chiede il solo scope di lettura di Drive', async () => {
    const url = await capture()
    expect(url.searchParams.get('scope')).toBe(DRIVE_SCOPE)
  })

  it('usa PKCE con S256 e chiede il refresh token', async () => {
    const url = await capture()
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9\-._~]{43}$/)
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('state')).toBeTruthy()
  })

  it('rimanda al loopback su 127.0.0.1, su una porta effimera', async () => {
    const url = await capture()
    const redirect = url.searchParams.get('redirect_uri') ?? ''
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(Number(new URL(redirect).port)).toBeGreaterThan(1024)
  })

  it('senza credenziali non apre nulla e spiega cosa manca', async () => {
    delete process.env.GOOGLE_CLIENT_ID
    delete process.env.GOOGLE_CLIENT_SECRET
    let opened = false
    const auth = createAuthService(fakeStore(), {
      openExternal: async () => {
        opened = true
      }
    })

    await expect(auth.login()).rejects.toMatchObject({ code: 'AUTH_NOT_CONFIGURED' })
    expect(opened).toBe(false)
  })
})
