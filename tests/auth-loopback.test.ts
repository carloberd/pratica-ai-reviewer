import { describe, expect, it } from 'vitest'
import { startLoopbackServer } from '../src/main/auth/loopback'

async function get(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url, { redirect: 'manual' })
  return { status: response.status, body: await response.text() }
}

describe('server di loopback per il redirect OAuth', () => {
  it('ascolta solo su 127.0.0.1 e su una porta effimera', async () => {
    const server = await startLoopbackServer('stato')
    expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    server.close()
  })

  it('restituisce il codice quando lo state combacia', async () => {
    const server = await startLoopbackServer('stato-atteso')
    const pending = server.waitForCode()
    const response = await get(`${server.redirectUri}?code=abc123&state=stato-atteso`)

    expect(response.status).toBe(200)
    expect(response.body).toContain('Accesso completato')
    await expect(pending).resolves.toBe('abc123')
    server.close()
  })

  it('rifiuta un redirect con lo state sbagliato', async () => {
    const server = await startLoopbackServer('stato-atteso')
    const pending = server.waitForCode()
    const response = await get(`${server.redirectUri}?code=abc123&state=altro`)

    expect(response.status).toBe(400)
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_FAILED' })
    server.close()
  })

  it('distingue il consenso negato dagli altri errori di Google', async () => {
    const denied = await startLoopbackServer('s')
    const deniedPending = denied.waitForCode()
    await get(`${denied.redirectUri}?error=access_denied&state=s`)
    await expect(deniedPending).rejects.toMatchObject({ code: 'AUTH_CANCELLED' })
    denied.close()

    const failed = await startLoopbackServer('s')
    const failedPending = failed.waitForCode()
    await get(`${failed.redirectUri}?error=server_error&state=s`)
    await expect(failedPending).rejects.toMatchObject({ code: 'AUTH_FAILED' })
    failed.close()
  })

  it('ignora qualunque percorso diverso da /callback', async () => {
    const server = await startLoopbackServer('s')
    const response = await get(server.redirectUri.replace('/callback', '/altro'))
    expect(response.status).toBe(404)
    server.close()
  })
})
