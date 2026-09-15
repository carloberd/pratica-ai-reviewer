import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ReviewerError } from '../errors'

export interface LoopbackServer {
  /** `http://127.0.0.1:<porta>/callback`, da passare a Google come redirect_uri. */
  redirectUri: string
  /** Risolve con il codice di autorizzazione, o rifiuta se Google restituisce un errore. */
  waitForCode(): Promise<string>
  close(): void
}

const SUCCESS_PAGE = `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>Accesso completato</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f6f8;color:#171a1f;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#fff;border:1px solid #e4e8eb;border-radius:14px;padding:28px 32px;text-align:center;max-width:420px}
h1{font-size:18px;margin:0 0 8px}p{color:#7d8991;font-size:13px;margin:0}</style></head>
<body><div class="card"><h1>Accesso completato</h1>
<p>Puoi chiudere questa finestra e tornare a PraticaAI Reviewer.</p></div></body></html>`

const FAILURE_PAGE = `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>Accesso non riuscito</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f6f8;color:#171a1f;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#fff;border:1px solid #efcac6;border-radius:14px;padding:28px 32px;text-align:center;max-width:420px}
h1{font-size:18px;margin:0 0 8px;color:#9a352f}p{color:#7d8991;font-size:13px;margin:0}</style></head>
<body><div class="card"><h1>Accesso non riuscito</h1>
<p>Torna a PraticaAI Reviewer e riprova.</p></div></body></html>`

/**
 * Mini server HTTP sul loopback che riceve il redirect di Google.
 *
 * Ascolta su una porta effimera di 127.0.0.1 (mai su 0.0.0.0) e accetta un solo
 * codice: quello con lo `state` atteso. Qualunque altra richiesta riceve 404.
 */
export async function startLoopbackServer(expectedState: string): Promise<LoopbackServer> {
  let resolveCode: (code: string) => void = () => {}
  let rejectCode: (error: Error) => void = () => {}
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // Se il login viene abbandonato prima che qualcuno attenda il codice, il rifiuto
  // resterebbe senza gestore e farebbe cadere il processo main.
  codePromise.catch(() => {})

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      response.writeHead(404).end()
      return
    }

    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')

    if (state !== expectedState) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAILURE_PAGE)
      rejectCode(new ReviewerError('AUTH_FAILED', 'Parametro state non valido: accesso annullato.'))
      return
    }
    if (error) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAILURE_PAGE)
      rejectCode(
        new ReviewerError(
          error === 'access_denied' ? 'AUTH_CANCELLED' : 'AUTH_FAILED',
          error === 'access_denied'
            ? "Accesso negato: l'autorizzazione non è stata concessa."
            : `Google ha rifiutato la richiesta di accesso (${error}).`
        )
      )
      return
    }
    if (!code) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAILURE_PAGE)
      rejectCode(new ReviewerError('AUTH_FAILED', 'Google non ha restituito il codice di accesso.'))
      return
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(SUCCESS_PAGE)
    resolveCode(code)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address() as AddressInfo | null
  if (!address) {
    server.close()
    throw new ReviewerError('AUTH_FAILED', 'Impossibile aprire la porta locale per il login.')
  }

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCode: () => codePromise,
    close: () => {
      server.close()
      server.closeAllConnections?.()
    }
  }
}
